import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFollowUpTurn, startUpstream } from "../../e2e/src/upstream.js";
import WebSocket from "ws";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(desktop, "../..");
const databaseUrl = "postgres://baize:baize@localhost:5434/baize_verify";
const requestedControlPort = Number(
  process.argv.find((value) => value.startsWith("--control-port="))?.slice(15) ?? "3101",
);
if (!Number.isInteger(requestedControlPort) || requestedControlPort < 1 || requestedControlPort > 65_535) {
  throw new Error("--control-port 必须是 1 到 65535 的整数");
}
const controlPort = requestedControlPort;
const controlOrigin = `http://127.0.0.1:${controlPort}`;
const resultPath = join(desktop, "dist/prove.json");
const appPath = join(desktop, "dist/pack", `Baize-darwin-${process.arch}`, "Baize.app");
const binary = join(appPath, "Contents/MacOS/Baize");
const userData = mkdtempSync(join(tmpdir(), "baize-desktop-prove-"));

type Run = { readonly helloMs: number; readonly agentPid: number };
const result: {
  packagedApp: string;
  controlPort: number;
  helloRunsMs: number[];
  medianHelloMs: number | null;
  envHasAgentToken: boolean | null;
  bashDescendants: number[];
  aliveAfterQuit: number[];
  appSelfExitedAfterSigterm: boolean | null;
  error?: string;
} = {
  packagedApp: appPath,
  controlPort,
  helloRunsMs: [],
  medianHelloMs: null,
  envHasAgentToken: null,
  bashDescendants: [],
  aliveAfterQuit: [],
  appSelfExitedAfterSigterm: null,
};

const save = (): void => writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env["AGENT_TOKEN"];
  delete env["COMPUTER_ID"];
  delete env["CONTROL_PLANE_AGENT_URL"];
  delete env["ELECTRON_RUN_AS_NODE"];
  return env;
}

function run(command: string, args: string[], extra: Record<string, string> = {}): string {
  const done = spawnSync(command, args, { cwd: repo, env: cleanEnv(extra), encoding: "utf8" });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败\n${done.stdout}\n${done.stderr}`);
  return `${done.stdout}\n${done.stderr}`;
}

async function portFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("没有可用的调试端口"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

type DevtoolsTarget = { readonly type?: string; readonly url?: string; readonly webSocketDebuggerUrl?: string };

class DevtoolsPage {
  readonly #socket: WebSocket;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    const rejectPending = (error: Error): void => {
      if (this.#closed) return;
      this.#closed = true;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    socket.on("error", () => rejectPending(new Error("DevTools WebSocket 已断开")));
    socket.on("close", () => rejectPending(new Error("DevTools WebSocket 已关闭")));
    socket.on("message", (raw) => {
      let message: {
        readonly id?: number;
        readonly result?: {
          readonly result?: { readonly value?: unknown };
          readonly exceptionDetails?: {
            readonly exception?: { readonly description?: string };
            readonly text?: string;
          };
          readonly data?: string;
        };
        readonly error?: { readonly message?: string };
      };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      const exception = message.result?.exceptionDetails;
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "DevTools 调用失败"));
      else if (exception !== undefined)
        pending.reject(new Error(`页面脚本抛错：${exception.exception?.description ?? exception.text ?? "未知"}`));
      else if (message.result?.result !== undefined) pending.resolve(message.result.result.value);
      else pending.resolve(message.result?.data);
    });
  }

  static async connect(port: number): Promise<DevtoolsPage> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = (await response.json()) as DevtoolsTarget[];
        const target = targets.find(
          (item) =>
            item.type === "page" &&
            item.webSocketDebuggerUrl !== undefined &&
            item.url !== undefined &&
            !new URL(item.url).pathname.endsWith("/menubar") &&
            new URL(item.url).searchParams.get("next") !== "/menubar",
        );
        if (target?.webSocketDebuggerUrl !== undefined) {
          const socket = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
          });
          return new DevtoolsPage(socket);
        }
      } catch {
        // Electron 还没打开调试端口，继续等待。
      }
      if (Date.now() >= deadline) throw new Error("实证脚本等不到 Electron 调试页面");
      await sleep(100);
    }
  }

  evaluate(expression: string): Promise<unknown> {
    return this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  private command(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("DevTools WebSocket 已关闭"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools 调用超时：${method}`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }), (error?: Error | null) => {
        if (error === undefined || error === null) return;
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        clearTimeout(timer);
        pending?.reject(error);
      });
    });
  }

  async screenshot(path: string): Promise<void> {
    const data = await this.command("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(String(data), "base64"));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("DevTools WebSocket 已关闭"));
    this.#pending.clear();
    this.#socket.close();
  }
}

