import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAlive, profileChromePids, reapProfileChromes } from "../src/chrome-process.js";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// 真 Chrome 起一次要几秒，这里用 node 冒名：可执行文件路径和 argv 跟 Chrome 主进程在 ps 里长得一样。
async function fakeChromeExecutable(): Promise<{ readonly root: string; readonly executable: string }> {
  const root = await mkdtemp(join(tmpdir(), "baize-chrome-process-test-"));
  directories.push(root);
  const macos = join(root, "Google Chrome.app", "Contents", "MacOS");
  await mkdir(macos, { recursive: true });
  const executable = join(macos, "Google Chrome");
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
  it("只认 --user-data-dir 整个参数等于 profile 的主进程，回收后只剩别人的", async () => {
    const { root, executable } = await fakeChromeExecutable();
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
