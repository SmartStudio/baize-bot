import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  AccountListResponse,
  BotListResponse,
  ComputerListResponse,
  RoutineListResponse,
  type Platform,
} from "@baize/shared";
import { startFakePlatforms, type FakePlatforms } from "@baize/control-plane/testing";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";
import { fakeChrome } from "./fake-chrome.js";

const screenshots = fileURLToPath(new URL("./screenshots/", import.meta.url));
const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const viteBin = fileURLToPath(new URL("../../web/node_modules/vite/bin/vite.js", import.meta.url));
const check = expect.configure({ timeout: 30_000 });
const usage = { input: 1_200, output: 30 };

// 1x1 的 PNG。发布器在打开发布页那一步就因登录过期停下，图的内容不重要，只要是工作目录里的真文件。
const COVER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PROJECT_ASK = "推广白泽的开源仓库，年底 1000 星";
const PROJECT = "白泽开源推广";
const DOUYIN_ASK = "把抖音号做起来，年底 1000 粉";
const DOUYIN = "抖音号起步";
const XHS_ASK = "@阿文 写第一篇小红书，讲白泽是怎么来的，配上封面图";
const XHS_TITLE = "我们为什么做白泽";
const CADENCE_ASK = "下周多发点小红书";
const REPLY_ASK = "@小满 issue 12 里 lark-fan 问能不能接飞书，回他一句";
const REVIEW_ASK = "周五复盘加上小红书的数据";
const ISSUE_URL = "https://github.com/baize/baize-bot/issues/12";
const ROUTINE_ASK = "每周五六点给白泽开源推广出一份周报";
const ROUTINE_NAME = "白泽开源推广周报";
const ROUTINE_INSTRUCTION = "汇总白泽开源推广这一周各平台发了什么、阅读和互动多少，写成一份周报";
const TEAM_ASK = "白泽开源推广想加一个排版的";
const HELPER_TASK = "查一下小红书图文排版常见的做法，列三条";
const LAYOUT_ASK = "@小墨 给第一篇小红书排个版";
const TEACH_ASK = "标题别超过 15 个字";
const PREFERENCE = "小红书标题都在 15 个字以内";
const TITLE_ASK = "给周四那篇起个标题";
const TITLE_AGAIN_ASK = "再起一个标题";
const WRITER_DESCRIPTION = "写小红书图文和长文，只起草不直接发";

// 剧本要用的 id 跑起来才知道，各段拿到后填进来。
const ids: { project: string; accounts: Partial<Record<Platform, string>> } = { project: "", accounts: {} };

const accountOf = (platform: Platform): string => {
  const id = ids.accounts[platform];
  if (id === undefined) throw new Error(`剧本要用 ${platform} 账号，但还没连上`);
  return id;
};

// 下周第 day 天（0 是周一）北京时间 hour 点。排在下周，publishTick 不会把它们当到点的发出去。
const nextWeek = (day: number, hour: number): string => {
  const beijing = new Date(Date.now() + 8 * 3_600_000);
  const untilMonday = (8 - beijing.getUTCDay()) % 7 || 7;
  return new Date(
    Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + untilMonday + day, hour - 8),
  ).toISOString();
};

const call = (id: string, name: string, args: Record<string, unknown>): ScriptedTurn => ({
  textChunks: [],
  toolCall: { id, name, args },
  usage,
});
const say = (...textChunks: string[]): ScriptedTurn => ({ textChunks, usage });

