import { createInterface } from "node:readline";
import { AgentLaunch } from "@baize/shared";
import { startAgent } from "./agent.js";

const AGENT_VERSION = "0.1.0";
let stdinEnded = false;

process.stdin.once("end", () => {
  stdinEnded = true;
});

function readLaunch(): Promise<AgentLaunch> {
  if (Object.prototype.hasOwnProperty.call(process.env, "AGENT_TOKEN")) {
    return Promise.reject(new Error("环境变量 AGENT_TOKEN 不允许存在，token 必须通过 stdin 传入"));
  }

  const input = createInterface({ input: process.stdin });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      input.close();
      reject(error);
    };
    input.once("line", (line) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        fail(new Error("启动配置不是 JSON"));
        return;
      }
      const parsed = AgentLaunch.safeParse(json);
      if (!parsed.success) {
        fail(new Error("启动配置不合 schema"));
        return;
      }
      settled = true;
      input.close();
      resolve(parsed.data);
    });
    input.once("close", () => fail(new Error("stdin 未提供启动配置")));
    input.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

void readLaunch()
  .then((config: AgentLaunch) => {
    delete process.env["ELECTRON_RUN_AS_NODE"];
    const handle = startAgent({
      url: config.url,
      computerId: config.computerId,
      token: config.token,
      version: AGENT_VERSION,
      dataDir: config.dataDir,
    });

    const stop = (): void => {
      void handle.stop().finally(() => process.exit(0));
    };
    if (stdinEnded) stop();
    else process.stdin.once("end", stop);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void handle.stop().finally(() => process.exit(0));
      });
    }
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`电脑代理启动失败：${message}`);
    process.exit(1);
  });
