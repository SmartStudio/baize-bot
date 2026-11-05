import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, profileChromePids, reapProfileChromes, terminate } from "../src/chrome-process.js";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// 真 Chrome 起一次要几秒，这里用 node 冒名：可执行文件路径和 argv 跟 Chrome 主进程在 ps 里长得一样。
async function fakeChromeExecutable(
  layout: readonly string[],
): Promise<{ readonly root: string; readonly executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "baize-chrome-process-test-"));
  directories.push(root);
  const executable = join(root, ...layout);
  await mkdir(dirname(executable), { recursive: true });
  await symlink(process.execPath, executable);
  return { root, executable };
}

async function startFake(executable: string, args: readonly string[]): Promise<number> {
  const child = spawn(executable, ["-e", "setInterval(() => {}, 1e6)", "--", ...args], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("假 Chrome 没有 PID");
  return child.pid;
}

describe("按 profile 认助理 Chrome", () => {
  it.each([
    ["macOS 的 Google Chrome", ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"]],
    ["Debian 的 chromium", ["usr", "lib", "chromium", "chromium"]],
  ])("%s：只认 --user-data-dir 整个参数等于 profile 的主进程，回收后只剩别人的", async (_label, layout) => {
    const { root, executable } = await fakeChromeExecutable(layout);
    const profileDir = join(root, "Application Support", "chrome-profile");
    const mine = await startFake(executable, [`--user-data-dir=${profileDir}`, "--no-first-run"]);
    const mineLast = await startFake(executable, [`--user-data-dir=${profileDir}`]);
    const renderer = await startFake(executable, ["--type=renderer", `--user-data-dir=${profileDir}`]);
    const sibling = await startFake(executable, [`--user-data-dir=${profileDir}-old`]);
    const nested = await startFake(executable, [`--user-data-dir=${join(profileDir, "Default")}`]);

    expect(await profileChromePids(profileDir), "同 profile 的两个主进程，不含渲染器和相邻目录").toEqual(
      [mine, mineLast].toSorted((left, right) => left - right),
    );

    const reaped = await reapProfileChromes(profileDir);

    expect(reaped.toSorted((left, right) => left - right)).toEqual(
      [mine, mineLast].toSorted((left, right) => left - right),
    );
    expect(isAlive(mine), "本 profile 的主进程被收掉").toBe(false);
    expect(isAlive(mineLast), "参数在行尾的也被收掉").toBe(false);
    expect(
      [renderer, sibling, nested].map((pid) => isAlive(pid)),
      "渲染器、chrome-profile-old、子目录都不动",
    ).toEqual([true, true, true]);
    expect(await profileChromePids(profileDir)).toEqual([]);
  });
});

const LINGERING_CHILD = `
const { writeFileSync } = require("node:fs");
const [parent, marker] = process.argv.slice(1);
const gone = () => { try { process.kill(Number(parent), 0); return false; } catch { return true; } };
const timer = setInterval(() => {
  if (!gone()) return;
  clearInterval(timer);
  setTimeout(() => writeFileSync(marker, "flushed"), 300);
}, 20);
`;

const FAKE_MAIN = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", process.argv[1], String(process.pid), process.argv[2]], { stdio: "ignore" });
process.stdout.write(String(child.pid));
setInterval(() => {}, 1e6);
`;

// 子进程过继给 init 后、收尸前是僵尸，kill(pid, 0) 照样成功，可它已经不会再写 profile 了。
function stillRunning(pid: number): boolean {
  const stat = execFileSync("ps", ["-ax", "-o", "pid=,stat="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([found]) => Number(found) === pid)?.[1];
  return stat !== undefined && !stat.startsWith("Z");
}

describe("收掉助理 Chrome", () => {
  it("主进程退了不算完，等同组的子进程写完退掉才回来", async () => {
    const root = await mkdtemp(join(tmpdir(), "baize-chrome-group-test-"));
    directories.push(root);
    const marker = join(root, "flushed");
    const main = spawn(process.execPath, ["-e", FAKE_MAIN, LINGERING_CHILD, marker], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(main);
    const childPid = await new Promise<number>((resolve) =>
      main.stdout?.once("data", (chunk) => resolve(Number(chunk))),
    );
    if (main.pid === undefined) throw new Error("假 Chrome 没有 PID");

    await terminate(main.pid);

    expect(isAlive(main.pid), "主进程退了").toBe(false);
    expect(stillRunning(childPid), "同组的子进程也退了").toBe(false);
    expect(existsSync(marker), "子进程退之前写完了").toBe(true);
  });
});
