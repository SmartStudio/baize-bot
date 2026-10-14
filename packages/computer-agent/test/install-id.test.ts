import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const readBarrier = vi.hoisted(() => ({
  path: "",
  arrivals: 0,
  release: null as (() => void) | null,
  wait: null as Promise<void> | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      try {
        return await actual.readFile(...args);
      } catch (error) {
        if (
          readBarrier.wait !== null &&
          String(args[0]) === readBarrier.path &&
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          readBarrier.arrivals < 2
        ) {
          readBarrier.arrivals += 1;
          if (readBarrier.arrivals === 2) readBarrier.release?.();
          await readBarrier.wait;
        }
        throw error;
      }
    },
  };
});

import { loadInstallId } from "../src/install-id.js";

const dataDirs: string[] = [];

afterEach(async () => {
  readBarrier.path = "";
  readBarrier.arrivals = 0;
  readBarrier.release = null;
  readBarrier.wait = null;
  await Promise.all(dataDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "baize-install-id-test-"));
  dataDirs.push(directory);
  return directory;
}

describe("安装标识", () => {
  it("两个并发首次调用共用一个 UUID，目录中只留下安装标识文件", async () => {
    const dataDir = await createDataDir();
    const agentDir = join(dataDir, ".agent");
    const installIdPath = join(agentDir, "install-id");
    let release!: () => void;
    readBarrier.path = installIdPath;
    readBarrier.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    readBarrier.release = release;

    const ids = await Promise.all([loadInstallId(dataDir), loadInstallId(dataDir)]);

    expect(readBarrier.arrivals).toBe(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ids[1]).toBe(ids[0]);
    expect(await readdir(agentDir)).toEqual(["install-id"]);
    expect(await readFile(installIdPath, "utf8")).toBe(`${ids[0]}\n`);
  });

  it("已有内容不是 UUID 时抛错并保留原字节和目录文件", async () => {
    const dataDir = await createDataDir();
    const agentDir = join(dataDir, ".agent");
    const installIdPath = join(agentDir, "install-id");
    const originalBytes = Buffer.from([0x6c, 0x65, 0x67, 0x61, 0x63, 0x79, 0xff, 0x0a]);
    await mkdir(agentDir, { recursive: true });
    await writeFile(installIdPath, originalBytes);
    await writeFile(join(agentDir, "keep.txt"), "keep\n");

    await expect(loadInstallId(dataDir)).rejects.toThrow();

    expect(await readFile(installIdPath)).toEqual(originalBytes);
    expect((await readdir(agentDir)).toSorted()).toEqual(["install-id", "keep.txt"]);
  });
});