const turn = (request: ChatRequest): ScriptedTurn => {
  const lastUser = request.messages.findLastIndex((message) => message.role === "user");
  const content = request.messages[lastUser]?.content;
  const prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const current = prompt.split("当前这条：").at(-1) ?? prompt;
  const afterTool = request.messages.slice(lastUser + 1).some((message) => message.role === "tool");

  if (current.includes(PROJECT_ASK)) {
    return afterTool
      ? say("方案卡发好了，你看一眼，没问题就点开始。")
      : call("offer-oss", "propose_project", {
          name: PROJECT,
          goal: "白泽开源仓库年底到 1000 星",
          team: [
            { name: "阿文", tags: ["小红书"], description: "写小红书图文，只起草不直接发" },
            { name: "小满", tags: ["社区"], description: "回 GitHub 和 X 上的评论，回复先给你看" },
            { name: "老周", tags: ["GitHub"], description: "写 GitHub 讨论和 X 推文，不改代码" },
          ],
          platforms: [
            { kind: "supported", platform: "github" },
            { kind: "supported", platform: "x" },
            { kind: "supported", platform: "xiaohongshu" },
          ],
          cadence: "每周 2 篇小红书、3 条 X、1 篇 GitHub 讨论",
          firstStep: "阿文先写第一篇小红书，讲白泽是怎么来的",
        });
  }
  if (current.includes(XHS_ASK)) {
    return afterTool
      ? say("第一篇小红书写好了，在等你批。")
      : call("xhs-first", "create_draft", {
          accountId: accountOf("xiaohongshu"),
          content: {
            kind: "post",
            title: XHS_TITLE,
            text: "一个人的公司，也想有一支队伍。白泽把写稿、回评论、排计划交给几个 AI 队友，你只管点头。",
            images: [{ path: "cover.png" }],
          },
        });
  }
  if (current.includes("排这个项目本周的计划")) {
    return afterTool
      ? say("本周计划排好了，5 条，等你确认。")
      : call("plan-week", "propose_plan", {
          title: "本周推广计划",
          drafts: [
            {
              accountId: accountOf("x"),
              content: { kind: "post", text: "白泽开源了：一个人也能带一支 AI 小队做推广。github.com/baize/baize-bot" },
              scheduledAt: nextWeek(0, 10),
            },
            {
              accountId: accountOf("xiaohongshu"),
              content: {
                kind: "post",
                title: "我用 5 个 AI 做推广",
                text: "我用 5 个 AI 做推广，一周省下 10 个小时。它们各管一摊：写稿、回评论、排计划。",
                images: [{ path: "cover.png" }],
              },
              scheduledAt: nextWeek(1, 12),
            },
            {
              accountId: accountOf("github"),
              content: {
                kind: "post",
                title: "白泽 v0.2 想听听你的用法",
                text: "我们在收集大家用白泽做推广的方式，欢迎在这里留言。",
                github: { repo: "baize/baize-bot", as: "discussion" },
              },
              scheduledAt: nextWeek(2, 10),
            },
            {
              accountId: accountOf("x"),
              content: { kind: "post", text: "本周白泽新增：计划卡一次批完，改过的地方记进品牌手册。" },
              scheduledAt: nextWeek(3, 10),
            },
            {
              accountId: accountOf("xiaohongshu"),
              content: {
                kind: "post",
                title: "AI 队友怎么分工",
                text: "写稿的、回评论的、排计划的，各自有边界，越界的事先问你。",
                images: [{ path: "cover.png" }],
              },
              scheduledAt: nextWeek(3, 20),
            },
          ],
        });
  }
  if (current.includes(CADENCE_ASK)) {
    return afterTool
      ? say("好，下周小红书从 2 篇加到 3 篇，周一的计划里给你看。")
      : call("cadence-xhs", "set_cadence", {
          projectGroupId: ids.project,
          cadence: "每周 3 篇小红书、3 条 X、1 篇 GitHub 讨论",
        });
  }
  if (current.includes(REPLY_ASK)) {
    return afterTool
      ? say("回复写好了，等你批。")
      : call("reply-lark", "create_draft", {
          accountId: accountOf("github"),
          content: {
            kind: "reply",
            text: "可以的，飞书的接入在路线图上，下个版本先支持消息推送，进展会在这个 issue 里同步。",
            replyTo: { url: ISSUE_URL, author: "lark-fan", quote: "这个能接飞书吗" },
          },
        });
  }
  if (current.includes(DOUYIN_ASK)) {
    return afterTool
      ? say("方案卡发好了。抖音现在还不支持自动发，先把队伍和节奏定下来。")
      : call("offer-douyin", "propose_project", {
          name: DOUYIN,
          goal: "抖音号年底到 1000 粉",
          team: [{ name: "阿影", tags: ["短视频"], description: "写短视频脚本和标题，不剪片子不发视频" }],
          platforms: [{ kind: "unsupported", name: "抖音" }],
          cadence: "每周 3 条短视频脚本",
          firstStep: "阿影先写 3 条短视频脚本给你挑",
        });
  }
  if (current.includes(REVIEW_ASK)) {
    return say("记下了，这周五的复盘会把小红书的阅读和收藏一起列出来。");
  }
  if (current.includes(ROUTINE_ASK)) {
    return afterTool
      ? say("例行卡发好了，在等你确认里，点「加上」就每周五 18:00 出周报。")
      : call("routine-weekly", "propose_routine", {
          name: ROUTINE_NAME,
          instruction: ROUTINE_INSTRUCTION,
          cron: "0 18 * * 5",
          boundary: "read_only",
          projectGroupId: ids.project,
        });
  }
  if (current.includes(ROUTINE_INSTRUCTION)) {
    return say("本周周报：小红书发了 2 篇，GitHub 回了 1 条评论，X 发了 3 条。详细数字等下周对比。");
  }
  if (current.includes(HELPER_TASK)) {
    return say("小红书图文排版常见三条：封面大字标题，正文分段加小标题，每段不超过 4 行。");
  }
  if (current.includes(TEAM_ASK)) {
    const tools = request.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
    if (tools === 0) return call("helper-layout", "call_helper", { kind: "researcher", task: HELPER_TASK });
    if (tools === 1) {
      return call("team-layout", "propose_team", {
        projectGroupId: ids.project,
        members: [
          {
            kind: "new",
            name: "小墨",
            tags: ["排版"],
            description: "给小红书图文排版、做封面，不写正文不发布",
            note: "阿文写完的稿子现在要你自己排版，小墨接过来你就只用批",
          },
          {
            kind: "new",
            name: "阿彩",
            tags: ["配图"],
            description: "给小红书图文配插图，不写正文不发布",
            note: "先不带：现在一周 3 篇，封面图阿文自己配得过来，发得多了再请",
            suggested: true,
          },
        ],
      });
    }
    return say("建队卡发好了，想给白泽开源推广加一个排版，你挑一下。");
  }
  if (current.includes(LAYOUT_ASK)) {
    return say("排好了：封面大字标题，正文分三段，每段加一个小标题。");
  }
  if (current.includes(TEACH_ASK)) {
    return afterTool
      ? say(`记下了，以后${PREFERENCE}`)
      : call("remember-title", "remember_preference", { text: PREFERENCE, private: false });
  }
  if (current.includes(TITLE_ASK)) return say("「一个人带一支 AI 小队」");
  if (current.includes(TITLE_AGAIN_ASK)) return say("「白泽：一个人的公司也能有队伍」");
  throw new Error(`假上游没有这条请求的剧本：${prompt.slice(-200)}`);
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("没拿到 Vite 端口"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

const startWeb = async (apiPort: number): Promise<{ url: string; child: ChildProcess }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [viteBin], {
    cwd: webDir,
    env: { ...process.env, API_PORT: String(apiPort), WEB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Vite 提前退出：${output}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return { url, child };
      } catch {
        await delay(100);
      }
    }
    throw new Error(`等不到 Vite：${output}`);
  } catch (error) {
    await stopWeb(child);
    throw error;
  }
};

const stopWeb = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
  process.stdout.write(`  截图 ${name}.png\n`);
};

