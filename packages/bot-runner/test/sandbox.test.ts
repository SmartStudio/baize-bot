import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BotId, ComputerId, GroupId } from "@baize/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, type GateAccess, type GateCall } from "../src/gate.js";
import { botDirs, ensureBotDirs, forbiddenZones, type ForbiddenZones } from "../src/paths.js";
import {
  bwrapArgs,
  createSandboxedBash,
  otherBotDirs,
  sandboxKind,
  sandboxProfile,
  whitelistEnv,
} from "../src/sandbox.js";

// 照运行器的布局 <dataDir>/<botId>/work：bwrap 把数据目录下别的目录都当别的 Bot 盖住。
const dataDir = mkdtempSync(join(tmpdir(), "baize-sandbox-perf-"));
const workDir = join(dataDir, "bot-1", "work");
ensureBotDirs(botDirs(dataDir, BotId.parse("bot-1")));
const zones: ForbiddenZones = forbiddenZones(botDirs(dataDir, BotId.parse("bot-1")), join(dataDir, "chrome-profile"));

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

type BashOutcome = Awaited<ReturnType<ReturnType<typeof createSandboxedBash>["tool"]["execute"]>>;

// Pi 1.0 起 bash 非零退出不再抛异常，改成 resolve 一个 isError 的结果；沙箱拦住了就是这个结果，泄露断言也要落在它的文本上。
const blocked = async (pending: Promise<BashOutcome>, label: string): Promise<string> => {
  const result = await pending;
  expect(result.isError, label).toBe(true);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
};

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

const listenUnix = async (path: string): Promise<{ accepted(): number; close(): Promise<void> }> => {
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    accepted: () => accepted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const connectUnix = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });

// 先列目录，再分别按相对路径（cd 进去）和绝对路径连：macOS 的 sun_path 只有 104 字节，长路径只能相对连。
// 连上打 CONNECTED，连不上只打错误码，不带路径，列不出时输出里就不会出现 socket 的名字。
const unixSocketProbe = (socketDir: string, name = "SingletonSocket"): string => {
  const connectScript = `const s=require("node:net").connect(process.argv[1]);s.on("connect",()=>{process.stdout.write("CONNECTED\\n");s.end()});s.on("error",(e)=>process.stdout.write("REFUSED "+e.code+"\\n"))`;
  const node = shellQuote(process.execPath);
  const dir = shellQuote(socketDir);
  return [
    `ls -A ${dir} 2>/dev/null`,
    `(cd ${dir} 2>/dev/null && ${node} -e ${shellQuote(connectScript)} ${shellQuote(name)})`,
    `${node} -e ${shellQuote(connectScript)} ${shellQuote(join(socketDir, name))}`,
    "true",
  ].join("; ");
};

const runInSandbox = (command: string, network = false) =>
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", sandboxProfile(workDir, { network, writePaths: [] }, zones), "/bin/bash", "-c", command],
    {
      cwd: workDir,
      encoding: "utf8",
      env: whitelistEnv(process.env, workDir, join(workDir, ".tmp")),
    },
  );

