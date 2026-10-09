import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { supervise, type SupervisorHandle } from "../src/supervisor.js";

const FORBIDDEN_ENV = ["COMPUTER_ID", "AGENT_TOKEN", "CONTROL_PLANE_AGENT_URL", "BAIZE_DATA_DIR"] as const;

const directories: string[] = [];
const children: ChildProcessByStdio<null, Readable, Readable>[] = [];
const handles: SupervisorHandle[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "baize-supervisor-test-"));
  directories.push(directory);
  return directory;
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of FORBIDDEN_ENV) delete env[key];
  return { ...env, ...extra };
}

async function writeLaunch(path: string, launch: object, mode: number): Promise<string> {
  const contents = `${JSON.stringify(launch)}\n`;
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  return contents;
}

type Hello = { readonly type: "hello"; readonly token: string; readonly computerId: string };

async function startWelcomeServer(): Promise<{ readonly url: string; readonly hellos: Hello[] }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const hellos: Hello[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type !== "hello") return;
      hellos.push(message as Hello);
      socket.send(
        JSON.stringify({ type: "welcome", ownerId: "owner-1", kind: "remote", serverTime: new Date().toISOString() }),
      );
    });
  });
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/agent`, hellos };
}

type Entry = {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  output(): string;
  exited(): Promise<string>;
};

function spawnEntry(launchFile: string, env: NodeJS.ProcessEnv): Entry {
  const child = spawn("./node_modules/.bin/tsx", ["src/supervise.ts", launchFile], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<string>((resolve) =>
    child.once("exit", (code, signal) => resolve(`退出 ${String(code ?? signal)}`)),
  );
  return { child, output: () => output, exited: () => exit };
}

async function poll<T>(
  get: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
  output: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs}ms 还没等到${label}\n${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("看护进程", () => {
  it("启动文件读完即删，权限是 600，代理用文件里的 token 连上控制面", async () => {
    const server = await startWelcomeServer();
    const directory = await tempDir();
    const launchFile = join(directory, "launch.json");
    await writeLaunch(
      launchFile,
      { url: server.url, computerId: "computer-remote", token: "token-from-file", dataDir: join(directory, "bots") },
      0o600,
    );
    expect((await lstat(launchFile)).mode & 0o777, "前提：启动文件是 600").toBe(0o600);

    const entry = spawnEntry(launchFile, cleanEnv());
    const hello = await poll(() => server.hellos[0], 30_000, "代理的 hello", entry.output);

    expect(hello).toMatchObject({ computerId: "computer-remote", token: "token-from-file" });
    expect(existsSync(launchFile), "代理连上时启动文件已经删了").toBe(false);

    entry.child.kill("SIGTERM");
    await expect(entry.exited()).resolves.toBe("退出 0");
  }, 60_000);

  it.each([
    ["644", 0o644],
    ["640", 0o640],
    ["400", 0o400],
    ["700", 0o700],
  ])(
    "权限是 %s 的启动文件拒绝启动，文件原样留着",
    async (_label, mode) => {
      const server = await startWelcomeServer();
      const directory = await tempDir();
      const launchFile = join(directory, "launch.json");
      const contents = await writeLaunch(
        launchFile,
        { url: server.url, computerId: "computer-remote", token: "token-from-file", dataDir: join(directory, "bots") },
        mode,
      );

      const entry = spawnEntry(launchFile, cleanEnv());

      await expect(entry.exited()).resolves.toBe("退出 1");
      expect(entry.output()).toContain("权限必须是 600");
      expect(await readFile(launchFile, "utf8"), "文件内容没动").toBe(contents);
      expect((await lstat(launchFile)).mode & 0o777, "权限没被改").toBe(mode);
      expect(server.hellos, "代理没起来").toEqual([]);
    },
    30_000,
  );

  it("启动文件是符号链接时拒绝启动，链接和目标都留着", async () => {
    const directory = await tempDir();
    const target = join(directory, "real.json");
    const contents = await writeLaunch(
      target,
      { url: "ws://127.0.0.1:1/agent", computerId: "computer-remote", token: "token-from-file", dataDir: directory },
      0o600,
    );
    const launchFile = join(directory, "launch.json");
    await symlink(target, launchFile);

    const entry = spawnEntry(launchFile, cleanEnv());

    await expect(entry.exited()).resolves.toBe("退出 1");
    expect(entry.output()).toContain("不是普通文件");
    expect((await lstat(launchFile)).isSymbolicLink(), "链接还在").toBe(true);
    expect(await readFile(target, "utf8"), "目标没动").toBe(contents);
  }, 30_000);

  it("代理退出后看护进程重启它，第二次仍从 stdin 拿到同一份启动配置", async () => {
    const directory = await tempDir();
    const launchFile = join(directory, "launch.json");
    const record = join(directory, "record.jsonl");
    const launch = {
      url: "ws://127.0.0.1:1/agent",
      computerId: "computer-remote",
      token: "token-from-file",
      dataDir: directory,
    };
    await writeLaunch(launchFile, launch, 0o600);
    const fixture = fileURLToPath(new URL("fixtures/stdin-agent.ts", import.meta.url));

    handles.push(
      await supervise({
        launchFile,
        env: cleanEnv(),
        agentCommand: [process.execPath, "--import", "tsx", fixture, record],
        backoff: { initialMs: 20, maxMs: 100, factor: 2 },
        log: () => {},
      }),
    );
    const lines = await poll(
      async () => {
        const recorded = existsSync(record) ? (await readFile(record, "utf8")).split("\n").filter(Boolean) : [];
        return recorded.length >= 2 ? recorded : undefined;
      },
      30_000,
      "代理第二次起来",
    );

    expect(lines.map((line) => (JSON.parse(line) as { line: string }).line)).toEqual([
      JSON.stringify(launch),
      JSON.stringify(launch),
    ]);
    expect(existsSync(launchFile), "启动文件只读一次，第一次起代理前就删了").toBe(false);
  }, 60_000);

  it("代理的环境只有白名单里的变量，没有那四个", async () => {
    const directory = await tempDir();
    const launchFile = join(directory, "launch.json");
    const record = join(directory, "record.jsonl");
    await writeLaunch(
      launchFile,
      { url: "ws://127.0.0.1:1/agent", computerId: "computer-remote", token: "token-from-file", dataDir: directory },
      0o600,
    );
    const fixture = fileURLToPath(new URL("fixtures/stdin-agent.ts", import.meta.url));

    handles.push(
      await supervise({
        launchFile,
        env: cleanEnv({ DISPLAY: ":99", BAIZE_CANARY: "不该传下去" }),
        agentCommand: [process.execPath, "--import", "tsx", fixture, record],
        log: () => {},
      }),
    );
    const line = await poll(
      async () => (existsSync(record) ? (await readFile(record, "utf8")).split("\n")[0] || undefined : undefined),
      30_000,
      "代理记下环境",
    );
    const { envKeys } = JSON.parse(line) as { envKeys: string[] };

    expect(envKeys.filter((key) => (FORBIDDEN_ENV as readonly string[]).includes(key))).toEqual([]);
    expect(envKeys, "Chrome 要用的 DISPLAY 传下去了").toContain("DISPLAY");
    expect(envKeys, "白名单外的变量不传").not.toContain("BAIZE_CANARY");
  }, 60_000);

  it.each(FORBIDDEN_ENV)(
    "看护进程环境里有 %s 就拒绝启动，启动文件不碰",
    async (name) => {
      const directory = await tempDir();
      const launchFile = join(directory, "launch.json");
      const contents = await writeLaunch(
        launchFile,
        { url: "ws://127.0.0.1:1/agent", computerId: "computer-remote", token: "token-from-file", dataDir: directory },
        0o600,
      );

      const entry = spawnEntry(launchFile, cleanEnv({ [name]: "x" }));

      await expect(entry.exited()).resolves.toBe("退出 1");
      expect(entry.output()).toContain(name);
      expect(await readFile(launchFile, "utf8"), "启动文件没被读走").toBe(contents);
    },
    30_000,
  );
});
