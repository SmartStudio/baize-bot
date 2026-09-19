import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { BotListResponse, GroupListResponse, MessageListResponse } from "@baize/shared";
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
      ? { textChunks: ["发送工具不可用，这封邮件没有发出。"], usage }
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

const shot = (step: number): string => `${screenshots}/step-${step}.png`;

const login = async (page: Page, url: string): Promise<void> => {
  await page.goto(url);
  await page.getByTestId("workspace-input").fill("acme");
  await page.getByTestId("workspace-continue").click();
  await page.getByTestId("email-input").fill("chen@baize.dev");
  await page.getByTestId("password-input").fill("baize-dev");
  await page.getByTestId("login-submit").click();
  await check(page.getByTestId("main-window")).toBeVisible();
};

const addBot = async (page: Page, name: string, tag: string): Promise<void> => {
  const before = await page.getByTestId("bot-item").count();
  await page.getByTestId("new-menu").click();
  await page.getByTestId("new-bot").click();
  await check(page.getByTestId("bot-item")).toHaveCount(before + 1);
  const input = page.getByTestId("bot-name-input");
  await check(input).toBeVisible();
  await check(page.getByTestId("bot-tag-input")).toHaveValue("");
  await input.fill(name);
  await input.press("Tab");
  await check(page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`)).toBeVisible();
  const label = page.getByTestId("bot-tag-input");
  await label.fill(tag);
  await label.press("Tab");
  await check(page.locator(`[data-testid=bot-item][data-bot-name="${name}"]`)).toContainText(tag);
};

const send = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
};

const run = async (): Promise<void> => {
  mkdirSync(screenshots, { recursive: true });
  const upstream = await startUpstream(turn);
  let stack: Stack | undefined;
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;
  let browser: Browser | undefined;
  try {
    stack = await startStack({ upstreamBaseUrl: upstream.baseUrl, priceInputPerM: 300, priceOutputPerM: 1_500 });
    web = await startWeb(stack);
    browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" });
    const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
    const page = await context.newPage();

    await login(page, web.url);
    const seeded = BotListResponse.parse(await stack.get("/api/bots"));
    check(seeded.items.map((item) => item.bot.name)).toEqual(["小服", "小销", "小采"]);
    await addBot(page, "小品", "产品");
    await addBot(page, "小设", "设计");
    await check(page.getByTestId("bot-item")).toHaveCount(5);
    check(BotListResponse.parse(await stack.get("/api/bots")).items).toHaveLength(5);
    await page.screenshot({ path: shot(1) });
    process.stdout.write("step 1: 5 Bot\n");

    await page.getByTestId("new-menu").click();
    await page.getByTestId("new-group").click();
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
    await check(page.getByTestId("task-number")).toHaveText(group.task.number);
    await page.screenshot({ path: shot(2) });
    process.stdout.write(`step 2: ${group.task.number}\n`);

    await send(page, "@小服 Lisa 要 200 台 X3，10 月 30 日前交，先查库存和排产");
    await check(page.getByTestId("tool-call-card")).toHaveAttribute("data-status", "ok");
    await check(page.getByTestId("tool-call-card")).toContainText("bash");
    await check(page.getByTestId("bot-bubble").filter({ hasText: "方案一" })).toContainText("方案二");
    await check(page.getByTestId("cost-card")).toBeVisible();
    const history = MessageListResponse.parse(await stack.get(`/api/groups/${group.group.id}/messages`));
    check(history.messages.some((message) => message.body.kind === "tool_call" && message.body.tool === "bash")).toBe(
      true,
    );
    check(history.messages.some((message) => message.body.kind === "bot" && message.body.text.includes("方案二"))).toBe(
      true,
    );
    await page.screenshot({ path: shot(3) });
    process.stdout.write("step 3: bash 与两方案已落到群里\n");

    await send(page, "分两批，回复先给我看");
    const runningStack = stack;
    await check
      .poll(
        async () =>
          (
            await runningStack.sql<{ ended_at: Date | null }[]>`
      SELECT ended_at FROM runs WHERE group_id = ${group.group.id}
    `
          ).filter((item) => item.ended_at !== null).length,
      )
      .toBe(2);
    await check(page.getByTestId("tool-call-card").filter({ hasText: "send_email" })).toHaveAttribute(
      "data-status",
      "failed",
    );
    const blockedHistory = MessageListResponse.parse(await stack.get(`/api/groups/${group.group.id}/messages`));
    check(
      blockedHistory.messages.some(
        (message) =>
          message.body.kind === "tool_call" && message.body.tool === "send_email" && message.body.status === "failed",
      ),
    ).toBe(true);
    const approvals = await stack.sql<{ id: string }[]>`SELECT id FROM approvals WHERE group_id = ${group.group.id}`;
    await page.screenshot({ path: shot(4) });
    if (approvals.length === 0) {
      throw new Error(
        `第 4 步阻塞：send_email 未注册，控制面下发 tools: []；真实运行后审批表 0 条，页面审批卡 ${await page.getByTestId("approval-card").count()} 张。电脑代理日志：${stack.agentLog().slice(-2_000)}`,
      );
    }
    await check(page.getByTestId("approval-card")).toBeVisible();
    throw new Error("第 5、7、8、9 步尚未实跑，不能将九步剧本判为通过");
  } finally {
    await browser?.close();
    if (web !== undefined) await stopWeb(web.child);
    await stack?.close();
    await upstream.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