async function waitFor(page: DevtoolsPage, expression: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    if ((await page.evaluate(`Boolean(${expression})`).catch(() => false)) === true) return;
    if (Date.now() - started > timeoutMs) {
      const diagnostic = await page
        .evaluate(
          `({
          href: location.href,
          readyState: document.readyState,
          title: document.title,
          body: document.body?.innerText?.slice(0, 1000) ?? ""
        })`,
        )
        .catch((error: unknown) => ({ diagnosticError: error instanceof Error ? error.message : String(error) }));
      throw new Error(`等不到页面条件：${expression}\n页面状态：${JSON.stringify(diagnostic)}`);
    }
    await sleep(100);
  }
}

async function driveProof(
  page: DevtoolsPage,
  credentials: { readonly email: string; readonly password: string; readonly mode: "hello" | "bash" },
  waitAgent: () => Promise<void>,
): Promise<void> {
  await waitFor(page, "document.querySelector('[data-testid=login]') !== null", 30_000);
  await waitFor(page, "document.querySelector('[data-testid=email-input]') !== null", 20_000);
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid=email-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(credentials.email)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid=password-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(credentials.password)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(page, "document.querySelector('[data-testid=login-submit]') !== null", 20_000);
  await page.evaluate("document.querySelector('[data-testid=login-submit]').click()");
  await waitFor(page, "document.querySelector('[data-testid=main-window]') !== null", 30_000);
  await waitAgent();
  if (credentials.mode === "hello") return;
  await waitFor(page, "document.querySelector('[data-testid=bot-item]') !== null", 20_000);
  await page.evaluate("document.querySelector('[data-testid=bot-item]').click()");
  await waitFor(page, "document.querySelector('[data-testid=composer-input]') !== null", 20_000);
  await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid=composer-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "运行一个长命令");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(page, "document.querySelector('[data-testid=composer-send]') !== null", 20_000);
  const approvalsBefore = Number(
    await page.evaluate("document.querySelectorAll('[data-testid=approval-card]').length"),
  );
  await page.evaluate("document.querySelector('[data-testid=composer-send]').click()");
  // 闸门对 sleep 要审批；baize_verify 里留着往次的卡，只认这次发送之后新出的那张。
  const newApproval = `[...document.querySelectorAll('[data-testid=approval-card]')].slice(${approvalsBefore})`;
  await waitFor(
    page,
    `${newApproval}.some((card) => card.querySelector('[data-testid=approval-approve]') !== null)`,
    45_000,
  );
  await page.evaluate(
    `${newApproval}.find((card) => card.querySelector('[data-testid=approval-approve]') !== null).querySelector('[data-testid=approval-approve]').click()`,
  );
  await waitFor(page, `${newApproval}.some((card) => card.dataset.status === 'approved')`, 20_000);
  await waitFor(
    page,
    "[...document.querySelectorAll('[data-testid=tool-call-card]')].at(-1)?.matches('[data-status=running][data-view-kind=bash]') === true",
    45_000,
  );
}

