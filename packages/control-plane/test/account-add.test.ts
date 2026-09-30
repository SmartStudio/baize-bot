import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../src/scripts/account-add.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** 不给钥匙、库指向连不上的端口：过了参数校验的也只会停在「CREDENTIALS_KEY 没设」，碰不到任何库。 */
function accountAdd(token: string): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://baize:baize@127.0.0.1:1/none" };
  delete env["CREDENTIALS_KEY"];
  const args = [SCRIPT, "--owner", "chen@baize.dev", "--platform", "github", "--handle", "baize-dev", "--token", token];
  return new Promise((resolve) => {
    execFile(TSX, args, { env }, (error, _stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stderr });
    });
  });
}

const REFUSED = "令牌含反斜杠、百分号、控制字符或非 ASCII 字符，不收";

it.each([
  { name: "十二个连续反斜杠", token: `ghu_${"\\".repeat(12)}X` },
  { name: "十二个连续百分号", token: `ghu_${"%".repeat(12)}X` },
  { name: "控制字符", token: "ghu_a\u0001b" },
  { name: "Latin-1 字符", token: "ghu_toké" },
])("account-add 挂含$name的令牌：入口就拒，和令牌端点同一道校验", async ({ token }) => {
  const result = await accountAdd(token);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(REFUSED);
});

it("account-add 挂正常令牌：过了字符校验，往下走到读钥匙", async () => {
  const result = await accountAdd("ghu_p1/5+fix=two");
  expect(result.stderr, "斜杠、加号、等号不算不安全").not.toContain(REFUSED);
  expect(result.stderr).toContain("CREDENTIALS_KEY 没设");
});
