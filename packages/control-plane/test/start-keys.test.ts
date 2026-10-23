import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** 库指向连不上的端口、端口交给系统分配：钥匙齐了也起不来，只看钥匙缺了时报的是什么。 */
function start(drop: "TOOL_SECRET_KEY" | "CREDENTIALS_KEY" | null, toolSecretKey: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: "postgres://baize:baize@127.0.0.1:1/none",
    PORT: "0",
    TOOL_SECRET_KEY: toolSecretKey,
    CREDENTIALS_KEY: randomBytes(32).toString("base64"),
  };
  if (drop !== null) delete env[drop];
  return new Promise<{ readonly code: number | null; readonly stderr: string }>((resolve) => {
    execFile(TSX, [MAIN], { env, timeout: 30_000 }, (error, _stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stderr });
    });
  });
}

it("TOOL_SECRET_KEY 没设或留空时控制面拒绝启动，报错点名这个变量", async () => {
  const missing = await start("TOOL_SECRET_KEY", "");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("TOOL_SECRET_KEY 没设，用 openssl rand -hex 32 生成一个");

  const blank = await start(null, "  ");
  expect(blank.code).toBe(1);
  expect(blank.stderr).toContain("TOOL_SECRET_KEY 没设，用 openssl rand -hex 32 生成一个");
});

it("CREDENTIALS_KEY 没设时控制面同样拒绝启动", async () => {
  const result = await start("CREDENTIALS_KEY", randomBytes(32).toString("hex"));
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("CREDENTIALS_KEY 没设，用 openssl rand -base64 32 生成一个");
});