function follow(child: ChildProcess): { waitFor(needle: string, timeoutMs: number): Promise<string>; all(): string } {
  let text = "";
  const listeners = new Set<() => void>();
  const add = (chunk: Buffer): void => {
    text += chunk.toString();
    for (const listener of listeners) listener();
  };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  return {
    all: () => text,
    waitFor: (needle, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等不到 ${needle}\n${text.slice(-4000)}`)), timeoutMs);
        const check = (): void => {
          const line = text.split("\n").find((item) => item.includes(needle));
          if (line === undefined) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(line);
        };
        listeners.add(check);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`App 提前退出 ${String(code ?? signal)}\n${text.slice(-4000)}`));
        });
        check();
      }),
  };
}

async function stop(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill("SIGTERM");
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => {
      child.kill("SIGKILL");
      return false;
    }),
  ]);
}

function assertHardProof(): void {
  const failures = [
    result.envHasAgentToken === false ? null : "envHasAgentToken 必须为 false",
    result.bashDescendants.length > 0 ? null : "bashDescendants 必须非空",
    result.aliveAfterQuit.length === 0 ? null : `aliveAfterQuit 必须为空：${result.aliveAfterQuit.join(",")}`,
    result.appSelfExitedAfterSigterm === true ? null : "App 必须在 SIGTERM 后 5 秒内自行退出",
  ].filter((failure): failure is string => failure !== null);
  if (failures.length > 0) throw new Error(`prove 硬断言失败：${failures.join("；")}`);
}

function descendantsOf(rootPid: number): number[] {
  const output = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  const rows = output
    .trim()
    .split("\n")
    .map((line) => {
      const matched = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
      return matched === null ? null : { pid: Number(matched[1]), ppid: Number(matched[2]), command: matched[3] ?? "" };
    })
    .filter((row): row is { pid: number; ppid: number; command: string } => row !== null);
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid);
        changed = true;
      }
    }
  }
  return [...found].filter((pid) => pid !== rootPid);
}

async function waitDescendants(rootPid: number, timeoutMs: number): Promise<number[]> {
  const started = Date.now();
  for (;;) {
    const found = descendantsOf(rootPid);
    if (found.length > 0 || Date.now() - started > timeoutMs) return found;
    await sleep(100);
  }
}

async function launch(
  mode: "hello" | "bash" | "stored",
  screenshot?: string,
): Promise<{ child: ChildProcess; run: Run }> {
  const env = cleanEnv({});
  const remoteDebuggingPort = await freePort();
  const started = performance.now();
  const child = spawn(
    binary,
    [
      `--control-origin=${controlOrigin}`,
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${remoteDebuggingPort}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const logs = follow(child);
  try {
    const page = await DevtoolsPage.connect(remoteDebuggingPort);
    try {
      if (mode === "stored") await logs.waitFor("agent-online", 90_000);
      else {
        await driveProof(page, { email: "chen@baize.dev", password: "baize-dev", mode }, () =>
          logs.waitFor("agent-online", 90_000).then(() => undefined),
        );
        if (screenshot !== undefined) await page.screenshot(screenshot);
      }
    } finally {
      page.close();
    }
  } catch (error) {
    await stop(child);
    throw error;
  }
  const pidLine = logs
    .all()
    .split("\n")
    .find((item) => item.includes("agent-pid"));
  const agentPid = Number(/agent-pid (\d+)/u.exec(pidLine ?? "")?.[1]);
  if (!Number.isInteger(agentPid)) throw new Error(`读不到 agent pid\n${logs.all()}`);
  const elapsed = Math.round(performance.now() - started);
  return { child, run: { helloMs: elapsed, agentPid } };
}

async function main(): Promise<void> {
  if (!existsSync(join(appPath, "Contents/Info.plist"))) throw new Error("没有打包 App");
  if (!(await portFree(controlPort))) throw new Error(`${controlPort} 端口已被占用`);
  const postgresReady = spawnSync("docker", ["exec", "baize-postgres", "pg_isready", "-U", "baize"], {
    encoding: "utf8",
  });
  if (postgresReady.status !== 0) run("docker", ["compose", "up", "-d"]);
  const upstream = await startUpstream((request) =>
    isFollowUpTurn(request)
      ? { textChunks: ["长命令结束。"], usage: { input: 100, output: 10 } }
      : {
          textChunks: [],
          toolCall: { id: "desktop-sleep", name: "bash", args: { command: "sleep 90" } },
          usage: { input: 100, output: 10 },
        },
  );
  let control: ChildProcess | null = null;
  try {
    const baseEnv = {
      DATABASE_URL: databaseUrl,
      UPSTREAM_BASE_URL: upstream.baseUrl,
      UPSTREAM_API_KEY: "desktop-prove-key",
      GATEWAY_MODEL: "fake-model",
      PORT: String(controlPort),
      COOKIE_SECURE: "false",
    };
    run("pnpm", ["--filter", "@baize/control-plane", "migrate"], baseEnv);
    run("pnpm", ["--filter", "@baize/control-plane", "seed"], baseEnv);
    control = spawn("pnpm", ["--filter", "@baize/control-plane", "start"], {
      cwd: repo,
      env: cleanEnv(baseEnv),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await follow(control).waitFor("控制面在", 60_000);

    const first = await launch("bash", join(desktop, "dist/prove-app.png"));
    const environment = spawnSync("ps", ["eww", "-p", String(first.run.agentPid)], { encoding: "utf8" }).stdout;
    writeFileSync(join(desktop, "dist/prove-ps.txt"), environment);
    result.envHasAgentToken = environment.includes("AGENT_TOKEN=");
    result.bashDescendants = await waitDescendants(first.run.agentPid, 15_000);
    result.appSelfExitedAfterSigterm = await stop(first.child);
    await sleep(500);
    result.aliveAfterQuit = [first.run.agentPid, ...result.bashDescendants].filter(alive);
    save();
    assertHardProof();

    for (let index = 0; index < 5; index += 1) {
      const measured = await launch("stored");
      result.helloRunsMs.push(measured.run.helloMs);
      await stop(measured.child);
      await sleep(300);
      save();
    }
    const sorted = result.helloRunsMs.toSorted((a, b) => a - b);
    result.medianHelloMs = sorted[Math.floor(sorted.length / 2)] ?? null;
    save();
  } finally {
    if (control?.pid !== undefined) {
      try {
        process.kill(-control.pid, "SIGTERM");
      } catch {
        control.kill("SIGTERM");
      }
    }
    await upstream.close();
    rmSync(userData, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  save();
  console.error(result.error);
  process.exitCode = 1;
});
