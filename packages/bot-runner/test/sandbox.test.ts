import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComputerId, GroupId } from "@baize/shared";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../src/gate.js";
import { createSandboxedBash, sandboxProfile, whitelistEnv } from "../src/sandbox.js";

const workDir = mkdtempSync(join(tmpdir(), "baize-sandbox-perf-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
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
        { PATH: "/bin", HOME: "/Users/test", BAIZE_GATE_SENTINEL: "secret", PI_SESSION_ID: "session-1" },
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

  it.skipIf(process.platform !== "darwin")("abort 会杀掉 sandbox-exec 下的整棵进程组", async () => {
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

      const groups = new Set(before.map((line) => line.trim().split(/\s+/)[1]));
      expect(groups.size).toBe(1);
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
