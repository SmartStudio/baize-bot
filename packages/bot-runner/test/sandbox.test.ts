import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComputerId, GroupId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide } from "../src/gate.js";
import { bwrapArgs, createSandboxedBash, sandboxKind, sandboxProfile, whitelistEnv } from "../src/sandbox.js";

// 照运行器的布局 <dataDir>/<botId>/work：bwrap 把数据目录下别的目录都当别的 Bot 盖住。
const dataDir = mkdtempSync(join(tmpdir(), "baize-sandbox-perf-"));
const workDir = join(dataDir, "bot-1", "work");
mkdirSync(workDir, { recursive: true });

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const p95 = (values: readonly number[]): number =>
  values.toSorted((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

const processesWith = (marker: string): string[] => {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split("\n").filter((line) => line.includes(marker));
};

const until = async (ready: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`等了 5000ms 还没等到${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("没有拿到本地测试端口"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

const runInSandbox = (command: string, network = false) =>
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", sandboxProfile(workDir, { network, writePaths: [] }), "/bin/bash", "-c", command],
    {
      cwd: workDir,
      encoding: "utf8",
      env: whitelistEnv(process.env, workDir, join(workDir, ".tmp")),
    },
  );

describe("bash 沙箱性能", () => {
  it.skipIf(process.platform !== "darwin")("放宽禁区祖先写权限后仍不能写禁区", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "baize-sandbox-forbidden-"));
    try {
      const nestedWorkDir = join(sandboxRoot, "bot-1", "work");
      const forbiddenDir = join(sandboxRoot, "chrome-profile");
      const leaked = join(forbiddenDir, "leaked.txt");
      mkdirSync(nestedWorkDir, { recursive: true });
      mkdirSync(forbiddenDir);
      const profile = sandboxProfile(nestedWorkDir, { network: false, writePaths: [sandboxRoot] });
      const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/touch", leaked], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(leaked)).toBe(false);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("mach-lookup 白名单支持常用 CLI，curl 走受控报错路径", () => {
    const git = spawnSync("/usr/bin/which", ["git"], { encoding: "utf8" }).stdout.trim();
    const python = spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).stdout.trim();
    const probes = [
      ["git status", `${shellQuote(git)} -C ${shellQuote(process.cwd())} status --short`, 0],
      ["node -e", `${shellQuote(process.execPath)} -e 'process.stdout.write("node-ok")'`, 0],
      ["python3 -c", `${shellQuote(python)} -c 'print("python-ok")'`, 0],
      ["/dev/null", "echo ok > /dev/null", 0],
      ["/dev/stdout", "echo ok > /dev/stdout", 0],
      ["/dev/stderr", "echo ok > /dev/stderr", 0],
      ["curl 断网报错", "/usr/bin/curl -fsS --max-time 2 https://example.com/", 1],
    ] as const;
    for (const [label, command, expected] of probes) {
      const result = runInSandbox(command);
      if (expected === 0) expect(result.status, `${label}: ${result.stderr}`).toBe(0);
      else expect(result.status, label).not.toBe(0);
    }
  });

  it.skipIf(process.platform !== "darwin")("默认禁外网、DNS、回环和本地代理，network 放宽时回环一起开放", async () => {
    const port = await availablePort();
    const python = spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).stdout.trim();
    const server = spawn(python, ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: workDir,
      stdio: "ignore",
    });
    try {
      await until(
        () => spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "1", `http://127.0.0.1:${port}/`]).status === 0,
        "本地 HTTP 服务启动",
      );
      const probes = [
        ["外网", "/usr/bin/curl -fsS --max-time 2 https://example.com/"],
        ["DNS", "/usr/bin/dig +time=1 +tries=1 @8.8.8.8 example.com"],
        ["回环", `/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:${port}/`],
        [
          "本地代理端口",
          `/usr/bin/curl -fsS --max-time 2 --noproxy '' --proxy http://127.0.0.1:${port} http://example.com/`,
        ],
      ] as const;
      const rows = probes.map(([label, command]) => {
        const result = runInSandbox(command);
        expect(result.status, label).not.toBe(0);
        return `${label}=exit ${result.status}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? ""}`;
      });
      const relaxed = runInSandbox(`/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:${port}/`, true);
      expect(relaxed.status, relaxed.stderr).toBe(0);
      console.info(`P1-3 断网原型：${rows.join("；")}；network 放宽回环=exit ${relaxed.status}`);
    } finally {
      server.kill("SIGTERM");
    }
  });

  it.skipIf(process.platform !== "darwin")("echo ok 100 次，闸门加沙箱的 p95 增量不超过 50ms", async () => {
    const baseline = createBashToolDefinition(workDir, { exposeSessionEnvironment: false });
    const sandbox = createSandboxedBash(workDir).tool;
    const baselineTimes: number[] = [];
    const sandboxTimes: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      await baseline.execute(`baseline-${index}`, { command: "echo ok" }, undefined, undefined, undefined as never);
      baselineTimes.push(performance.now() - startedAt);
    }
    for (let index = 0; index < 100; index += 1) {
      const startedAt = performance.now();
      const decision = decide(
        {
          toolName: "bash",
          input: { command: "echo ok" },
          workDir,
          groupId: GroupId.parse("group-1"),
          computerId: ComputerId.parse("computer-1"),
          platform: process.platform,
          sandbox: sandboxKind(),
          mcpOperation: null,
        },
        [],
        [],
      );
      expect(decision.verdict).toBe("allow");
      await sandbox.execute(`sandbox-${index}`, { command: "echo ok" }, undefined, undefined, undefined as never);
      sandboxTimes.push(performance.now() - startedAt);
    }

    const baselineP95 = p95(baselineTimes);
    const sandboxP95 = p95(sandboxTimes);
    console.info(
      `P1-3 性能：不过闸门 ${baselineP95.toFixed(3)}ms；闸门加沙箱 ${sandboxP95.toFixed(3)}ms；增量 ${(sandboxP95 - baselineP95).toFixed(3)}ms`,
    );
    expect(sandboxP95 - baselineP95).toBeLessThanOrEqual(50);
  });

  it("沙箱外的环境变量白名单只保留基础变量和 PI_ 前缀", () => {
    expect(
      whitelistEnv(
        {
          PATH: "/bin",
          HOME: "/Users/test",
          DISPLAY: ":99",
          BAIZE_GATE_SENTINEL: "secret",
          PI_SESSION_ID: "session-1",
        },
        "/work",
        "/work/.tmp",
      ),
    ).toEqual({ PATH: "/bin", HOME: "/Users/test", PI_SESSION_ID: "session-1", PWD: "/work", TMPDIR: "/work/.tmp" });
  });

  it.skipIf(process.platform !== "darwin")(
    "放宽按 runId 和 callId 隔离，清理或空 access 不会泄到复用 callId",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "baize-sandbox-access-"));
      let runId = "run-1";
      const sandbox = createSandboxedBash(workDir, () => runId);
      try {
        sandbox.allow(runId, "same-call", { network: false, writePaths: [outside] });
        sandbox.clearRun(runId);
        runId = "run-2";
        const afterClear = join(outside, "after-clear.txt");
        await expect(
          sandbox.tool.execute(
            "same-call",
            { command: `/usr/bin/touch ${shellQuote(afterClear)}` },
            undefined,
            undefined,
            undefined as never,
          ),
        ).rejects.toThrow("Operation not permitted");
        expect(existsSync(afterClear)).toBe(false);

        sandbox.allow(runId, "same-call", { network: false, writePaths: [outside] });
        sandbox.allow(runId, "same-call", { network: false, writePaths: [] });
        const afterEmpty = join(outside, "after-empty.txt");
        await expect(
          sandbox.tool.execute(
            "same-call",
            { command: `/usr/bin/touch ${shellQuote(afterEmpty)}` },
            undefined,
            undefined,
            undefined as never,
          ),
        ).rejects.toThrow("Operation not permitted");
        expect(existsSync(afterEmpty)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(sandboxKind() === "none")("abort 会杀掉沙箱里的整棵进程树", async () => {
    const marker = `baize-p1-3-${Date.now()}`;
    const child = `process.title=${JSON.stringify(`${marker}-child`)};setInterval(()=>{},1000)`;
    const parent = [
      `process.title=${JSON.stringify(`${marker}-parent`)}`,
      `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"ignore"})`,
      "setInterval(()=>{},1000)",
    ].join(";");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(parent)}`;
    const controller = new AbortController();
    const tool = createSandboxedBash(workDir).tool;
    const running = tool.execute("process-group", { command }, controller.signal, undefined, undefined as never);
    try {
      await until(() => processesWith(marker).length >= 2, "父子进程都启动");
      const before = processesWith(marker);
      controller.abort();
      await expect(running).rejects.toThrow("Command aborted");
      await until(() => processesWith(marker).length === 0, "父子进程都退出");

      // bwrap 带 --new-session，沙箱里的进程另起一个会话，靠 --die-with-parent 和 pid 命名空间跟着收掉。
      if (sandboxKind() === "seatbelt") {
        const groups = new Set(before.map((line) => line.trim().split(/\s+/)[1]));
        expect(groups.size).toBe(1);
      }
    } finally {
      controller.abort();
      await running.catch(() => undefined);
      for (const line of processesWith(marker)) {
        const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
        if (Number.isInteger(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });
});

describe("bwrap 参数", () => {
  it("bwrap 参数：禁区盖在最上面，批准的写路径可写，批准 network 时不断网", () => {
    const work = "/data/bot-1/work";
    const forbidden = ["/home/node/.ssh", "/data/bot-1/work/.ssh", "/data/bot-2", "/outside/chrome-profile"];
    expect(bwrapArgs(work, { network: false, writePaths: ["/outside"] }, forbidden)).toEqual([
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      work,
      work,
      "--bind",
      "/outside",
      "/outside",
      "--tmpfs",
      "/home/node/.ssh",
      "--tmpfs",
      "/data/bot-1/work/.ssh",
      "--tmpfs",
      "/data/bot-2",
      "--tmpfs",
      "/outside/chrome-profile",
      "--remount-ro",
      "/home/node/.ssh",
      "--remount-ro",
      "/data/bot-1/work/.ssh",
      "--remount-ro",
      "/data/bot-2",
      "--remount-ro",
      "/outside/chrome-profile",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--unshare-net",
      "--chdir",
      work,
    ]);
    const networked = bwrapArgs(work, { network: true, writePaths: [] }, forbidden);
    expect(networked, "批准 network 的那一次和容器共用网络").not.toContain("--unshare-net");
    expect(networked, "docker 遮住了部分 /proc，新挂 proc 会失败").not.toContain("--proc");
  });
});

const hasBwrap = sandboxKind() === "bwrap";

describe.skipIf(!hasBwrap)("bwrap 沙箱", () => {
  const realHome = process.env["HOME"];
  const runId = "run-bwrap";
  // 不放在 /tmp 下：沙箱里的 /tmp 是一块私有 tmpfs，写进去不算写出沙箱，也看不见外面的文件。
  // 数据目录下除自己以外的目录都当别的 Bot 盖住，所以家目录和 outside 放在数据目录旁边。
  let root = "";
  let botWork = "";
  let otherBot = "";
  let fakeHome = "";
  let outside = "";
  let callSeq = 0;
  let sandbox!: ReturnType<typeof createSandboxedBash>;
  const nextCall = (): string => `bwrap-${(callSeq += 1)}`;
  const run = (command: string, callId = nextCall()) =>
    sandbox.tool.execute(callId, { command }, undefined, undefined, undefined as never);

  beforeAll(() => {
    root = mkdtempSync(join(homedir(), ".baize-bwrap-test-"));
    botWork = join(root, "data", "bot-1", "work");
    otherBot = join(root, "data", "bot-2");
    fakeHome = join(root, "home");
    outside = join(root, "outside");
    for (const dir of [botWork, otherBot, join(fakeHome, ".ssh"), outside]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_test"), "ssh-secret-p1-6");
    writeFileSync(join(otherBot, "secret.txt"), "bot-2-secret-p1-6");
    symlinkSync(join(fakeHome, ".ssh"), join(botWork, "ssh-link"));
    symlinkSync(otherBot, join(botWork, "bot-2-link"));
    // homedir() 在 Linux 上读 HOME，禁区的 ~/.ssh 就落在临时家目录里，不碰真家目录。
    process.env["HOME"] = fakeHome;
    sandbox = createSandboxedBash(botWork, () => runId);
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = realHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("禁区的 ~/.ssh 落在临时家目录里", () => {
    expect(homedir()).toBe(fakeHome);
  });

  it.each([
    ["cat ~/.ssh", () => `cat ${shellQuote(join(fakeHome, ".ssh", "id_test"))}`],
    ["工作目录里指向 ~/.ssh 的符号链接", () => "cat ssh-link/id_test"],
    [
      "node 读 ~/.ssh",
      () =>
        `${shellQuote(process.execPath)} -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' ${shellQuote(join(fakeHome, ".ssh", "id_test"))}`,
    ],
    ["cat 别的 Bot 目录", () => `cat ${shellQuote(join(otherBot, "secret.txt"))}`],
    ["工作目录里指向别的 Bot 的符号链接", () => "cat bot-2-link/secret.txt"],
  ])("bwrap 下禁区读不到：%s", async (_label, command) => {
    const result = run(command());
    await expect(result).rejects.toThrow();
    await result.catch((error: unknown) => {
      expect(String(error)).not.toContain("secret-p1-6");
    });
  });

  it("bwrap 下工作目录外写不进，工作目录里能写", async () => {
    const outsideFile = join(outside, "leak.txt");
    const homeFile = join(fakeHome, "leak.txt");
    const otherBotFile = join(otherBot, "leak.txt");
    for (const target of [outsideFile, homeFile, otherBotFile]) {
      await expect(run(`echo leak > ${shellQuote(target)}`), target).rejects.toThrow();
      expect(existsSync(target), target).toBe(false);
    }
    await run("echo ok > inside.txt && mkdir -p nested && touch nested/b.txt");
    expect(readFileSync(join(botWork, "inside.txt"), "utf8")).toBe("ok\n");
    expect(existsSync(join(botWork, "nested", "b.txt"))).toBe(true);
  });

  it("bwrap 下批准的写路径这一次可写，禁区照样盖住", async () => {
    const approved = join(outside, "approved.txt");
    const callId = nextCall();
    sandbox.allow(runId, callId, { network: false, writePaths: [approved] });
    await run(`echo ok > ${shellQuote(approved)}`, callId);
    expect(readFileSync(approved, "utf8")).toBe("ok\n");
    await expect(run(`echo again > ${shellQuote(approved)}`), "放宽只管批准的那一次").rejects.toThrow();

    const widened = nextCall();
    sandbox.allow(runId, widened, { network: false, writePaths: [root] });
    await expect(run(`cat ${shellQuote(join(otherBot, "secret.txt"))}`, widened)).rejects.toThrow();
  });

  it.skipIf(!existsSync("/tmp/.X11-unix"))("bwrap 下批准写 /tmp 也看不到 X 的 socket 目录", async () => {
    const marker = join("/tmp/.X11-unix", `p1-6-runner-${process.pid}`);
    const approved = join("/tmp", `p1-6-runner-approved-${process.pid}.txt`);
    writeFileSync(marker, "");
    try {
      const callId = nextCall();
      sandbox.allow(runId, callId, { network: false, writePaths: [approved] });
      const result = await run(`echo ok > ${shellQuote(approved)} && ls -A /tmp/.X11-unix`, callId);
      expect(readFileSync(approved, "utf8"), "批准的 /tmp 写路径落到了真 /tmp").toBe("ok\n");
      expect(JSON.stringify(result.content)).not.toContain("p1-6-runner-");
    } finally {
      rmSync(marker, { force: true });
      rmSync(approved, { force: true });
    }
  });

  it("bwrap 下默认断网，批准 network 后通", async () => {
    const server = createHttpServer((_request, response) => response.end("pong-p1-6"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("没有拿到本地测试端口");
    const fetchLoopback = `${shellQuote(process.execPath)} -e 'fetch("http://127.0.0.1:${address.port}/").then((r) => r.text()).then((t) => process.stdout.write(t))'`;
    try {
      await expect(run(fetchLoopback), "默认连本机回环也不通").rejects.toThrow();
      const callId = nextCall();
      sandbox.allow(runId, callId, { network: true, writePaths: [] });
      const result = await run(fetchLoopback, callId);
      expect(JSON.stringify(result.content)).toContain("pong-p1-6");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
