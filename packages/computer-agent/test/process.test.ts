import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

// 断开期间进程里没有别的 handle 撑着事件循环，这个缺陷只有真起进程才看得见：
// vitest 自己 ref 着事件循环，同样的代码在单元测试里永远是活的。
describe("电脑代理进程", () => {
  it("控制面连不上时进程不退出，继续按退避重连", async () => {
    const child = spawn("./node_modules/.bin/tsx", ["src/main.ts"], {
      env: { ...process.env, CONTROL_PLANE_AGENT_URL: "ws://127.0.0.1:1/agent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let exitCode: number | null | "还活着" = "还活着";
    child.on("exit", (code) => (exitCode = code));

    await delay(2500);
    const alive = exitCode === "还活着";
    child.kill("SIGKILL");

    expect(alive, `进程已退出，code ${String(exitCode)}，输出：${output}`).toBe(true);
    expect(output).toMatch(/后重连，第 2 次/);
  }, 20_000);
});
