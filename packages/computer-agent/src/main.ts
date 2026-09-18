import { homedir } from "node:os";
import { join } from "node:path";
import { ComputerId } from "@baize/shared";
import { startAgent } from "./agent.js";

const AGENT_VERSION = "0.1.0";

const DEFAULT_AGENT_URL = "ws://localhost:3001/agent";

/** 进程里只有这里读 process.env，agent.ts 收到的是已经拿全的值。 */
type AgentEnv = {
  readonly url: string;
  readonly computerId: ComputerId;
  readonly token: string;
  readonly dataDir: string;
};

function readEnv(env: NodeJS.ProcessEnv): AgentEnv | { readonly missing: readonly string[] } {
  const computerId = env["COMPUTER_ID"] ?? "";
  const token = env["AGENT_TOKEN"] ?? "";
  const missing = [...(computerId === "" ? ["COMPUTER_ID"] : []), ...(token === "" ? ["AGENT_TOKEN"] : [])];
  if (missing.length > 0) return { missing };
  return {
    url: env["CONTROL_PLANE_AGENT_URL"] ?? DEFAULT_AGENT_URL,
    computerId: ComputerId.parse(computerId),
    token,
    // Bot 的会话文件落在这下面。默认值离 ~/.pi 远远的，Pi 的落盘点由运行器另外钉死。
    dataDir: env["BAIZE_DATA_DIR"] ?? join(homedir(), ".baize", "bots"),
  };
}

const config = readEnv(process.env);
if ("missing" in config) {
  console.error(
    `缺少环境变量 ${config.missing.join("、")}。跑 pnpm --filter @baize/control-plane seed 或 computer-token 拿一份。`,
  );
  process.exit(1);
}

const handle = startAgent({
  url: config.url,
  computerId: config.computerId,
  token: config.token,
  version: AGENT_VERSION,
  dataDir: config.dataDir,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.stop().finally(() => process.exit(0));
  });
}
