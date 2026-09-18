import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

// 断开期间进程里没有别的 handle 撑着事件循环，这个缺陷只有真起进程才看得见：
// vitest 自己 ref 着事件循环，同样的代码在单元测试里永远是活的。

const NOWHERE = "ws://127.0.0.1:1/agent";

type Child = {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly output: () => string;
  /** 输出里出现这段字就赢。 */
  waitForOutput(needle: string): Promise<"输出">;
  waitForExit(): Promise<`退出 ${string}`>;
};

function spawnAgent(env: NodeJS.ProcessEnv): Child {
  const child = spawn("./node_modules/.bin/tsx", ["src/main.ts"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const listeners: (() => void)[] = [];
  const collect = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const notify of listeners) notify();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  return {
    process: child,
    output: () => output,
    waitForOutput: (needle) =>
      new Promise((resolve) => {
        const check = (): void => {
          if (output.includes(needle)) resolve("输出");
        };
        listeners.push(check);
        check();
      }),
    waitForExit: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve(`退出 ${String(child.exitCode)}`);
        child.on("exit", (code, signal) => resolve(`退出 ${String(code ?? signal)}`));
      }),
  };
}

describe("电脑代理进程", () => {
  // 两件事赛跑，没有墙钟阈值：退避定时器 unref 了的话，第一次重连排上之后进程就没 handle 了，
  // 退出会先到；ref 住了就是第二条重连日志先到。机器慢只让整场比赛变慢，不会改变胜负。
  it("控制面连不上时进程不退出，继续按退避重连", async () => {
    const child = spawnAgent({
      CONTROL_PLANE_AGENT_URL: NOWHERE,
      COMPUTER_ID: "computer-1",
      AGENT_TOKEN: "token-1",
    });

    const winner = await Promise.race([child.waitForOutput("后重连，第 2 次"), child.waitForExit()]);
    child.process.kill("SIGKILL");

    expect(winner, `输出：${child.output()}`).toBe("输出");
  }, 60_000);

  it("没有 AGENT_TOKEN 就报错退出，不去连控制面", async () => {
    const child = spawnAgent({
      CONTROL_PLANE_AGENT_URL: NOWHERE,
      COMPUTER_ID: "computer-1",
      AGENT_TOKEN: "",
    });

    const exit = await child.waitForExit();

    expect(exit).toBe("退出 1");
    expect(child.output()).toContain("AGENT_TOKEN");
    expect(child.output(), "连都不该连，更不该排重连").not.toContain("后重连");
  }, 60_000);
});