// P1-7：首页只说人话。运行编号、模型名、任务卡编号是给开发看的，出现在首页就是漏了。
const assertPlainHome = async (page: Page, stack: Stack): Promise<void> => {
  const text = await page.locator("body").innerText();
  const runs = await stack.sql<{ id: string }[]>`SELECT id::text AS id FROM runs`;
  for (const { id } of runs) check(text.includes(id), `首页不露 runId ${id}`).toBe(false);
  check(text, "首页不露模型名").not.toMatch(/e2e-(plan|fast)-model|baize:(plan|fast)/);
  check(text, "首页不露 T- 编号").not.toMatch(/T-\d{4}/);
};

// 代替系统通知中心：Web 发的原生通知记在页面里，验收读出来看。
const RECORD_NOTICES = `
  window.__notices = [];
  window.Notification = class {
    static permission = "granted";
    static requestPermission() { return Promise.resolve("granted"); }
    constructor(title, options) { window.__notices.push({ title, body: (options && options.body) || "" }); }
  };
`;

const notices = async (page: Page): Promise<string> => JSON.stringify(await page.evaluate("window.__notices"));

const openHome = async (page: Page, web: string): Promise<void> => {
  await page.goto(web);
  await check(page.getByTestId("today-page")).toBeVisible();
  await check(page.locator(".today-loading")).toHaveCount(0);
};

const openSettings = async (page: Page, section: string): Promise<void> => {
  await page.getByTestId("account-button").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId(`settings-nav-${section}`).click();
};

const loginCard = (page: Page, accountId: string) =>
  page.locator(`[data-testid=today-row][data-kind=login][data-account-id="${accountId}"]`);

const pendingRow = (page: Page, kind: "plan" | "draft", text: string) =>
  page.locator(`[data-testid=today-row][data-kind=${kind}]`).filter({ hasText: text });

const waitFor = async (what: string, probe: () => Promise<boolean> | boolean): Promise<void> => {
  await check.poll(probe, { message: what }).toBe(true);
};

const botId = async (stack: Stack, name: string): Promise<string> => {
  const bot = BotListResponse.parse(await stack.get("/api/bots")).items.find((item) => item.bot.name === name);
  if (bot === undefined) throw new Error(`没有叫「${name}」的 Bot`);
  return bot.bot.id;
};

