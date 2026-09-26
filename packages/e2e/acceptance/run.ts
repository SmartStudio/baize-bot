import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import {
  BotListResponse,
  GroupListResponse,
  MessageListResponse,
  ToolListResponse,
  UsageResponse,
} from "@baize/shared";
import { startTestMcp, type TestMcp } from "../src/mcp.js";
import { startStack, type Stack } from "../src/stack.js";
import { startUpstream, type ChatRequest, type ScriptedTurn } from "../src/upstream.js";

const screenshots = fileURLToPath(new URL("./screenshots/", import.meta.url));
const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const viteBin = fileURLToPath(new URL("../../web/node_modules/vite/bin/vite.js", import.meta.url));
const check = expect.configure({ timeout: 30_000 });

const turn = (request: ChatRequest): ScriptedTurn => {
  const lastUser = request.messages.findLastIndex((message) => message.role === "user");
  const content = request.messages[lastUser]?.content;
  const prompt = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const current = prompt.split("当前这条：").at(-1) ?? prompt;
  const afterTool = request.messages.slice(lastUser + 1).some((message) => message.role === "tool");
  const usage = { input: 1_200, output: 30 };

  if (prompt.includes("交接报文：")) {
    return afterTool
      ? { textChunks: ["我已接手，接下来确认供货。"], usage }
      : { textChunks: [], toolCall: { id: "accept-handoff", name: "accept_handoff", args: {} }, usage };
  }
  if (current.includes("先查库存和排产")) {
    return afterTool
      ? {
          textChunks: [
            "查完库存和排产。方案一：10 月 20 日先交 120 台，剩余 80 台 10 月 27 日到。",
            "方案二：200 台一起在 10 月 30 日前交。先确认交期，再回复 Lisa。",
          ],
          usage,
        }
      : {
          textChunks: [],
          toolCall: {
            id: "stock-check",
            name: "bash",
            args: { command: "printf 'X3 现货 160 台；10 月 20 日可交 120 台，剩余 80 台 10 月 27 日到。'" },
          },
          usage,
        };
  }
  if (current.includes("分两批，回复先给我看")) {
    return afterTool
      ? { textChunks: ["你批准了，我已把确认邮件发给 Lisa。"], usage }
      : {
          textChunks: [],
          toolCall: {
            id: "send-draft",
            name: "send_email",
            args: { to: "lisa@globex.example", subject: "X3 交期确认", body: "先交 120 台，再交 80 台。" },
          },
          usage,
        };
  }
  if (current.includes("交接给小采")) {
    return afterTool
      ? { textChunks: ["交接报文已发给小采，等它确认。"], usage }
      : {
          textChunks: [],
          toolCall: {
            id: "handoff-to-procurement",
            name: "handoff_task",
            args: {
              to: "小采",
              done: "确认了两批交付方案并给 Lisa 发信",
              notDone: "尚未确认供货",
              next: "核对供货与交期",
            },
          },
          usage,
        };
  }
  if (current.includes("请生成今日线索早报")) {
    return { textChunks: ["今日线索早报已生成。"], usage };
  }
  if (current.includes("整理 Globex 报价步骤")) {
    return afterTool
      ? { textChunks: ["报价步骤已经整理，等你决定要不要存。"], usage }
      : {
          textChunks: [],
          toolCall: {
            id: "offer-quote-skill",
            name: "propose_skill",
            args: { name: "Globex 报价", steps: ["核对库存与交期", "计算两批交付报价", "把报价发给客户确认"] },
          },
          usage,
        };
  }
  throw new Error(`假上游没有这条请求的剧本：${prompt.slice(-160)}`);
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

const startWeb = async (stack: Stack): Promise<{ url: string; child: ChildProcess }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [viteBin], {
    cwd: webDir,
    env: { ...process.env, API_PORT: String(stack.port), WEB_PORT: String(port) },
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

const shot = (step: number | string): string => `${screenshots}/step-${step}.png`;

const login = async (page: Page, url: string): Promise<void> => {
  await page.goto(url);
  await page.getByTestId("email-input").fill("chen@baize.dev");
  await page.getByTestId("password-input").fill("baize-dev");
  await page.getByTestId("login-submit").click();
  await check(page.getByTestId("main-window")).toBeVisible();
};

const teamCard = (page: Page, name: string) => page.locator(`[data-testid=team-bot][data-bot-name="${name}"]`);

const openBot = async (page: Page, name: string): Promise<void> => {
  await page.getByTestId("team-nav").click();
  await teamCard(page, name).getByTestId("team-bot-chat").click();
  await check(page.getByTestId("chat-title")).toHaveText(name);
};

const addBot = async (page: Page, name: string, tag: string): Promise<void> => {
  await page.getByTestId("team-nav").click();
  const before = await page.getByTestId("team-bot").count();
  await page.getByTestId("new-bot").click();
  const input = page.getByTestId("bot-name-input");
  await check(input).toBeVisible();
  await check(page.getByTestId("bot-tag-input")).toHaveValue("");
  await input.fill(name);
  await input.press("Tab");
  await check(page.getByTestId("chat-title")).toHaveText(name);
  const label = page.getByTestId("bot-tag-input");
  await label.fill(tag);
  await label.press("Tab");
  await page.getByTestId("team-nav").click();
  await check(page.getByTestId("team-bot")).toHaveCount(before + 1);
  await check(teamCard(page, name)).toContainText(tag);
};

const send = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
};

const run = async (): Promise<void> => {
  mkdirSync(screenshots, { recursive: true });
  const upstream = await startUpstream(turn);
  let mcp: TestMcp | undefined;
  let stack: Stack | undefined;
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  let browser: Browser | undefined;
  let activeStep = "启动";
  try {
    mcp = await startTestMcp();
    stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 300, priceOutputPerM: 1_500 });
    web = await startWeb(stack);
    browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
    const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
    const page = await context.newPage();

    activeStep = "1";
    await login(page, web.url);
    const seeded = BotListResponse.parse(await stack.get("/api/bots"));
    check(seeded.items.filter((item) => item.bot.role === "member").map((item) => item.bot.name)).toEqual([
      "小服",
      "小销",
      "小采",
    ]);
    check(seeded.items.filter((item) => item.bot.role === "assistant")).toHaveLength(1);
    await addBot(page, "小品", "产品");
    await addBot(page, "小设", "设计");
    await check(page.getByTestId("team-bot")).toHaveCount(5);
    check(BotListResponse.parse(await stack.get("/api/bots")).items, "5 个队员加主助理").toHaveLength(6);
    await page.screenshot({ path: shot(1) });
    process.stdout.write("step 1: 5 Bot\n");

    activeStep = "2";
    await page.getByTestId("new-project").click();
    await page.getByTestId("group-title").fill("Globex X3 × 200 订单");
    await page
      .getByTestId("group-summary")
      .fill("小服查库存与交期，小销负责报价，小采确认供货。对外发送先找陈默点头。");
    for (const name of ["小服", "小销", "小采"]) {
      await page.locator(`[data-testid=group-member][data-bot-name="${name}"]`).click();
    }
    await page.getByTestId("group-submit").click();
    await check(page.getByTestId("task-card")).toBeVisible();
    const group = GroupListResponse.parse(await stack.get("/api/groups")).items.find(
      (item) => item.task.title === "Globex X3 × 200 订单",
    );
    if (group === undefined) throw new Error("第 2 步建群后，控制面没有这张任务卡");
    // 任务卡不再露编号，改认地址里的群 id：建完跳进的正是控制面刚建的这个群。
    await check(page).toHaveURL(new RegExp(`/g/${group.group.id}$`));
    await page.screenshot({ path: shot(2) });
    process.stdout.write(`step 2: ${group.task.number}\n`);

    activeStep = "3";
    await send(page, "@小服 Lisa 要 200 台 X3，10 月 30 日前交，先查库存和排产");
    await check(page.getByTestId("tool-call-card")).toHaveAttribute("data-status", "ok");
    await check(page.getByTestId("tool-call-card")).toHaveAttribute("data-view-kind", "bash");
    await check(page.getByTestId("bot-bubble").filter({ hasText: "方案一" })).toContainText("方案二");
    const history = MessageListResponse.parse(await stack.get(`/api/groups/${group.group.id}/messages`));
    check(history.messages.some((message) => message.body.kind === "tool_call" && message.body.tool === "bash")).toBe(
      true,
    );
    check(history.messages.some((message) => message.body.kind === "bot" && message.body.text.includes("方案二"))).toBe(
      true,
    );
    await page.screenshot({ path: shot(3) });
    process.stdout.write("step 3: bash 与两方案已落到群里\n");

    activeStep = "4a";
    await page.getByTestId("account-button").click();
    await check(page.getByTestId("account-menu")).toBeVisible();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-nav-tools").click();
    await check(page.getByTestId("tools-page")).toBeVisible();
    await page.getByTestId("tool-name-input").fill("邮箱");
    await page.getByTestId("tool-url-input").fill(mcp.baseUrl);
    await page.getByTestId("tool-authorization-input").fill("Bearer e2e-token");
    await page.getByTestId("tool-connect").click();
    const mail = page.locator('[data-testid=tool-card][data-tool-name="邮箱"]');
    await check(mail).toBeVisible();
    if (!(await mail.getByTestId("tool-details").isVisible())) await mail.getByTestId("tool-edit-assignment").click();
    const serviceCheckbox = mail.locator('[data-testid=tool-bot-checkbox][data-bot-name="小服"]');
    await serviceCheckbox.click();
    await check(serviceCheckbox).toBeChecked();
    const service = seeded.items.find((item) => item.bot.name === "小服");
    if (service === undefined) throw new Error("种子数据缺少小服");
    await check
      .poll(async () =>
        ToolListResponse.parse(await stack.get("/api/tools")).items[0]?.assignedBotIds.includes(service.bot.id),
      )
      .toBe(true);
    await page.screenshot({ path: shot("4a") });
    await page.getByTestId("settings-close").click();
    process.stdout.write("step 4a: 邮箱 MCP 已连接并分配给小服\n");

    activeStep = "4";
    await send(page, "分两批，回复先给我看");
    const approval = page.getByTestId("approval-card");
    await check(approval).toHaveAttribute("data-status", "pending");
    const pendingHistory = MessageListResponse.parse(await stack.get(`/api/groups/${group.group.id}/messages`));
    check(pendingHistory.approvals.some((item) => item.status === "pending")).toBe(true);
    check(mcp.calls(), "批准前绝不能调用 send_email").toHaveLength(0);
    await page.screenshot({ path: shot(4) });
    await approval.getByTestId("approval-approve").click();
    await check(page.getByTestId("bot-bubble").filter({ hasText: "你批准了" })).toBeVisible();
    await check(page.getByTestId("tool-call-card").filter({ hasText: "send_email" })).toHaveAttribute(
      "data-status",
      "ok",
    );
    check(mcp.calls()).toEqual([
      {
        name: "send_email",
        args: { to: "lisa@globex.example", subject: "X3 交期确认", body: "先交 120 台，再交 80 台。" },
        authorization: "Bearer e2e-token",
      },
    ]);
    process.stdout.write("step 4: 邮件先审批后发送，工具卡 ok\n");

    activeStep = "5";
    await send(page, "@小服 现在把这单交接给小采");
    await check(page.getByTestId("handoff-card")).toHaveAttribute("data-status", "accepted");
    await check(page.getByTestId("task-current")).toHaveText("当前 小采");
    const handed = MessageListResponse.parse(await stack.get(`/api/groups/${group.group.id}/messages`));
    check(handed.handoffs.some((item) => item.status === "accepted")).toBe(true);
    await page.screenshot({ path: shot(5) });
    process.stdout.write("step 5: 小采确认交接并成为当前经手\n");

    activeStep = "6";
    process.stdout.write("step 6: skip，已登录站点 gated\n");

    activeStep = "7";
    await page.getByTestId("routines-nav").click();
    await check(page.getByTestId("routine-list")).toBeVisible();
    await page.getByTestId("routine-new").click();
    await page.getByTestId("routine-bot-select").selectOption({ label: "小销" });
    await page.getByTestId("routine-name-input").fill("每日线索早报");
    await page.getByTestId("routine-instruction-input").fill("请生成今日线索早报");
    await page.getByTestId("trigger-add").click();
    await page.getByTestId("trigger-preset-daily").click();
    await page.getByTestId("routine-save").click();
    const routine = page.locator('[data-testid=routine-row][data-routine-name="每日线索早报"]');
    await check(routine).toBeVisible();
    await routine.getByTestId("routine-open").click();
    await page.getByTestId("routine-run-now").click();
    await openBot(page, "小销");
    await check(page.getByTestId("message-list").getByText("例行任务「每日线索早报」自动运行")).toBeVisible();
    await check(page.getByTestId("bot-bubble").filter({ hasText: "今日线索早报已生成" })).toBeVisible();
    await page.screenshot({ path: shot(7) });
    process.stdout.write("step 7: 小销例行任务试跑出结果\n");

    activeStep = "8";
    await page.locator('[data-testid=group-item][data-group-title="Globex X3 × 200 订单"]').click();
    await check(page.getByTestId("task-card")).toBeVisible();
    await send(page, "@小服 请整理 Globex 报价步骤，问我要不要存");
    const offer = page.getByTestId("skill-offer").filter({ hasText: "Globex 报价" });
    await check(offer).toHaveAttribute("data-status", "offered");
    await offer.getByTestId("skill-offer-save").click();
    await check(offer).toHaveAttribute("data-status", "saved");
    await openBot(page, "小服");
    await page.getByTestId("bot-tab-skills").click();
    await check(page.locator('[data-testid=skill-row][data-skill-name="Globex 报价"]')).toBeVisible();
    await page.screenshot({ path: shot(8) });
    process.stdout.write("step 8: Globex 报价已存为小服的会做的活\n");

    activeStep = "9";
    await page.getByTestId("account-button").click();
    await check(page.getByTestId("account-menu")).toBeVisible();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-nav-usage").click();
    await check(page.getByTestId("usage-page")).toBeVisible();
    const usage = UsageResponse.parse(await stack.get("/api/usage"));
    const serviceUsage = usage.bots.find((item) => item.botId === service.bot.id);
    if (serviceUsage === undefined) throw new Error("用量接口没有小服这一行");
    check(serviceUsage.amount).toBeGreaterThan(0);
    const serviceLine = page.getByTestId("usage-bots").locator(".usage-bot").filter({ hasText: "小服" });
    await check(serviceLine).toBeVisible();
    await check
      .poll(async () => Number((await serviceLine.locator("strong").textContent())?.replace(/[¥,]/g, "")))
      .toBeGreaterThan(0);
    await check(page.getByTestId("usage-bots").locator(".usage-bot"), "零花费的主助理也列一行").toHaveCount(6);
    await page.screenshot({ path: shot(9) });
    process.stdout.write(`step 9: 小服本周用量 ¥${serviceUsage.amount.toFixed(2)}\n`);
    process.stdout.write("acceptance: 9 步（第 6 步 skip）\n");
  } catch (error) {
    throw new Error(
      `第 ${activeStep} 步失败：${String(error)}\n电脑代理日志：${stack?.agentLog().slice(-2_000) ?? "未启动"}`,
      { cause: error },
    );
  } finally {
    await browser?.close();
    if (web !== undefined) await stopWeb(web.child);
    await stack?.close();
    await mcp?.close();
    await upstream.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
