import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, expect, it, vi } from "vitest";
import { databaseUrl } from "../src/env.js";

vi.setConfig({ testTimeout: 120_000 });

const SCRIPT = fileURLToPath(new URL("../../../scripts/db-own.mjs", import.meta.url));

const dirs: string[] = [];
const databases: string[] = [];

afterEach(async () => {
  const admin = postgres(databaseUrl(), { max: 1, onnotice: () => undefined });
  try {
    for (const name of databases.splice(0)) await admin`DROP DATABASE IF EXISTS ${admin(name)} WITH (FORCE)`;
  } finally {
    await admin.end();
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function worktree(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "baize-db-own-"));
  dirs.push(parent);
  const dir = join(parent, name);
  await mkdir(dir);
  return dir;
}

function dbOwn(cwd: string, shellDatabaseUrl?: string): Promise<{ readonly code: number; readonly stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["DATABASE_URL"];
  if (shellDatabaseUrl !== undefined) env["DATABASE_URL"] = shellDatabaseUrl;
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout: stdout + stderr });
    });
  });
}

function urlOf(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

function entries(env: string, key: string): string[] {
  return env
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

async function seededEmails(name: string): Promise<string[]> {
  const sql = postgres(urlOf(name), { max: 1 });
  try {
    const rows = await sql<{ email: string }[]>`SELECT email FROM users`;
    return rows.map((row) => row.email);
  } finally {
    await sql.end();
  }
}

it("db:own 在工作树里建自己的库、迁移、seed，DATABASE_URL 和电脑 token 写进 .env；重跑收敛", async () => {
  const dir = await worktree(`Lane.Dev-${Date.now()}`);
  const name = `baize_${basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "_")}`;
  databases.push(name);
  await writeFile(
    join(dir, ".env"),
    `# 本地配置\nDATABASE_URL=${databaseUrl()}\nPORT=4567\nUPSTREAM_API_KEY="sk-keep"\n`,
  );

  const first = await dbOwn(dir);
  expect(first.code, first.stdout).toBe(0);
  expect(first.stdout).toContain(`建了库 ${name}`);
  expect(first.stdout).toContain("下一步：pnpm dev");
  expect(await seededEmails(name), "迁移和 seed 落在新库里").toEqual(["chen@baize.dev"]);

  const env = await readFile(join(dir, ".env"), "utf8");
  expect(entries(env, "DATABASE_URL")).toEqual([urlOf(name)]);
  expect(entries(env, "COMPUTER_ID")).toHaveLength(1);
  expect(entries(env, "AGENT_TOKEN")).toHaveLength(1);
  expect(entries(env, "AGENT_TOKEN")[0]).not.toBe("");
  expect(env, "别的行原样留着").toContain("# 本地配置\n");
  expect(env).toContain('PORT=4567\nUPSTREAM_API_KEY="sk-keep"\n');

  const second = await dbOwn(dir);
  expect(second.code, second.stdout).toBe(0);
  expect(second.stdout).toContain(`库 ${name} 已在`);
  expect(await readFile(join(dir, ".env"), "utf8"), "第二遍不改 .env").toBe(env);
});

it("db:own 发现 .env 里的电脑不是这个库的，重置一把 token 换上", async () => {
  const dir = await worktree(`lane-${Date.now()}`);
  const name = `baize_${basename(dir).replace(/-/gu, "_")}`;
  databases.push(name);
  await writeFile(join(dir, ".env"), `DATABASE_URL=${databaseUrl()}\n`);
  expect((await dbOwn(dir)).code).toBe(0);
  const seeded = await readFile(join(dir, ".env"), "utf8");
  const copied = seeded
    .replace(/^COMPUTER_ID=.*$/mu, "COMPUTER_ID=from-another-checkout")
    .replace(/^AGENT_TOKEN=.*$/mu, "AGENT_TOKEN=stale");
  await writeFile(join(dir, ".env"), copied);

  const rerun = await dbOwn(dir);
  expect(rerun.code, rerun.stdout).toBe(0);
  const env = await readFile(join(dir, ".env"), "utf8");
  expect(entries(env, "COMPUTER_ID")).toEqual(entries(seeded, "COMPUTER_ID"));
  expect(entries(env, "AGENT_TOKEN")).toHaveLength(1);
  expect(entries(env, "AGENT_TOKEN")).not.toEqual(["stale"]);
  expect(entries(env, "AGENT_TOKEN")).not.toEqual(entries(seeded, "AGENT_TOKEN"));
});

it("db:own 目录名太长：库名截到 63 字节、带短哈希；没有 .env 就从 .env.example 拷", async () => {
  const dir = await worktree(`very-long-worktree-name-${"x".repeat(60)}-${Date.now()}`);
  const shellUrl = databaseUrl();

  const result = await dbOwn(dir, shellUrl);
  expect(result.code, result.stdout).toBe(0);
  const name = /建了库 (\S+)/u.exec(result.stdout)?.[1] ?? "";
  if (name !== "") databases.push(name);
  expect(name).toHaveLength(63);
  expect(name).toMatch(/^baize_very_long_worktree_name_x+_[0-9a-f]{8}$/u);
  expect(result.stdout).toContain("没有 .env，从 .env.example 拷了一份");
  expect(result.stdout, "shell 的 DATABASE_URL 压着 .env，要提醒").toContain("先 unset DATABASE_URL");

  const env = await readFile(join(dir, ".env"), "utf8");
  expect(entries(env, "DATABASE_URL")).toEqual([urlOf(name)]);
  expect(entries(env, "GATEWAY_MODELS")).toEqual(["plan=baize-default,fast=baize-default"]);
});
