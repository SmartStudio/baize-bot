import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { AgentCloseCode, AgentStatusLine } from "@baize/shared";

// 断开期间进程里没有别的 handle 撑着事件循环，这个缺陷只有真起进程才看得见：
// vitest 自己 ref 着事件循环，同样的代码在单元测试里永远是活的。

const NOWHERE = "ws://127.0.0.1:1/agent";

type Child = {
  readonly process: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly stdin: Writable;
  readonly output: () => string;
  readonly stdout: () => string;
  /** 输出里出现这段字就赢。 */
  waitForOutput(needle: string): Promise<"输出">;
  waitForExit(timeoutMs?: number): Promise<`退出 ${string}`>;
};

function spawnAgent(env: NodeJS.ProcessEnv): Child {
  const childEnv = { ...process.env, ...env };
  if (!("AGENT_TOKEN" in env)) delete childEnv["AGENT_TOKEN"];
  const child = spawn("./node_modules/.bin/tsx", ["src/main.ts"], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  const listeners: (() => void)[] = [];
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const notify of listeners) notify();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    collect(chunk);
  });
  child.stderr.on("data", collect);

  return {
    process: child,
    stdin: child.stdin,
    output: () => output,
    stdout: () => stdout,
    waitForOutput: (needle) =>
      new Promise((resolve) => {
        const check = (): void => {
          if (output.includes(needle)) resolve("输出");
        };
        listeners.push(check);
        check();
      }),
    waitForExit: (timeoutMs = 60_000) =>
      new Promise((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve(`退出 ${String(child.exitCode)}`);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`等了 ${timeoutMs}ms 进程还没退出`));
        }, timeoutMs);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve(`退出 ${String(code ?? signal)}`);
        });
      }),
  };
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "baize-process-test-"));
}

async function startWelcomeServer(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "welcome",
            ownerId: "owner-1",
            kind: "local",
            serverTime: new Date().toISOString(),
          }),
        );
      }
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假控制面没有监听地址");
  const { port } = address as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/agent`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("电脑代理进程", () => {
  // 两件事赛跑，没有墙钟阈值：退避定时器 unref 了的话，第一次重连排上之后进程就没 handle 了，
  // 退出会先到；ref 住了就是第二条重连日志先到。机器慢只让整场比赛变慢，不会改变胜负。
  it("控制面连不上时进程不退出，继续按退避重连", async () => {
    const child = spawnAgent({});
    const dataDir = await createDataDir();
    child.stdin.write(
      `${JSON.stringify({
        url: NOWHERE,
        computerId: "computer-1",
        token: "token-1",
        dataDir,
      })}\n`,
    );

    const winner = await Promise.race([child.waitForOutput("后重连，第 2 次"), child.waitForExit()]);
    child.process.kill("SIGKILL");

    expect(winner, `输出：${child.output()}`).toBe("输出");
  }, 60_000);

  it.each(["token-in-env", ""])(
    "环境里有 AGENT_TOKEN（%j）就拒绝启动，不去连控制面",
    async (token) => {
      const child = spawnAgent({ AGENT_TOKEN: token });
      const dataDir = await createDataDir();
      child.stdin.write(
        `${JSON.stringify({
          url: NOWHERE,
          computerId: "computer-1",
          token: "token-from-stdin",
          dataDir,
        })}\n`,
      );

      const exit = await child.waitForExit();

      expect(exit).toBe("退出 1");
      expect(child.output()).toContain("AGENT_TOKEN");
      expect(child.output(), "连都不该连，更不该排重连").not.toContain("后重连");
    },
    60_000,
  );

  it("stdin 关闭后代理自己停机", async () => {
    const child = spawnAgent({});
    const dataDir = await createDataDir();
    child.stdin.write(
      `${JSON.stringify({
        url: NOWHERE,
        computerId: "computer-1",
        token: "token-1",
        dataDir,
      })}\n`,
    );

    try {
      child.stdin.end();
      await expect(child.waitForExit(5_000)).resolves.toBe("退出 0");
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
    }
  }, 15_000);

  it("welcome 后 stdout 输出固定 online JSON 标记", async () => {
    const server = await startWelcomeServer();
    const child = spawnAgent({});
    const dataDir = await createDataDir();
    child.stdin.write(
      `${JSON.stringify({
        url: server.url,
        computerId: "computer-1",
        token: "token-1",
        dataDir,
      })}\n`,
    );

    try {
      await child.waitForOutput('{"type":"online"}');
      expect(child.stdout().split("\n")).toContain('{"type":"online"}');
    } finally {
      child.stdin.end();
      if (child.process.exitCode === null) {
        try {
          await child.waitForExit(5_000);
        } catch {
          child.process.kill("SIGKILL");
        }
      }
      await server.close();
    }
  }, 15_000);

  it("顶号后 stdout 报 displaced，stdin 开放时以停止状态驻留，关闭 stdin 正常退出", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.once("message", () => socket.close(AgentCloseCode.displaced));
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    const child = spawnAgent({});
    child.stdin.write(
      `${JSON.stringify({
        url: `ws://127.0.0.1:${address.port}/agent`,
        computerId: "computer-1",
        token: "旧 token",
        dataDir: await createDataDir(),
      })}\n`,
    );
    try {
      await child.waitForOutput('{"type":"displaced"}');
      // 默认首次重连至少等 500ms，留过这个窗口才能发现误排重连。
      await new Promise((resolve) => setTimeout(resolve, 800));
      const lines = child
        .stdout()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => AgentStatusLine.parse(JSON.parse(line)));
      expect(lines).toEqual([{ type: "displaced" }]);
      expect(connections, "旧 token 被顶后不能无限重新 hello").toBe(1);
      expect(child.output()).not.toContain("后重连");
      expect(child.process.exitCode, "stdin 仍开放时代理保留停止态进程").toBeNull();
      child.stdin.end();
      await expect(child.waitForExit(5_000)).resolves.toBe("退出 0");
    } finally {
      if (child.process.exitCode === null) child.process.kill("SIGKILL");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