const putCover = async (stack: Stack, name: string): Promise<void> => {
  const work = join(stack.dataDir, await botId(stack, name), "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "cover.png"), COVER);
};

const draftStatus = async (stack: Stack, title: string): Promise<string | undefined> => {
  const rows = await stack.sql<{ status: string }[]>`
    SELECT status FROM drafts WHERE content->>'title' = ${title}`;
  return rows[0]?.status;
};

const openProject = async (page: Page, title: string): Promise<void> => {
  await page.locator(`[data-testid=group-item][data-group-title="${title}"]`).click();
  await check(page.getByTestId("project-page")).toBeVisible();
};

const finishedRuns = async (stack: Stack, routineId: string): Promise<number> => {
  const rows = await stack.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM routine_runs WHERE routine_id = ${routineId} AND status <> 'running'`;
  return rows[0]?.n ?? 0;
};

const routineState = async (stack: Stack, routineId: string): Promise<string | undefined> => {
  const rows = await stack.sql<{ state: string }[]>`SELECT state FROM routines WHERE id = ${routineId}`;
  return rows[0]?.state;
};

const lastUserText = (request: ChatRequest): string => {
  const content = request.messages.findLast((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};

/** 偏好放在系统提示的记忆段里，不进会话历史，所以只看 system 那几条。 */
const systemPromptFor = (requests: readonly ChatRequest[], ask: string): string => {
  const request = requests.findLast((candidate) => lastUserText(candidate).includes(ask));
  if (request === undefined) throw new Error(`假上游没收到「${ask}」这一句的请求`);
  return JSON.stringify(
    request.messages.filter((message) => message.role === "system" || message.role === "developer"),
  );
};

const sendInChat = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
};

const skip = (why: string): void => {
  process.stdout.write(`  跳过：${why}\n`);
};

const run = async (): Promise<void> => {
  rmSync(screenshots, { recursive: true, force: true });
  mkdirSync(screenshots, { recursive: true });
  const upstream = await startUpstream(turn);
  const chrome = fakeChrome();
  let platforms: FakePlatforms | undefined;
  let stack: Stack | undefined;
  let web: { url: string; child: ChildProcess } | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let step = "启动";
  const begin = (name: string): void => {
    step = name;
    process.stdout.write(`${name}\n`);
  };
  try {
    platforms = await startFakePlatforms();
    const fake = platforms;

    begin("U1 注册，装好白泽，首页什么都不用填");
    stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 300,
      priceOutputPerM: 1_500,
      githubApiBaseUrl: fake.githubBaseUrl,
      xApiBaseUrl: fake.xBaseUrl,
      makeChrome: chrome.factory,
      startComputer: false,
      bootstrap: async (port) => {
        const started = await startWeb(port);
        web = started;
        browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
        const opened = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
        context = opened;
        await opened.addInitScript({ content: RECORD_NOTICES });
        const first = await opened.newPage();
        page = first;
        await first.goto(`${started.url}/register`);
        await first.getByTestId("register-email").fill("chen@baize-acceptance.example");
        await first.getByTestId("register-password").fill("acceptance-pass");
        await first.getByTestId("register-name").fill("陈");
        await shot(first, "U1-1-register");
        await first.getByTestId("register-submit").click();
        await check(first.getByTestId("today-page")).toBeVisible();
        const cookies = await opened.cookies(started.url);
        check(cookies.length, "注册后浏览器拿到登录 cookie").toBeGreaterThan(0);
        return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      },
    });
    if (web === undefined || page === undefined || context === undefined) throw new Error("注册阶段没把页面起来");
    const s = stack;
    const p: Page = page;
    const ctx: BrowserContext = context;
    const home = (web as { url: string }).url;
    // 账号页授权 GitHub 和 X 要跳真平台，这里直接把假平台的令牌挂上，等同授权完回来。代理起来前挂，hello 的 config 就带上。
    ids.accounts.github = (await s.addAccount({ platform: "github", handle: fake.handles.github, token: "gh-e2e" })).id;
    ids.accounts.x = (await s.addAccount({ platform: "x", handle: fake.handles.x, token: "x-e2e" })).id;
    await s.startComputer();
    await openHome(p, home);
    await check(p.getByTestId("today-assistant-text")).toContainText("想让我帮你做成什么事");
    await check(p.locator(".today-template")).toHaveText(["推广一个产品", "运营一个号"]);
    const firstHome = await p.locator("body").innerText();
    for (const word of ["企业", "团队结算", "同事"]) check(firstHome, `首页不出现「${word}」`).not.toContain(word);
    await assertPlainHome(p, s);
    await shot(p, "U1-2-today");
    await openSettings(p, "computer");
    await check(p.getByTestId("computer-status")).toHaveAttribute("data-status", "online");
    await shot(p, "U1-3-computer");
    await p.getByTestId("settings-close").click();
    skip("首页的「和 AI 打一局」模板（第 3 期）");

    begin("U2 一句话开项目，点开始");
    await p.getByTestId("new-project").click();
    await p.getByTestId("new-project-input").fill(PROJECT_ASK);
    await p.getByTestId("new-project-submit").click();
    const offer = p.getByTestId("project-offer").filter({ hasText: PROJECT });
    await check(offer).toHaveAttribute("data-status", "offered");
    await check(offer.getByTestId("project-offer-member")).toHaveCount(3);
    await check(offer.getByTestId("project-offer-platform")).toHaveCount(3);
    await shot(p, "U2-1-offer");
    await offer.getByTestId("project-offer-start").click();
    await check(p.getByTestId("project-page")).toBeVisible();
    const projectMatch = /\/p\/([^/?#]+)/.exec(p.url());
    if (projectMatch?.[1] === undefined) throw new Error(`点开始后没进项目页：${p.url()}`);
    ids.project = projectMatch[1];
    await check(p.getByTestId("project-cadence")).toContainText("每周 2 篇小红书");
    await shot(p, "U2-2-project");

    begin("U3 给它开一个小红书号：账号页主动接入，扫码后多一行已登录");
    const computerId = ComputerListResponse.parse(await s.get("/api/computers")).computers[0]?.id;
    if (computerId === undefined) throw new Error("没有本机");
    const before = AccountListResponse.parse(await s.get("/api/accounts")).accounts;
    check(
      before.some((account) => account.platform === "xiaohongshu"),
      "点开始不会替用户建小红书占位",
    ).toBe(false);
    const configsBefore = s.configsApplied();
    await openSettings(p, "accounts");
    await p.locator("[data-testid=account-connect-browser][data-platform=xiaohongshu]").click();
    const xhsRow = p.getByTestId("account-row").filter({ hasText: "小红书" });
    await check(xhsRow).toHaveAttribute("data-login", "none");
    await check(xhsRow.getByTestId("login-open"), "接入一点就开登录窗口").toHaveText("等你扫码…");
    await check(xhsRow.getByTestId("login-card-note")).toHaveText("登录窗口已在本机打开，扫码后这里会变成已登录。");
    await waitFor("电脑上开出了登录窗口", () => chrome.waitingLogins() === 1);
    const placeholder = AccountListResponse.parse(await s.get("/api/accounts")).accounts.find(
      (account) => account.platform === "xiaohongshu",
    );
    if (placeholder === undefined) throw new Error("点接入小红书之后控制面没有这个号");
    check(placeholder.computerId, "小红书号挂在本机").toBe(computerId);
    ids.accounts.xiaohongshu = placeholder.id;
    await waitFor("加了小红书之后电脑收到新 config", () => s.configsApplied() > configsBefore);
    await shot(p, "U3-1-connect");
    chrome.scan("白泽工厂日记");
    await check(xhsRow).toHaveAttribute("data-login", "valid");
    await check(xhsRow).toContainText("小红书 · 白泽工厂日记");
    await check(xhsRow.getByTestId("account-tier"), "权限默认发布要确认").toHaveText("发布要确认");
    await check(xhsRow.getByTestId("login-open"), "登上之后行上不再有登录按钮").toHaveCount(0);
    await shot(p, "U3-2-accounts");
    await p.getByTestId("settings-close").click();
    await putCover(s, "阿文");
    await p.getByTestId("project-composer-input").fill(XHS_ASK);
    await p.getByTestId("project-composer-send").click();
    await waitFor("阿文起好了草稿", async () => (await draftStatus(s, XHS_TITLE)) === "pending");
    await openHome(p, home);
    await check(pendingRow(p, "draft", XHS_TITLE)).toBeVisible();
    await check(loginCard(p, placeholder.id), "号已经登上，第一篇稿子不再要登录卡").toHaveCount(0);
    await assertPlainHome(p, s);
    await shot(p, "U3-3-first-draft");
    skip("登录后 Bot 发一条测试请求确认能用（假浏览器给不出真登录态）");

    begin("U4 周一早上的计划：菜单栏看数，首页改一条，批准");
    await putCover(s, "主助理");
    const monday = RoutineListResponse.parse(await s.get("/api/routines")).items.find(
      (item) => item.name === "周一 09:00 排本周计划" && item.groupId === ids.project,
    );
    if (monday === undefined) throw new Error("点开始后没有周一计划的例行");
    await s.post(`/api/routines/${monday.id}/run`, {});
    await waitFor("主助理排出计划", async () => {
      const rows = await s.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM content_plans`;
      return (rows[0]?.n ?? 0) > 0;
    });
    await openHome(p, home);
    const planRow = pendingRow(p, "plan", "本周推广计划");
    await check(planRow).toBeVisible();
    const menubar = await ctx.newPage();
    await menubar.setViewportSize({ width: 380, height: 560 });
    await menubar.goto(`${home}/menubar`);
    await check(menubar.getByTestId("menubar-page")).toContainText("件等你");
    const pendingBefore = Number(await menubar.locator(".menubar-count").textContent());
    await assertPlainHome(menubar, s);
    await shot(menubar, "U4-1-menubar");
    await planRow.getByTestId("today-expand").click();
    const plan = planRow.getByTestId("plan-card");
    await check(plan.getByTestId("plan-draft")).toHaveCount(5);
    await plan.getByTestId("plan-draft-toggle").nth(1).click();
    const editor = plan.getByTestId("draft-editor");
    await editor.fill((await editor.inputValue()).replaceAll("5 个 AI", "一支 AI 小队"));
    await check(plan.getByTestId("brand-hint")).toBeVisible();
    await check(plan.getByTestId("plan-approve")).toHaveText("批准 5 条（改了 1 条）");
    await assertPlainHome(p, s);
    await shot(p, "U4-2-plan-edit");
    await plan.getByTestId("plan-approve").click();
    await check(pendingRow(p, "plan", "本周推广计划")).toHaveCount(0);
    await menubar.reload();
    await check(menubar.locator(".menubar-count")).toHaveText(String(pendingBefore - 1));
    await assertPlainHome(menubar, s);
    await shot(menubar, "U4-3-menubar-after");
    await menubar.close();
    const edited = await s.sql<{ text: string }[]>`
      SELECT content->>'text' AS text FROM drafts WHERE content->>'title' = '我用 5 个 AI 做推广'`;
    check(edited[0]?.text, "改过的那条照改后的文字批").toContain("一支 AI 小队");
    skip("品牌手册积累、下次照着写（第 2 期）");

    begin("U5 随口一句改节奏");
    await openHome(p, home);
    const pendingCount = p.getByTestId("today-pending").getByTestId("today-section-count");
    const countBefore = (await pendingCount.textContent()) ?? "";
    await p.getByTestId("today-composer-input").fill(CADENCE_ASK);
    await p.getByTestId("today-composer-send").click();
    await check(p.getByTestId("today-assistant-text")).toContainText("周一的计划里给你看");
    await check(pendingCount, "改节奏不多出要确认的事").toHaveText(countBefore);
    const cadence = await s.sql<{ cadence: string }[]>`SELECT cadence FROM tasks WHERE group_id = ${ids.project}`;
    check(cadence[0]?.cadence, "节奏落到项目的任务卡上").toContain("每周 3 篇小红书");
    await assertPlainHome(p, s);
    await shot(p, "U5-1-cadence");

    begin("U6 回评论：草稿卡带原话，批了发出去，刚做完多一条带链接");
    await openProject(p, PROJECT);
    await p.getByTestId("project-composer-input").fill(REPLY_ASK);
    await p.getByTestId("project-composer-send").click();
    await waitFor("小满起好了回复", async () => {
      const rows = await s.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drafts WHERE content->>'kind' = 'reply' AND status = 'pending'`;
      return (rows[0]?.n ?? 0) === 1;
    });
    await openHome(p, home);
    const replyRow = pendingRow(p, "draft", "飞书");
    await replyRow.getByTestId("today-expand").click();
    await check(replyRow.getByTestId("draft-quote")).toContainText("这个能接飞书吗");
    await assertPlainHome(p, s);
    await shot(p, "U6-1-reply-draft");
    await replyRow.getByTestId("draft-approve").click();
    await check(replyRow).toHaveCount(0);
    await s.publishTick();
    check(
      fake.requests().some((request) => request.method === "POST" && request.path.includes("/issues/12/comments")),
      "假 GitHub 收到 issue 12 的评论",
    ).toBe(true);
    await openHome(p, home);
    const published = p.getByTestId("today-done").locator("a.today-row");
    await check(published).toHaveCount(1);
    await check(published).toContainText("GitHub · 已发布");
    await assertPlainHome(p, s);
    await shot(p, "U6-2-done");
    skip("小红书评论回复（本机发布器只接了发帖），评论平台换成 GitHub");

    begin("U7 登录过期：发不出去，首页出登录卡并通知，当场扫码，排着的稿子照常");
    const xhsDraft = pendingRow(p, "draft", XHS_TITLE);
    await xhsDraft.getByTestId("today-expand").click();
    await xhsDraft.getByTestId("draft-approve").click();
    await check(xhsDraft).toHaveCount(0);
    await s.publishTick();
    await waitFor("小红书那条发失败", async () => (await draftStatus(s, XHS_TITLE)) === "failed");
    const failure = await s.sql<{ failure: string | null; login: string }[]>`
      SELECT d.failure, a.login FROM drafts d JOIN accounts a ON a.id = d.account_id
      WHERE d.content->>'title' = ${XHS_TITLE}`;
    check(failure[0], "发布器认出登录过期，账号跟着变过期").toEqual({ failure: "login_expired", login: "expired" });
    // 等着发的只剩计划里批过的稿子，过期号照样换成能当场扫码的登录卡，不再是一行只能点去账号页的提示。
    const expiredCard = loginCard(p, accountOf("xiaohongshu"));
    await check(expiredCard).toHaveAttribute("data-state", "needed");
    await check(expiredCard.getByTestId("login-card-title")).toHaveText("小红书 · 白泽工厂日记 登录过期了");
    await check(expiredCard.getByTestId("login-open")).toHaveText("打开登录窗口");
    await check(p.locator("[data-testid=today-row][data-kind=account]")).toHaveCount(0);
    await waitFor("系统通知说登录过期了", async () => (await notices(p)).includes("登录过期"));
    const planned = await s.sql<{ status: string }[]>`SELECT status FROM drafts WHERE plan_id IS NOT NULL`;
    check(
      planned.map((row) => row.status),
      "过期只卡住发不出去的那条，计划里其余的稿子照常等排期",
    ).toEqual(["approved", "approved", "approved", "approved", "approved"]);
    await assertPlainHome(p, s);
    await shot(p, "U7-1-expired");
    await openSettings(p, "accounts");
    const expiredAccount = p.getByTestId("account-row").filter({ hasText: "白泽工厂日记" });
    await check(expiredAccount).toHaveAttribute("data-login", "expired");
    await check(expiredAccount.getByTestId("login-open"), "账号页的行上也能重新登录").toHaveText("打开登录窗口");
    await shot(p, "U7-2-accounts-expired");
    await p.getByTestId("settings-close").click();
    await expiredCard.getByTestId("login-open").click();
    await check(expiredCard).toHaveAttribute("data-state", "opening");
    await waitFor("电脑上开出了登录窗口", () => chrome.waitingLogins() === 1);
    await assertPlainHome(p, s);
    await shot(p, "U7-3-waiting-scan");
    chrome.scan("白泽工厂日记");
    await check(expiredCard, "扫码后卡片变成已登录").toHaveAttribute("data-state", "signed_in");
    await check(expiredCard.getByTestId("login-card-title")).toContainText("白泽工厂日记 已登录");
    await check(
      p.getByTestId("today-pending").getByTestId("today-section-count"),
      "登上之后等你确认不再计这件事，已登录的卡只是回执",
    ).toHaveCount(0);
    await check(p.getByTestId("today-page").locator(".today-greeting p")).toHaveText(
      "没有要你处理的事，其余在按计划跑。",
    );
    await check(expiredCard, "服务端那行重拉后没了，已登录的卡还在").toHaveAttribute("data-state", "signed_in");
    const relogged = await s.sql<
      { login: string }[]
    >`SELECT login FROM accounts WHERE id = ${accountOf("xiaohongshu")}`;
    check(relogged[0]?.login, "账号回到已登录").toBe("valid");
    const stillPlanned = await s.sql<{ status: string }[]>`SELECT status FROM drafts WHERE plan_id IS NOT NULL`;
    check(
      stillPlanned.map((row) => row.status),
      "重新登录后计划里的稿子照常排着",
    ).toEqual(["approved", "approved", "approved", "approved", "approved"]);
    await check(p.getByTestId("today-next"), "周四那条小红书照常排着").toContainText("AI 队友怎么分工");
    await assertPlainHome(p, s);
    await shot(p, "U7-4-signed-in");
    process.stdout.write(`  假 Chrome 收到的 CDP：${chrome.cdpCalls().join(" ")}\n`);

    begin("U8 第二个项目：抖音暂不支持");
    await p.getByTestId("new-project").click();
    await p.getByTestId("new-project-input").fill(DOUYIN_ASK);
    await p.getByTestId("new-project-submit").click();
    const douyin = p.getByTestId("project-offer").filter({ hasText: DOUYIN });
    await check(douyin).toHaveAttribute("data-status", "offered");
    await check(douyin.locator("[data-testid=project-offer-platform][data-supported=false]")).toContainText(
      "抖音暂不支持",
    );
    await shot(p, "U8-1-offer");
    await douyin.getByTestId("project-offer-start").click();
    await check(p.getByTestId("project-page")).toBeVisible();
    await check(p.getByTestId("project-cadence")).toContainText("每周 3 条短视频脚本");
    await shot(p, "U8-2-project");

    begin("U9 项目页：最新一轮贴着输入框，成果在下面");
    await openProject(p, PROJECT);
    await p.getByTestId("project-composer-input").fill(REVIEW_ASK);
    await p.getByTestId("project-composer-send").click();
    await check(p.getByTestId("project-latest-turn")).toContainText("小红书的阅读和收藏");
    await check(p.getByTestId("project-achievements")).toContainText("GitHub");
    await shot(p, "U9-1-project");
    await p.getByTestId("project-achievements").scrollIntoViewIfNeeded();
    await shot(p, "U9-2-achievements");
    skip("目标与指标、数字变化（第 2 期）");

    begin("U10 例行自己会停：一句话加一次「加上」，三次没人看自己停，侧栏亮点，点恢复");
    skip("在项目里说：例行卡只在主助理单聊里出，项目群里调会报错让 Bot 转告，这句改在首页对主助理说");
    await openHome(p, home);
    await p.getByTestId("today-composer-input").fill(ROUTINE_ASK);
    await p.getByTestId("today-composer-send").click();
    await check(p.getByTestId("today-assistant-text")).toContainText("例行卡发好了");
    const routineOffer = p.locator("[data-testid=today-row][data-kind=routine_offer]").getByTestId("routine-offer");
    await check(routineOffer).toHaveAttribute("data-status", "offered");
    await check(routineOffer.getByTestId("routine-offer-when"), "卡上写清什么时候").toHaveText("每周五 18:00");
    await check(routineOffer.getByTestId("routine-offer-where"), "卡上写清哪个项目").toContainText(PROJECT);
    await check(routineOffer.getByTestId("routine-offer-executor"), "卡上写清谁来做").toHaveText("主助理");
    await check(routineOffer.getByTestId("routine-offer-boundary"), "卡上写清边界").toHaveText("只读，不发东西");
    await check(routineOffer, "建例行不用填表").not.toContainText("cron");
    await check(routineOffer, "用户自己开口要的例行，卡上不说成主助理看他常这么做").not.toContainText("常这么做");
    await assertPlainHome(p, s);
    await shot(p, "U10-1-offer");
    await routineOffer.getByTestId("routine-offer-add").click();
    await check(routineOffer).toHaveAttribute("data-status", "added");
    const weekly = RoutineListResponse.parse(await s.get("/api/routines")).items.find(
      (item) => item.name === ROUTINE_NAME,
    );
    if (weekly === undefined) throw new Error("点了加上没有建出例行");
    check(weekly.groupId, "例行挂在项目上").toBe(ids.project);
    check(weekly.boundary, "边界照卡上的只读").toBe("read_only");
    await p.getByTestId("routines-nav").click();
    const projectSection = p.locator(`[data-testid=routine-section][data-section-title="${PROJECT}"]`);
    const weeklyRow = projectSection.locator(`[data-testid=routine-row][data-routine-name="${ROUTINE_NAME}"]`);
    await check(weeklyRow, "例行页按项目分组，周报在项目那组").toHaveAttribute("data-state", "on");
    await check(weeklyRow.getByTestId("routine-run"), "在跑的能立即跑一次").toBeVisible();
    await check(weeklyRow.getByTestId("routine-toggle"), "在跑的能暂停").toHaveText("暂停");
    await check(weeklyRow.getByTestId("routine-edit"), "每条能改").toBeVisible();
    await check(p.getByTestId("routines-alert")).toHaveCount(0);
    await shot(p, "U10-2-routines");
    // 几周过去：例行到点跑了三次，用户一次也没打开项目看结果。人停在例行页上，不算看过。
    for (let week = 1; week <= 3; week += 1) {
      await s.post(`/api/routines/${weekly.id}/run`, {});
      await waitFor(`第 ${week} 次周报跑完`, async () => (await finishedRuns(s, weekly.id)) === week);
    }
    await waitFor("连续三次没人看，周报自己停了", async () => (await routineState(s, weekly.id)) === "auto_paused");
    await check(p.getByTestId("routines-alert"), "侧栏「例行」旁边亮一个点").toBeVisible();
    await check(p.getByTestId("routine-stopped")).toContainText(`「${ROUTINE_NAME}」连续 3 次没人看，自己停了。`);
    await check(weeklyRow).toHaveAttribute("data-state", "auto_paused");
    await check(weeklyRow.getByTestId("routine-state"), "自己停和手动停分开显示").toHaveText("自己停了");
    await check(weeklyRow.getByTestId("routine-run-count")).toHaveText("跑过 3 次");
    await shot(p, "U10-3-auto-paused");
    await weeklyRow.getByTestId("routine-edit").click();
    await check(p.getByTestId("composer-input"), "改例行回到对话里，输入框预填一句话").toHaveValue(
      `把「${ROUTINE_NAME}」改成`,
    );
    await shot(p, "U10-4-edit-prefill");
    await p.getByTestId("routines-nav").click();
    await p.getByTestId("routine-resume").click();
    await check(weeklyRow).toHaveAttribute("data-state", "on");
    await check(p.getByTestId("routine-stopped")).toHaveCount(0);
    await check(p.getByTestId("routines-alert"), "恢复之后侧栏的点灭了").toHaveCount(0);
    check(await routineState(s, weekly.id), "恢复回到 on").toBe("on");
    await shot(p, "U10-5-resumed");

    begin("U11 主助理提议加一个人：首页建队卡，默认不勾的人写着理由，选小墨确认");
    await openHome(p, home);
    await p.getByTestId("today-composer-input").fill(TEAM_ASK);
    await p.getByTestId("today-composer-send").click();
    await check(p.getByTestId("today-assistant-text")).toContainText("建队卡发好了");
    const teamRow = p.locator("[data-testid=today-row][data-kind=team_offer]");
    await check(teamRow).toContainText(PROJECT);
    await teamRow.getByTestId("today-expand").click();
    const teamOffer = teamRow.getByTestId("team-offer");
    await check(teamOffer).toHaveAttribute("data-status", "offered");
    const candidates = teamOffer.getByTestId("team-offer-member");
    await check(candidates).toHaveCount(2);
    const xiaomo = candidates.filter({ hasText: "小墨" });
    const acai = candidates.filter({ hasText: "阿彩" });
    await check(xiaomo.getByTestId("team-offer-new"), "新请的标「新」").toHaveText("新");
    await check(xiaomo, "写为什么要它、它会什么").toContainText("给小红书图文排版、做封面");
    await check(xiaomo).toContainText("小墨接过来你就只用批");
    await check(xiaomo).toHaveAttribute("data-picked", "true");
    await check(acai, "建议先不带的默认不勾").toHaveAttribute("data-picked", "false");
    await check(acai, "不勾的写着理由").toContainText("先不带");
    const offerText = await teamOffer.innerText();
    check(offerText, "建队卡不问权限、不问模型").not.toMatch(/权限|模型/);
    await assertPlainHome(p, s);
    await shot(p, "U11-1-team-offer");
    await teamOffer.getByTestId("team-offer-confirm").click();
    await check(teamRow).toHaveCount(0);
    const roster = BotListResponse.parse(await s.get("/api/bots")).items.map((item) => item.bot.name);
    check(roster, "小墨请进来了").toContain("小墨");
    check(roster, "没勾的阿彩不请").not.toContain("阿彩");
    check(roster, "临时帮手不建 Bot").not.toContain("资料员");
    await p.getByTestId("assistant-nav").click();
    await check(p.getByTestId("message-list"), "临时帮手只在过程里出现一行").toContainText("拉临时帮手：资料员");
    await shot(p, "U11-2-helper-line");
    await p.getByTestId("team-nav").click();
    await check(p.locator("[data-testid=team-bot][data-bot-name=小墨]")).toContainText(PROJECT);
    await check(p.locator("[data-testid=team-bot][data-bot-name=阿彩]")).toHaveCount(0);
    await check(p.locator("[data-testid=team-bot][data-bot-name=资料员]"), "临时帮手不进团队页").toHaveCount(0);
    await shot(p, "U11-3-team");
    await openProject(p, PROJECT);
    await p.getByTestId("project-composer-input").fill(LAYOUT_ASK);
    await p.getByTestId("project-composer-send").click();
    await check(p.getByTestId("project-latest-turn")).toContainText("正文分三段");
    const layoutPrompt = s.prompts().findLast((prompt) => prompt.group.id === ids.project);
    check(
      layoutPrompt?.members.map((member) => member.name),
      "确认后新队员在下一次 prompt 的成员名单里",
    ).toContain("小墨");
    await shot(p, "U11-4-new-member");

    begin("U12 教阿文一句话：当场记下，记住的条数加一，下一次写作套用，忘掉后不再套用");
    const writerId = await botId(s, "阿文");
    await p.getByTestId("team-nav").click();
    await p.locator("[data-testid=team-bot][data-bot-name=阿文]").getByTestId("team-bot-chat").click();
    const knowToggle = p.getByTestId("bot-know-toggle");
    await check(knowToggle).toContainText("记住 0 条");
    await sendInChat(p, TEACH_ASK);
    await check(p.getByTestId("message-list")).toContainText(`记下了，以后${PREFERENCE}`);
    await check(knowToggle, "单聊顶上记住的条数当场加一").toContainText("记住 1 条");
    await knowToggle.click();
    await check(p.getByTestId("bot-pref-text"), "点开能看到这一条").toHaveText([PREFERENCE]);
    await check(p.getByTestId("bot-pref-forget")).toHaveText("忘掉");
    const botPage = await p.locator("body").innerText();
    check(botPage, "Bot 页上没有技能来源、插件勾选、模型选择").not.toMatch(/技能来源|插件|模型/);
    await shot(p, "U12-1-remembered");
    await sendInChat(p, TITLE_ASK);
    await check(p.getByTestId("message-list")).toContainText("一个人带一支 AI 小队");
    check(systemPromptFor(upstream.requests(), TITLE_ASK), "下一次写作带着这条偏好").toContain(PREFERENCE);
    await p.getByTestId("bot-pref-forget").click();
    await check(knowToggle, "忘掉之后条数减一").toContainText("记住 0 条");
    await check(p.getByTestId("bot-pref")).toHaveCount(0);
    await sendInChat(p, TITLE_AGAIN_ASK);
    await check(p.getByTestId("message-list")).toContainText("一个人的公司也能有队伍");
    const afterForget = systemPromptFor(upstream.requests(), TITLE_AGAIN_ASK);
    check(afterForget, "忘掉之后下一次写作不再套用").not.toContain(PREFERENCE);
    check(afterForget, "忘掉之后明确告诉它旧的作废").toContain("现在一条都没有");
    await shot(p, "U12-2-forgotten");

    begin("U13 改名字和标签：小弹窗，回车加标签，描述改一句；三个字段全空也能存");
    await p.getByTestId("bot-edit").click();
    const dialog = p.getByTestId("edit-bot-dialog");
    await check(dialog, "弹窗上写都可以不填").toContainText("都可以不填，它干活时自己会记");
    await dialog.getByTestId("edit-bot-tag-input").fill("长文");
    await dialog.getByTestId("edit-bot-tag-input").press("Enter");
    await check(dialog.getByTestId("edit-bot-tag"), "回车加上标签").toHaveText(["小红书", "长文"]);
    await dialog.getByTestId("edit-bot-description").fill(WRITER_DESCRIPTION);
    await shot(p, "U13-1-edit");
    await dialog.getByTestId("edit-bot-save").click();
    await check(dialog).toHaveCount(0);
    await check(p.getByTestId("bot-header").locator(".bot-header-tags .tag")).toHaveText(["小红书", "长文"]);
    await check(p.getByTestId("bot-header-description")).toHaveText(WRITER_DESCRIPTION);
    await shot(p, "U13-2-saved");
    await p.getByTestId("team-nav").click();
    await check(p.locator("[data-testid=team-bot][data-bot-name=阿文]"), "团队页上显示新标签").toContainText("长文");
    await p.locator("[data-testid=team-bot][data-bot-name=阿文]").getByTestId("team-bot-chat").click();
    await p.getByTestId("bot-edit").click();
    await dialog.getByTestId("edit-bot-name").fill("");
    await dialog.getByTestId("edit-bot-description").fill("");
    for (let left = 2; left > 0; left -= 1) await dialog.getByTestId("edit-bot-tag-remove").first().click();
    await check(dialog.getByTestId("edit-bot-tag")).toHaveCount(0);
    await shot(p, "U13-3-all-empty");
    await dialog.getByTestId("edit-bot-save").click();
    await check(dialog, "三个字段全空也能保存").toHaveCount(0);
    const writer = BotListResponse.parse(await s.get("/api/bots")).items.find((item) => item.bot.id === writerId);
    check(
      writer?.bot && { name: writer.bot.name, tags: writer.bot.tags, description: writer.bot.description },
      "名字空着不改名，标签和描述清空",
    ).toEqual({ name: "阿文", tags: [], description: "" });
    await check(p.getByTestId("bot-header-description")).toHaveCount(0);
    await shot(p, "U13-4-empty-saved");
    skip("U14 分享（代码还没合进 int）");
    process.stdout.write("acceptance: U1 到 U13 走完\n");
  } catch (error) {
    throw new Error(`${step} 失败：${String(error)}\n电脑代理日志：${stack?.agentLog().slice(-2_000) ?? "未启动"}`, {
      cause: error,
    });
  } finally {
    await browser?.close();
    if (web !== undefined) await stopWeb((web as { child: ChildProcess }).child);
    await stack?.close();
    await platforms?.close();
    await upstream.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
