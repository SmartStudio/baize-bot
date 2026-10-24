import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const worktree = process.cwd();
const envPath = join(worktree, ".env");
const postgres = createRequire(join(root, "packages/control-plane/package.json"))("postgres");

const DEFAULT_DATABASE_URL = "postgres://baize:baize@localhost:5434/baize";
const MAX_IDENTIFIER_BYTES = 63;
const DUPLICATE_DATABASE = "42P04";
const ENV_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function databaseNameOf(dir) {
  const name = `baize_${dir.toLowerCase().replace(/[^a-z0-9]/gu, "_")}`;
  if (name.length <= MAX_IDENTIFIER_BYTES) return name;
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER_BYTES - hash.length - 1)}_${hash}`;
}

function valueOf(lines, key) {
  for (const line of lines) {
    const match = ENV_LINE.exec(line);
    if (match?.[1] === key) return match[2].trim().replace(/^["']|["']$/gu, "");
  }
  return undefined;
}

function withValue(lines, key, value) {
  const out = [];
  let written = false;
  for (const line of lines) {
    if (ENV_LINE.exec(line)?.[1] !== key) {
      out.push(line);
    } else if (!written) {
      out.push(`${key}=${value}`);
      written = true;
    }
  }
  if (written) return out;
  const end = out.length > 0 && out.at(-1) === "" ? out.length - 1 : out.length;
  return [...out.slice(0, end), `${key}=${value}`, ...out.slice(end)];
}

function controlPlane(script, databaseUrl) {
  const result = spawnSync("pnpm", ["--silent", "--filter", "@baize/control-plane", script], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    console.error(`pnpm --filter @baize/control-plane ${script} 失败，code ${result.status ?? result.signal}`);
    process.exit(1);
  }
  return result.stdout.split("\n");
}

if (!existsSync(envPath)) {
  copyFileSync(join(root, ".env.example"), envPath);
  console.log("没有 .env，从 .env.example 拷了一份");
}
let lines = readFileSync(envPath, "utf8").split("\n");

const shellUrl = process.env.DATABASE_URL?.trim() || undefined;
const serverUrl = new URL(shellUrl ?? (valueOf(lines, "DATABASE_URL") || DEFAULT_DATABASE_URL));
const databaseName = databaseNameOf(basename(worktree));
const ownUrl = new URL(serverUrl);
ownUrl.pathname = `/${databaseName}`;
const adminUrl = new URL(serverUrl);
adminUrl.pathname = "/postgres";

const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
try {
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  console.log(`建了库 ${databaseName}`);
} catch (error) {
  if (error?.code !== DUPLICATE_DATABASE) throw error;
  console.log(`库 ${databaseName} 已在`);
} finally {
  await admin.end();
}

lines = withValue(lines, "DATABASE_URL", ownUrl.toString());
writeFileSync(envPath, lines.join("\n"));

controlPlane("migrate", ownUrl.toString());
const seeded = controlPlane("seed", ownUrl.toString());
let computerId = valueOf(seeded, "COMPUTER_ID");
let token = valueOf(seeded, "AGENT_TOKEN");
const envHoldsThisComputer = valueOf(lines, "COMPUTER_ID") === computerId && !!valueOf(lines, "AGENT_TOKEN");
if (token === undefined && !envHoldsThisComputer) {
  const reset = controlPlane("computer-token", ownUrl.toString());
  computerId = valueOf(reset, "COMPUTER_ID");
  token = valueOf(reset, "AGENT_TOKEN");
} else if (token === undefined) {
  console.log("AGENT_TOKEN 沿用 .env 里那把");
}
if (computerId === undefined) throw new Error("seed 没打印 COMPUTER_ID");
lines = withValue(lines, "COMPUTER_ID", computerId);
if (token !== undefined) lines = withValue(lines, "AGENT_TOKEN", token);
writeFileSync(envPath, lines.join("\n"));

console.log(`\n这个工作树用库 ${databaseName}，.env 的 DATABASE_URL、COMPUTER_ID、AGENT_TOKEN 已写好`);
if (shellUrl !== undefined) console.log("shell 里设了 DATABASE_URL，它比 .env 优先，先 unset DATABASE_URL");
const missingKeys = ["CREDENTIALS_KEY", "TOOL_SECRET_KEY"].filter((key) => !valueOf(lines, key));
if (missingKeys.length > 0)
  console.log(`.env 里 ${missingKeys.join("、")} 还空着，填上才起得来，见 docs/开发.md「跑起来」`);
console.log("下一步：pnpm dev");