describe("bash 沙箱性能", () => {
  it.skipIf(process.platform !== "darwin")(
    "数据根元数据可读：绝对路径的 node、git、mkdir 和共享产出正常，其他 Bot 仍隔离",
    () => {
      const root = mkdtempSync(join(tmpdir(), "baize-seatbelt-metadata-"));
      try {
        const dirs = ensureBotDirs(botDirs(root, BotId.parse("bot-1")));
        const other = ensureBotDirs(botDirs(root, BotId.parse("bot-2")));
        const script = join(dirs.workDir, "hello.cjs");
        const nested = join(dirs.workDir, "nested", "child");
        const shared = join(dirs.sharedDir, "delivery.txt");
        const secret = join(other.agentDir, "secret.txt");
        writeFileSync(script, 'process.stdout.write("node-ok")');
        writeFileSync(secret, "other-bot-secret");
        const profile = sandboxProfile(dirs.workDir, { network: false, writePaths: [] }, forbiddenZones(dirs, null));
        const run = (command: string) =>
          spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
            cwd: dirs.workDir,
            encoding: "utf8",
            env: whitelistEnv(process.env, dirs.workDir, join(dirs.workDir, ".tmp")),
          });
        for (const [command, output] of [
          [`${shellQuote(process.execPath)} ${shellQuote(script)}`, "node-ok"],
          [`git init -q ${shellQuote(dirs.workDir)} && git -C ${shellQuote(dirs.workDir)} status --short`, "hello.cjs"],
          [`mkdir -p ${shellQuote(nested)} && printf mkdir-ok`, "mkdir-ok"],
          [`printf shared-ok > ${shellQuote(shared)} && cat ${shellQuote(shared)}`, "shared-ok"],
          [
            `rsync ${shellQuote(script)} ${shellQuote(dirs.sharedDir)}/ && cat ${shellQuote(join(dirs.sharedDir, "hello.cjs"))}`,
            "node-ok",
          ],
        ] as const) {
          const result = run(command);
          expect(result.status, `${command}\n${result.stderr}`).toBe(0);
          expect(result.stdout).toContain(output);
        }
        expect(existsSync(nested)).toBe(true);
        expect(readFileSync(shared, "utf8")).toBe("shared-ok");
        const metadata = run(`stat ${shellQuote(root)}`);
        expect(metadata.status, metadata.stderr).toBe(0);
        for (const command of [
          `cat ${shellQuote(secret)}`,
          `stat ${shellQuote(other.agentDir)}`,
          `ls ${shellQuote(root)}`,
        ]) {
          const denied = run(command);
          expect(denied.status, denied.stderr).not.toBe(0);
          expect(denied.stderr).toMatch(/operation not permitted/i);
          expect(denied.stdout).not.toContain("other-bot-secret");
        }
        expect(readFileSync(secret, "utf8")).toBe("other-bot-secret");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")("批准数据根及祖先的写权限也不能写其他 Bot，本 Bot 和共享区仍可写", () => {
    const root = mkdtempSync(join(homedir(), "baize-seatbelt-ancestor-"));
    try {
      const data = join(root, "data");
      const dirs = ensureBotDirs(botDirs(data, BotId.parse("bot-1")));
      const other = ensureBotDirs(botDirs(data, BotId.parse("bot-2")));
      const secret = join(other.agentDir, "secret.txt");
      const leaked = join(other.workDir, "leak.txt");
      writeFileSync(secret, "other-bot-secret");
      for (const approved of [data, root, homedir()]) {
        const profile = sandboxProfile(
          dirs.workDir,
          { network: false, writePaths: [approved] },
          forbiddenZones(dirs, null),
        );
        const run = (command: string) =>
          spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
            cwd: dirs.workDir,
            encoding: "utf8",
          });
        for (const target of [secret, leaked]) {
          const denied = run(`printf overwritten > ${shellQuote(target)}`);
          expect(denied.status, `${approved}: ${denied.stderr}`).not.toBe(0);
          expect(denied.stderr).toMatch(/operation not permitted/i);
        }
        for (const base of [dirs.workDir, dirs.sharedDir]) {
          const target = join(base, "allowed.txt");
          const allowed = run(`printf own-shared-ok > ${shellQuote(target)} && cat ${shellQuote(target)}`);
          expect(allowed.status, allowed.stderr).toBe(0);
          expect(allowed.stdout).toBe("own-shared-ok");
        }
      }
      expect(readFileSync(secret, "utf8")).toBe("other-bot-secret");
      expect(existsSync(leaked)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("共享区和工作目录的根不能删除或替换，内部文件仍可写", async () => {
    const root = mkdtempSync(join(tmpdir(), "baize-seatbelt-root-"));
    try {
      const dirs = ensureBotDirs(botDirs(root, BotId.parse("bot-1")));
      const sandbox = createSandboxedBash(dirs.workDir, forbiddenZones(dirs, null));
      for (const [index, path] of [dirs.sharedDir, dirs.workDir].entries()) {
        await blocked(
          sandbox.tool.execute(
            `root-${index}`,
            { command: `rm -rf ${shellQuote(path)}` },
            undefined,
            undefined,
            undefined as never,
          ),
          "不能删掉允许写文件的根目录",
        );
        expect(existsSync(path)).toBe(true);
        const file = join(path, "normal.txt");
        const written = await sandbox.tool.execute(
          `file-${index}`,
          { command: `printf normal-content > ${shellQuote(file)} && cat ${shellQuote(file)}` },
          undefined,
          undefined,
          undefined as never,
        );
        expect(written.isError).not.toBe(true);
        expect(JSON.stringify(written.content)).toContain("normal-content");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("seatbelt 真机隔离其他 Bot，共享区可读写，草稿和 Chrome 禁区仍拒绝", () => {
    const root = mkdtempSync(join(tmpdir(), "baize-seatbelt-isolation-"));
    try {
      const data = join(root, "data");
      const dirs = ensureBotDirs(botDirs(data, BotId.parse("bot-1")));
      const other = ensureBotDirs(botDirs(data, BotId.parse("bot-2")));
      const profileDir = join(data, "chrome-profile");
      mkdirSync(profileDir);
      writeFileSync(join(dirs.agentDir, "own.txt"), "own-agent-content");
      writeFileSync(join(other.workDir, "secret.txt"), "other-bot-secret");
      writeFileSync(join(profileDir, "Cookies"), "chrome-secret");
      const alias = join(root, "data-alias");
      symlinkSync(data, alias);
      for (const dataPath of [data, alias]) {
        const visible = botDirs(dataPath, BotId.parse("bot-1"));
        const profile = sandboxProfile(
          visible.workDir,
          { network: false, writePaths: [] },
          forbiddenZones(visible, profileDir),
        );
        const run = (command: string) =>
          spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", command], {
            cwd: visible.workDir,
            encoding: "utf8",
          });
        const own = run(`cat ${shellQuote(join(visible.agentDir, "own.txt"))}`);
        expect(own.status, own.stderr).toBe(0);
        expect(own.stdout).toBe("own-agent-content");
        const shared = join(visible.sharedDir, "delivery.txt");
        const delivered = run(`printf shared-content > ${shellQuote(shared)} && cat ${shellQuote(shared)}`);
        expect(delivered.status, delivered.stderr).toBe(0);
        expect(delivered.stdout).toBe("shared-content");
        for (const command of [
          `cat ${shellQuote(join(dataPath, "bot-2", "work", "secret.txt"))}`,
          `printf leak > ${shellQuote(join(dataPath, "bot-2", "work", "leak.txt"))}`,
          `printf changed > ${shellQuote(join(visible.draftsDir, "copy.png"))}`,
          `cat ${shellQuote(join(profileDir, "Cookies"))}`,
        ]) {
          const denied = run(command);
          expect(denied.status, command).not.toBe(0);
          expect(denied.stderr, command).toMatch(/operation not permitted/i);
          expect(denied.stdout, command).not.toMatch(/other-bot-secret|chrome-secret/);
        }
      }
      expect(existsSync(join(other.workDir, "leak.txt"))).toBe(false);
      expect(existsSync(join(dirs.draftsDir, "copy.png"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("放宽禁区祖先写权限后仍不能写禁区", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "baize-sandbox-forbidden-"));
    try {
      const nestedWorkDir = join(sandboxRoot, "bot-1", "work");
      const forbiddenDir = join(sandboxRoot, "chrome-profile");
      const leaked = join(forbiddenDir, "leaked.txt");
      mkdirSync(nestedWorkDir, { recursive: true });
      mkdirSync(forbiddenDir);
      const nestedZones = forbiddenZones(botDirs(sandboxRoot, BotId.parse("bot-1")), forbiddenDir);
      const profile = sandboxProfile(nestedWorkDir, { network: false, writePaths: [sandboxRoot] }, nestedZones);
      const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/touch", leaked], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(leaked)).toBe(false);
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下读不到助理 Chrome profile 里的 Cookies，命令解析认不出的读法也不行",
    async () => {
      const profileDir = mkdtempSync(join(tmpdir(), "baize-assistant-profile-"));
      try {
        mkdirSync(join(profileDir, "Default"));
        writeFileSync(join(profileDir, "Default", "Cookies"), "cookie-secret-p1-5");
        const sandbox = createSandboxedBash(
          workDir,
          forbiddenZones(botDirs(dataDir, BotId.parse("bot-1")), profileDir),
        );
        const commands = [
          `d=${shellQuote(profileDir)}; f=Cook; cat "$d/Default/\${f}ies"`,
          `${shellQuote(process.execPath)} -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' ${shellQuote(join(profileDir, "Default", "Cookies"))}`,
        ];
        for (const [index, command] of commands.entries()) {
          const text = await blocked(
            sandbox.tool.execute(`cookies-${index}`, { command }, undefined, undefined, undefined as never),
            command,
          );
          expect(text, command).toMatch(/operation not permitted|EPERM/i);
          expect(text, command).not.toContain("cookie-secret-p1-5");
        }
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下批了联网和写路径，禁区里的 unix socket 照样列不出、连不上",
    async () => {
      const profileDir = mkdtempSync(join(tmpdir(), "baize-sock-"));
      const outside = mkdtempSync(join(tmpdir(), "baize-sock-out-"));
      const socketDir = join(profileDir, "tmp", "sock");
      mkdirSync(socketDir, { recursive: true });
      const server = await listenUnix(join(socketDir, "SingletonSocket"));
      try {
        const sandbox = createSandboxedBash(
          workDir,
          forbiddenZones(botDirs(dataDir, BotId.parse("bot-1")), profileDir),
          () => "run-sock",
        );
        sandbox.allow("run-sock", "call-sock", { network: true, writePaths: [join(outside, "new", "x")] });
        const result = await sandbox.tool.execute(
          "call-sock",
          { command: unixSocketProbe(socketDir) },
          undefined,
          undefined,
          undefined as never,
        );
        const output = JSON.stringify(result.content);
        expect(output, "列不出禁区里的 socket").not.toContain("SingletonSocket");
        expect(output, "相对路径和绝对路径都连不上").not.toContain("CONNECTED");
        expect(output).toContain("REFUSED");
        await connectUnix(join(socketDir, "SingletonSocket"));
        expect(server.accepted(), "沙箱外连得上，所以只有这一次").toBe(1);
      } finally {
        await server.close();
        rmSync(profileDir, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下批了联网，工作目录和禁区外的 unix socket 连不上，不批联网也连不上",
    async () => {
      // 代表 docker.sock 和用户自己 Chrome 的 SingletonSocket：在系统临时目录里，不在工作目录，也不在禁区。
      const outside = mkdtempSync(join(tmpdir(), "baize-host-sock-"));
      const server = await listenUnix(join(outside, "docker.sock"));
      let runId = "";
      try {
        const sandbox = createSandboxedBash(workDir, zones, () => runId);
        for (const callId of ["networked", "plain"]) {
          runId = `run-host-sock-${callId}`;
          if (callId === "networked") sandbox.allow(runId, callId, { network: true, writePaths: [] });
          const result = await sandbox.tool.execute(
            callId,
            { command: unixSocketProbe(outside, "docker.sock") },
            undefined,
            undefined,
            undefined as never,
          );
          const output = JSON.stringify(result.content);
          expect(output, `${callId}：相对路径和绝对路径都连不上`).not.toContain("CONNECTED");
          expect(output, callId).toContain("REFUSED EPERM");
        }
        expect(server.accepted(), "沙箱里一次都没连上").toBe(0);
        await connectUnix(join(outside, "docker.sock"));
        expect(server.accepted(), "沙箱外连得上").toBe(1);
      } finally {
        await server.close();
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下批了联网，/private/var/run 里只有 mDNSResponder 放行",
    async () => {
      // docker.sock 就在 /var/run 下，不能拿它测。syslog 是 datagram socket，只 connect 不发字节：
      // 过了沙箱会被内核按类型拒成 EPROTOTYPE，只有沙箱拒才是 EPERM。seatbelt 只对真 socket 做判断，
      // 不存在的路径和普通文件在两种 profile 下报错一样，所以只能借一个系统 socket。
      const node = shellQuote(process.execPath);
      const connectScript = `const s=require("node:net").connect(process.argv[1]);s.on("connect",()=>{process.stdout.write("CONNECTED\\n");s.destroy()});s.on("error",(e)=>process.stdout.write("REFUSED "+e.code+"\\n"))`;
      const sandbox = createSandboxedBash(workDir, zones, () => "run-var-run");
      sandbox.allow("run-var-run", "call-var-run", { network: true, writePaths: [] });
      const result = await sandbox.tool.execute(
        "call-var-run",
        { command: `${node} -e ${shellQuote(connectScript)} /private/var/run/syslog` },
        undefined,
        undefined,
        undefined as never,
      );
      expect(JSON.stringify(result.content), "syslog 被沙箱拒掉，不是过了沙箱被内核拒").toContain("REFUSED EPERM");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下批了联网，别的 Bot 目录和本 Bot 工作目录外的 socket 连不上",
    async () => {
      const otherBotWork = join(dataDir, "bot-2", "work");
      const ownAgentDir = join(dataDir, "bot-1", "agent");
      mkdirSync(otherBotWork, { recursive: true });
      mkdirSync(ownAgentDir, { recursive: true });
      const otherServer = await listenUnix(join(otherBotWork, "x.sock"));
      const agentServer = await listenUnix(join(ownAgentDir, "x.sock"));
      try {
        const sandbox = createSandboxedBash(workDir, zones, () => "run-sibling-sock");
        sandbox.allow("run-sibling-sock", "call-sibling-sock", { network: true, writePaths: [] });
        const result = await sandbox.tool.execute(
          "call-sibling-sock",
          { command: `${unixSocketProbe(otherBotWork, "x.sock")}; ${unixSocketProbe(ownAgentDir, "x.sock")}` },
          undefined,
          undefined,
          undefined as never,
        );
        const output = JSON.stringify(result.content);
        expect(output, "相对路径和绝对路径都连不上").not.toContain("CONNECTED");
        expect(output.match(/REFUSED EPERM/g), "两个 socket 各两种写法都被沙箱拒").toHaveLength(4);
        expect(otherServer.accepted(), "别的 Bot 工作目录里的 socket 一次都没连上").toBe(0);
        expect(agentServer.accepted(), "本 Bot 工作目录外的 socket 一次都没连上").toBe(0);
      } finally {
        await otherServer.close();
        await agentServer.close();
        rmSync(join(dataDir, "bot-2"), { recursive: true, force: true });
        rmSync(ownAgentDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")("seatbelt 下批了联网，本机地址以外的 IP 也放行，不批联网被拒", async () => {
    // seatbelt 的 localhost 包括本机所有网卡地址，连本机网卡地址分不出「全部 IP」和「只放 localhost」。
    // 127.0.0.2 不是本机地址但路由在 lo0 上，包不出本机，断网也测得出：沙箱放行时 connect 挂起或被内核拒，
    // 沙箱不放行时 connect 当场 EPERM。
    const port = await availablePort();
    const node = shellQuote(process.execPath);
    const connectScript = `const s=require("node:net").connect(${port},"127.0.0.2");const pass=()=>{process.stdout.write("SANDBOX-PASSED\\n");s.destroy()};s.setTimeout(300,pass);s.on("connect",pass);s.on("error",(e)=>e.code==="EPERM"?process.stdout.write("REFUSED EPERM\\n"):pass())`;
    const command = `${node} -e ${shellQuote(connectScript)}`;
    let runId = "run-remote-ip";
    const sandbox = createSandboxedBash(workDir, zones, () => runId);
    sandbox.allow(runId, "networked", { network: true, writePaths: [] });
    const networked = JSON.stringify(
      (await sandbox.tool.execute("networked", { command }, undefined, undefined, undefined as never)).content,
    );
    expect(networked, "批了联网，非本机地址的连接出得了沙箱").toContain("SANDBOX-PASSED");
    runId = "run-remote-ip-off";
    const plain = JSON.stringify(
      (await sandbox.tool.execute("plain", { command }, undefined, undefined, undefined as never)).content,
    );
    expect(plain, "不批联网被沙箱拒").toContain("REFUSED EPERM");
  });

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下批了联网能解析域名、连本机回环、连工作目录里的 socket，不批联网三样都不通",
    async () => {
      // 本机的 .local 名字由 mDNSResponder 解析，不靠外网，所以断网的机器上也测得出 DNS 那条 socket 放没放开。
      const localName = `${spawnSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).stdout.trim()}.local`;
      const socketDir = join(workDir, "svc");
      mkdirSync(socketDir, { recursive: true });
      const unixServer = await listenUnix(join(socketDir, "bot.sock"));
      const httpServer = createHttpServer((_request, response) => response.end("pong-sandbox-net"));
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("没有拿到本地测试端口");
      const node = shellQuote(process.execPath);
      const command = [
        `${node} -e 'require("node:dns").lookup(process.argv[1],(e,a)=>process.stdout.write((e?"DNS-FAIL "+e.code:"DNS-OK")+"\\n"))' ${shellQuote(localName)}`,
        `/usr/bin/curl -sS --max-time 2 http://127.0.0.1:${address.port}/ || echo LOOPBACK-FAIL`,
        unixSocketProbe(socketDir, "bot.sock"),
      ].join("; ");
      let runId = "run-net-ok";
      try {
        const sandbox = createSandboxedBash(workDir, zones, () => runId);
        sandbox.allow(runId, "networked", { network: true, writePaths: [] });
        const networked = JSON.stringify(
          (await sandbox.tool.execute("networked", { command }, undefined, undefined, undefined as never)).content,
        );
        expect(networked, "DNS 照常").toContain("DNS-OK");
        expect(networked, "本机回环照常").toContain("pong-sandbox-net");
        expect(networked.match(/CONNECTED/g), "工作目录里的 socket 相对路径和绝对路径都连得上").toHaveLength(2);

        runId = "run-net-off";
        const plain = JSON.stringify(
          (await sandbox.tool.execute("plain", { command }, undefined, undefined, undefined as never)).content,
        );
        expect(plain, "不批联网 DNS 不通").toContain("DNS-FAIL");
        expect(plain, "不批联网回环不通").toContain("LOOPBACK-FAIL");
        expect(plain, "不批联网连不上工作目录里的 socket").not.toContain("CONNECTED");
        expect(unixServer.accepted(), "只有批了联网那次的两连").toBe(2);
      } finally {
        await unixServer.close();
        await new Promise((resolve) => httpServer.close(resolve));
        rmSync(socketDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "seatbelt 下同一次调用批了外面目录的写和联网，把 socket 所在目录挪进工作目录也连不上",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "baize-sandbox-mv-"));
      const socketDir = join(outside, "sub");
      mkdirSync(socketDir);
      const server = await listenUnix(join(socketDir, "s.sock"));
      const node = shellQuote(process.execPath);
      // spawnSync 期间测试进程的事件循环停着，服务端不会回 FIN，客户端连上就 destroy，不等对端。
      const connectScript = `const s=require("node:net").connect(process.argv[1]);s.on("connect",()=>{process.stdout.write("CONNECTED\\n");s.destroy()});s.on("error",(e)=>process.stdout.write("REFUSED "+e.code+"\\n"))`;
      const command = [
        `mv ${shellQuote(socketDir)} ./moved-sub && echo DIR-MOVED`,
        `${node} -e ${shellQuote(connectScript)} ./moved-sub/s.sock`,
        "true",
      ].join("; ");
      try {
        const result = spawnSync(
          "/usr/bin/sandbox-exec",
          ["-p", sandboxProfile(workDir, { network: true, writePaths: [outside] }, zones), "/bin/bash", "-c", command],
          {
            cwd: workDir,
            encoding: "utf8",
            env: whitelistEnv(process.env, workDir, join(workDir, ".tmp")),
            timeout: 20_000,
          },
        );
        expect(result.stdout, "批了写外面的目录，目录挪得进工作目录").toContain("DIR-MOVED");
        expect(result.stdout, "挪进来的 socket 连不上").not.toContain("CONNECTED");
        expect(server.accepted(), "服务端一次连接都没收到").toBe(0);
      } finally {
        await server.close();
        rmSync(join(workDir, "moved-sub"), { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "darwin")("seatbelt 下禁区落在工作目录里，批了联网也连不上里面的 socket", async () => {
    const nestedProfile = join(workDir, "nested-profile");
    mkdirSync(nestedProfile, { recursive: true });
    const server = await listenUnix(join(nestedProfile, "SingletonSocket"));
    try {
      const sandbox = createSandboxedBash(
        workDir,
        forbiddenZones(botDirs(dataDir, BotId.parse("bot-1")), nestedProfile),
        () => "run-nested",
      );
      sandbox.allow("run-nested", "call-nested", { network: true, writePaths: [] });
      const result = await sandbox.tool.execute(
        "call-nested",
        { command: unixSocketProbe(nestedProfile) },
        undefined,
        undefined,
        undefined as never,
      );
      expect(JSON.stringify(result.content)).not.toContain("CONNECTED");
      expect(server.accepted()).toBe(0);
    } finally {
      await server.close();
      rmSync(nestedProfile, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("seatbelt 下配图拷贝目录读得到、写不进，批准写 Bot 目录也一样", async () => {
    const drafts = botDirs(dataDir, BotId.parse("bot-1")).draftsDir;
    mkdirSync(drafts, { recursive: true });
    writeFileSync(join(drafts, "copy.png"), "approved-bytes");
    let runId = "run-drafts";
    const sandbox = createSandboxedBash(workDir, zones, () => runId);
    sandbox.allow(runId, "widened", { network: false, writePaths: [join(dataDir, "bot-1")] });
    const swapped = await blocked(
      sandbox.tool.execute(
        "widened",
        { command: `echo swapped > ${shellQuote(join(drafts, "copy.png"))}` },
        undefined,
        undefined,
        undefined as never,
      ),
      "批准写 Bot 目录也写不进配图拷贝",
    );
    expect(swapped).toContain("Operation not permitted");
    expect(readFileSync(join(drafts, "copy.png"), "utf8")).toBe("approved-bytes");
    runId = "run-read";
    const read = await sandbox.tool.execute(
      "read",
      { command: `cat ${shellQuote(join(drafts, "copy.png"))}` },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.stringify(read.content)).toContain("approved-bytes");
  });

  it.skipIf(process.platform !== "darwin")(
    "Bot 目录的私有部分批了也写不进，所以闸门拒绝；工作目录里的写闸门放行、沙箱真写成功",
    () => {
      const root = mkdtempSync(join(tmpdir(), "baize-seatbelt-own-private-"));
      try {
        const dirs = ensureBotDirs(botDirs(root, BotId.parse("bot-1")));
        const botDir = dirname(dirs.workDir);
        const ownZones = forbiddenZones(dirs, null);
        const gateCall = (command: string): GateCall => ({
          toolName: "bash",
          input: { command },
          workDir: dirs.workDir,
          zones: ownZones,
          groupId: GroupId.parse("group-1"),
          computerId: ComputerId.parse("computer-1"),
          platform: "darwin",
          sandbox: "seatbelt",
          source: null,
          routine: null,
        });
        const runIn = (access: GateAccess, command: string) =>
          spawnSync(
            "/usr/bin/sandbox-exec",
            ["-p", sandboxProfile(dirs.workDir, access, ownZones), "/bin/bash", "-c", command],
            {
              cwd: dirs.workDir,
              encoding: "utf8",
            },
          );

        const inWork = join(dirs.workDir, "approved.txt");
        const writeWork = `printf work-ok > ${shellQuote(inWork)}`;
        const allowed = decide(gateCall(writeWork), [], []);
        expect(allowed.verdict).toBe("allow");
        const written = runIn(allowed.access, `${writeWork} && cat ${shellQuote(inWork)}`);
        expect(written.status, written.stderr).toBe(0);
        expect(written.stdout).toBe("work-ok");

        for (const path of [
          join(dirs.agentDir, "note.txt"),
          join(dirs.skillsDir, "n.txt"),
          join(dirs.sessionDir, "n.txt"),
          join(botDir, "top.txt"),
        ]) {
          const command = `printf swapped > ${shellQuote(path)}`;
          expect(decide(gateCall(command), [], []).verdict, path).toBe("deny");
          const approved = runIn({ network: false, writePaths: [path] }, command);
          expect(approved.status, `${path}: 批准写也应被沙箱拒绝`).not.toBe(0);
          expect(approved.stderr).toMatch(/operation not permitted/i);
          expect(existsSync(path)).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
    const sandbox = createSandboxedBash(workDir, zones).tool;
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
          zones,
          groupId: GroupId.parse("group-1"),
          computerId: ComputerId.parse("computer-1"),
          platform: process.platform,
          sandbox: sandboxKind(),
          source: null,
          routine: null,
        },
        [],
        [],
      );
      expect(decision.verdict).toBe("allow");
      const outcome = await sandbox.execute(
        `sandbox-${index}`,
        { command: "echo ok" },
        undefined,
        undefined,
        undefined as never,
      );
      expect(outcome.isError, "沙箱里 echo ok 要真跑成功，失败会让增量偏小").not.toBe(true);
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
      const sandbox = createSandboxedBash(workDir, zones, () => runId);
      try {
        sandbox.allow(runId, "same-call", { network: false, writePaths: [outside] });
        sandbox.clearRun(runId);
        runId = "run-2";
        const afterClear = join(outside, "after-clear.txt");
        expect(
          await blocked(
            sandbox.tool.execute(
              "same-call",
              { command: `/usr/bin/touch ${shellQuote(afterClear)}` },
              undefined,
              undefined,
              undefined as never,
            ),
            "afterClear",
          ),
        ).toContain("Operation not permitted");
        expect(existsSync(afterClear)).toBe(false);

        sandbox.allow(runId, "same-call", { network: false, writePaths: [outside] });
        sandbox.allow(runId, "same-call", { network: false, writePaths: [] });
        const afterEmpty = join(outside, "after-empty.txt");
        expect(
          await blocked(
            sandbox.tool.execute(
              "same-call",
              { command: `/usr/bin/touch ${shellQuote(afterEmpty)}` },
              undefined,
              undefined,
              undefined as never,
            ),
            "afterEmpty",
          ),
        ).toContain("Operation not permitted");
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
    const tool = createSandboxedBash(workDir, zones).tool;
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
  it.each(["shared", "bot", "work"])("%s 根预先指向其他 Bot 时拒绝配置", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "baize-root-config-"));
    try {
      const dirs = ensureBotDirs(botDirs(root, BotId.parse("bot-1")));
      const other = ensureBotDirs(botDirs(root, BotId.parse("bot-2")));
      const path = kind === "shared" ? dirs.sharedDir : kind === "bot" ? join(root, "bot-1") : dirs.workDir;
      rmSync(path, { recursive: true });
      symlinkSync(kind === "work" ? other.workDir : join(root, "bot-2"), path);
      expect(() => forbiddenZones(dirs, null)).toThrow(/目录隔离配置无效/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bwrap 参数：禁区盖在最上面，批准的写路径可写，批准 network 时不断网", () => {
    const work = "/data/bot-1/work";
    const forbidden = ["/home/node/.ssh", "/data/bot-1/work/.ssh", "/data/bot-2", "/outside/chrome-profile"];
    const readOnly = ["/data/bot-1/drafts"];
    expect(bwrapArgs(work, { network: false, writePaths: ["/outside"] }, forbidden, readOnly, "/data/shared")).toEqual([
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
      "/data/shared",
      "/data/shared",
      "--bind",
      "/outside",
      "/outside",
      "--ro-bind",
      "/data/bot-1/drafts",
      "/data/bot-1/drafts",
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
    const networked = bwrapArgs(work, { network: true, writePaths: [] }, forbidden, readOnly, "/data/shared");
    expect(networked, "批准 network 的那一次和容器共用网络").not.toContain("--unshare-net");
    expect(networked, "docker 遮住了部分 /proc，新挂 proc 会失败").not.toContain("--proc");
  });

  it("共享区排除在其他 Bot 屏蔽列表外，并以可写方式绑定", () => {
    const forbidden = otherBotDirs("/data/bot-1", "/data/shared", [
      "/data/bot-1",
      "/data/bot-2",
      "/data/shared",
      "/data/chrome-profile",
    ]);
    expect(forbidden).toEqual(["/data/bot-2", "/data/chrome-profile"]);
    const args = bwrapArgs("/data/bot-1/work", { network: false, writePaths: [] }, forbidden, [], "/data/shared");
    const shared = args.indexOf("/data/shared");
    expect(args.slice(shared - 1, shared + 2)).toEqual(["--bind", "/data/shared", "/data/shared"]);
    expect(args.filter((arg) => arg === "/data/shared")).toHaveLength(2);
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
  let profileDir = "";
  let callSeq = 0;
  let sandbox!: ReturnType<typeof createSandboxedBash>;
  const nextCall = (): string => `bwrap-${(callSeq += 1)}`;
  const run = (command: string, callId = nextCall()) =>
    sandbox.tool.execute(callId, { command }, undefined, undefined, undefined as never);

  beforeAll(() => {
    root = mkdtempSync(join(homedir(), ".baize-bwrap-test-"));
    ensureBotDirs(botDirs(join(root, "data"), BotId.parse("bot-1")));
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
    profileDir = join(root, "chrome-profile");
    mkdirSync(join(profileDir, "Default"), { recursive: true });
    writeFileSync(join(profileDir, "Default", "Cookies"), "cookie-secret-p1-6");
    sandbox = createSandboxedBash(
      botWork,
      forbiddenZones(botDirs(join(root, "data"), BotId.parse("bot-1")), profileDir),
      () => runId,
    );
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
    ["数据目录外的助理 Chrome profile 里的 Cookies", () => `f=Cook; cat ${shellQuote(profileDir)}/Default/\${f}ies`],
  ])("bwrap 下禁区读不到：%s", async (_label, command) => {
    const text = await blocked(run(command()), command());
    expect(text, "命令自己报了失败").toContain("Command exited with code");
    expect(text).not.toContain("secret-p1-6");
  });

  it("bwrap 下工作目录外写不进，工作目录里能写", async () => {
    const outsideFile = join(outside, "leak.txt");
    const homeFile = join(fakeHome, "leak.txt");
    const otherBotFile = join(otherBot, "leak.txt");
    for (const target of [outsideFile, homeFile, otherBotFile]) {
      await blocked(run(`echo leak > ${shellQuote(target)}`), target);
      expect(existsSync(target), target).toBe(false);
    }
    expect((await run("echo ok > inside.txt && mkdir -p nested && touch nested/b.txt")).isError).not.toBe(true);
    expect(readFileSync(join(botWork, "inside.txt"), "utf8")).toBe("ok\n");
    expect(existsSync(join(botWork, "nested", "b.txt"))).toBe(true);
  });

  it("bwrap 下批准的写路径这一次可写，禁区照样盖住", async () => {
    const approved = join(outside, "approved.txt");
    const callId = nextCall();
    sandbox.allow(runId, callId, { network: false, writePaths: [approved] });
    expect((await run(`echo ok > ${shellQuote(approved)}`, callId)).isError).not.toBe(true);
    expect(readFileSync(approved, "utf8")).toBe("ok\n");
    await blocked(run(`echo again > ${shellQuote(approved)}`), "放宽只管批准的那一次");

    const widened = nextCall();
    sandbox.allow(runId, widened, { network: false, writePaths: [root] });
    const widenedRead = await blocked(
      run(`cat ${shellQuote(join(otherBot, "secret.txt"))}`, widened),
      "放宽写路径后别的 Bot 目录照样读不到",
    );
    expect(widenedRead).not.toContain("bot-2-secret-p1-6");
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

  it("bwrap 下批了联网和写 /tmp，profile 里的 unix socket 照样列不出、连不上", async () => {
    const socketDir = join(profileDir, "tmp", "sock");
    mkdirSync(socketDir, { recursive: true });
    const server = await listenUnix(join(socketDir, "SingletonSocket"));
    try {
      const callId = nextCall();
      sandbox.allow(runId, callId, { network: true, writePaths: [join("/tmp", `p1-5-singleton-${process.pid}`, "x")] });
      const result = await run(unixSocketProbe(socketDir), callId);
      const output = JSON.stringify(result.content);
      expect(output, "列不出禁区里的 socket").not.toContain("SingletonSocket");
      expect(output, "相对路径和绝对路径都连不上").not.toContain("CONNECTED");
      expect(output).toContain("REFUSED");
      await connectUnix(join(socketDir, "SingletonSocket"));
      expect(server.accepted(), "沙箱外连得上，所以只有这一次").toBe(1);
    } finally {
      await server.close();
    }
  });

  // bwrap 挡 unix socket 只靠看不看得见：共用网络命名空间不影响文件 socket，看得见的就连得上。
  it("bwrap 下批了联网，真 /tmp 里的 unix socket 连不上，工作目录里的 socket 连得上", async () => {
    const hostDir = mkdtempSync(join("/tmp", "baize-host-sock-"));
    const hostServer = await listenUnix(join(hostDir, "docker.sock"));
    const workServer = await listenUnix(join(botWork, "bot.sock"));
    try {
      const callId = nextCall();
      sandbox.allow(runId, callId, { network: true, writePaths: [] });
      const result = await run(
        `${unixSocketProbe(hostDir, "docker.sock")}; ${unixSocketProbe(botWork, "bot.sock")}`,
        callId,
      );
      const output = JSON.stringify(result.content);
      expect(output.match(/CONNECTED/g), "只有工作目录里的 socket 两种写法都连得上").toHaveLength(2);
      expect(hostServer.accepted(), "沙箱外的 socket 一次都没连上").toBe(0);
      expect(workServer.accepted()).toBe(2);
    } finally {
      await hostServer.close();
      await workServer.close();
      rmSync(hostDir, { recursive: true, force: true });
      rmSync(join(botWork, "bot.sock"), { force: true });
    }
  });

  it("bwrap 下默认断网，批准 network 后通", async () => {
    const server = createHttpServer((_request, response) => response.end("pong-p1-6"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("没有拿到本地测试端口");
    const fetchLoopback = `${shellQuote(process.execPath)} -e 'fetch("http://127.0.0.1:${address.port}/").then((r) => r.text()).then((t) => process.stdout.write(t))'`;
    try {
      const offline = await blocked(run(fetchLoopback), "默认连本机回环也不通");
      expect(offline).not.toContain("pong-p1-6");
      const callId = nextCall();
      sandbox.allow(runId, callId, { network: true, writePaths: [] });
      const result = await run(fetchLoopback, callId);
      expect(JSON.stringify(result.content)).toContain("pong-p1-6");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** 一套临时布局，助理 Chrome 的 profileDir 配成一对互指的符号链接。 */
const loopProfile = (): { root: string; work: string; zones: ForbiddenZones } => {
  const root = mkdtempSync(join(tmpdir(), "baize-sandbox-loop-"));
  const work = join(root, "bot-1", "work");
  mkdirSync(work, { recursive: true });
  const profile = join(root, "loop-profile");
  symlinkSync(join(root, "loop-profile-2"), profile);
  symlinkSync(profile, join(root, "loop-profile-2"));
  return { root, work, zones: forbiddenZones(botDirs(root, BotId.parse("bot-1")), profile) };
};

describe("禁区配置指向成环的符号链接", () => {
  it("browserProfileDir 成环：seatbelt profile 生成失败，报错点名 config.browser.profileDir", () => {
    const { root, work, zones: loopZones } = loopProfile();
    try {
      expect(() => sandboxProfile(work, { network: false, writePaths: [] }, loopZones)).toThrow(
        /config\.browser\.profileDir[^]*成环/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "browserProfileDir 成环：bash 不放行也不裸跑，错误点名 config.browser.profileDir",
    async () => {
      const { root, work, zones: loopZones } = loopProfile();
      const marker = join(root, "ran.txt");
      try {
        const sandbox = createSandboxedBash(work, loopZones);
        await expect(
          sandbox.tool.execute(
            "loop-1",
            { command: `touch ${shellQuote(marker)}` },
            undefined,
            undefined,
            undefined as never,
          ),
        ).rejects.toThrow(/config\.browser\.profileDir/);
        expect(existsSync(marker), "命令没有在沙箱外跑起来").toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
