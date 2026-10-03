import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBashToolDefinition, type BashSpawnContext, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import type { GateAccess, SandboxKind } from "./gate.js";
import { type ForbiddenZones, realpathExisting } from "./paths.js";

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"] as const;
const MACH_LOOKUP_NAMES = [
  "com.apple.system.logger",
  "com.apple.system.opendirectoryd",
  "com.apple.system.DirectoryService",
  "com.apple.cfprefsd.daemon",
  "com.apple.SecurityServer",
  "com.apple.trustd",
  "com.apple.lsd.mapdb",
  "com.apple.diagnosticd",
  "com.apple.system.notification_center",
  "com.apple.runningboard",
] as const;
const MDNS_RESPONDER_SOCKET = "/private/var/run/mDNSResponder";

const shSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const seatbeltString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function whitelistEnv(env: NodeJS.ProcessEnv, cwd: string, tmpDir: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { PWD: cwd, TMPDIR: tmpDir };
  for (const key of ENV_ALLOW) {
    const value = env[key];
    if (value !== undefined) next[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PI_") && value !== undefined) next[key] = value;
  }
  return next;
}

export function sandboxProfile(workDir: string, access: GateAccess, zones: ForbiddenZones): string {
  const work = realpathExisting(workDir);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal)",
    "(allow sysctl-read)",
    ...MACH_LOOKUP_NAMES.map((name) => `(allow mach-lookup (global-name ${seatbeltString(name)}))`),
    "(allow ipc-posix-shm*)",
    "(allow system-socket)",
    "(allow file-ioctl)",
    "(allow file-map-executable)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${seatbeltString(work)}))`,
    ...access.writePaths.flatMap((path) => {
      const real = realpathExisting(path);
      return [`(allow file-write* (subpath ${seatbeltString(real)}))`];
    }),
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/stdout"))',
    '(allow file-write* (literal "/dev/stderr"))',
    '(allow file-write* (literal "/dev/fd/1"))',
    '(allow file-write* (literal "/dev/fd/2"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
    // 连 unix socket 在 seatbelt 里算 network-outbound，裸的 (allow network-outbound) 会把本机所有 unix socket
    // 一起放开（docker.sock、用户自己 Chrome 的 SingletonSocket）。批了联网只放 IP、DNS 走的 mDNSResponder
    // 和工作目录里 Bot 自己起的 socket。seatbelt 按 socket 当前的路径判，同一次调用还批了写外面的目录时，
    // bash 能把外面某个 socket 所在的目录整个挪进工作目录再连，所以这种调用连工作目录里的 socket 也不放。
    ...(access.network
      ? [
          "(allow network-outbound (remote ip))",
          `(allow network-outbound (remote unix-socket (path-literal ${seatbeltString(MDNS_RESPONDER_SOCKET)})))`,
          ...(access.writePaths.length === 0
            ? [`(allow network-outbound (remote unix-socket (subpath ${seatbeltString(work)})))`]
            : []),
          "(allow network-inbound)",
          "(allow network-bind)",
        ]
      : ["(deny network*)"]),
    // 禁区落在工作目录里面时，上面放开的工作目录 socket 在这里拒回去。
    ...zones.hidden.flatMap((prefix) => {
      const real = seatbeltString(realpathExisting(prefix));
      return [
        `(deny file-read* (subpath ${real}))`,
        `(deny file-write* (subpath ${real}))`,
        `(deny network-outbound (remote unix-socket (subpath ${real})))`,
      ];
    }),
    ...zones.readOnly.map((prefix) => `(deny file-write* (subpath ${seatbeltString(realpathExisting(prefix))}))`),
  ];
  return lines.join("\n");
}

const detectSandbox = (): SandboxKind => {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform !== "linux") {
    console.warn(`这台电脑是 ${process.platform}，没有 bash 沙箱，Bot 的每条 bash 都要问`);
    return "none";
  }
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "true"], {
    encoding: "utf8",
  });
  if (probe.status === 0) return "bwrap";
  const why = probe.error?.message ?? (probe.stderr.trim() || `exit ${probe.status ?? probe.signal}`);
  console.warn(`bubblewrap 起不来（${why}），这台电脑没有 bash 沙箱，Bot 的每条 bash 都要问`);
  return "none";
};

let detected: SandboxKind | undefined;

/** 进程内只探一次。 */
export function sandboxKind(): SandboxKind {
  detected ??= detectSandbox();
  return detected;
}

/**
 * 入参都已是 realpath，禁区都已存在：只读根上建不了挂载点，不存在的禁区会让 bwrap 报
 * 「Can't mkdir parents ... Read-only file system」，整条命令起不来。
 * 禁区放在所有 bind 之后：bwrap 按参数顺序叠挂载，后挂的盖住先挂的。禁区落在工作目录或批准的写路径里面时照样被盖住；
 * 工作目录本身落在禁区里时 --chdir 失败，命令起不来。
 * 只读区用 --ro-bind 叠在写路径之后，批准写它的祖先也改不动它。
 * 空 tmpfs 默认可写，写进去的东西随沙箱消失，命令却报成功，所以再逐个 --remount-ro。先挂完全部 tmpfs 再改只读，
 * 禁区互相嵌套时里层的挂载点还建得出来。
 * 不挂 --proc：docker 遮住了部分 /proc，新挂 proc 会失败，沙箱和容器共用 /proc。
 */
export function bwrapArgs(
  workDir: string,
  access: GateAccess,
  forbidden: readonly string[],
  readOnly: readonly string[],
): readonly string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    workDir,
    workDir,
    ...access.writePaths.flatMap((path) => ["--bind", path, path]),
    ...readOnly.flatMap((path) => ["--ro-bind", path, path]),
    ...forbidden.flatMap((path) => ["--tmpfs", path]),
    ...forbidden.flatMap((path) => ["--remount-ro", path]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    ...(access.network ? [] : ["--unshare-net"]),
    "--chdir",
    workDir,
  ];
}

// 工作目录是 <dataDir>/<botId>/work，数据目录下除自己以外的目录都是别的 Bot（和 chrome-profile）。
const otherBotDirs = (workDir: string): readonly string[] => {
  const botDir = dirname(workDir);
  const dataDir = dirname(botDir);
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dataDir, entry.name))
    .filter((path) => path !== botDir);
};

// bind 的源必须存在。批准写一个还不存在的路径，就放开它最近的已存在祖先；根目录不放，
// 整个根可写会盖掉 /dev 和 /tmp 的挂载。
const writeMountPoint = (path: string): string | null => {
  let current = realpathExisting(path);
  while (!existsSync(current)) current = dirname(current);
  return current === "/" ? null : current;
};

// 远程电脑上助理 Chrome 画在 Xvfb 上，Xvfb 不设访问控制，连上它的 socket 就能截屏、注入按键。
// 沙箱的 /tmp 本来就是空的；批准写 /tmp 下的新文件会把真 /tmp 挂进来，所以这个目录单独盖住。
const X11_SOCKET_DIR = "/tmp/.X11-unix";

const existingReal = (paths: readonly string[]): readonly string[] => [
  ...new Set(paths.map(realpathExisting).filter(existsSync)),
];

const bwrapCommand = (workDir: string, zones: ForbiddenZones, access: GateAccess, command: string): string => {
  const work = realpathExisting(workDir);
  const forbidden = existingReal([...zones.hidden, ...otherBotDirs(work), X11_SOCKET_DIR]);
  const writePaths = access.writePaths.flatMap((path) => writeMountPoint(path) ?? []);
  const args = bwrapArgs(work, { network: access.network, writePaths }, forbidden, existingReal(zones.readOnly));
  return ["bwrap", ...args, "/bin/bash", "-c", command].map(shSingleQuote).join(" ");
};

const sandboxedCommand = (
  kind: SandboxKind,
  workDir: string,
  zones: ForbiddenZones,
  access: GateAccess,
  command: string,
): string => {
  switch (kind) {
    case "seatbelt":
      return `/usr/bin/sandbox-exec -p ${shSingleQuote(sandboxProfile(workDir, access, zones))} /bin/bash -c ${shSingleQuote(command)}`;
    case "bwrap":
      return bwrapCommand(workDir, zones, access, command);
    case "none":
      return command;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const spawnHook =
  (kind: SandboxKind, workDir: string, zones: ForbiddenZones, tmpDir: string, access: GateAccess): BashSpawnHook =>
  (ctx: BashSpawnContext) => ({
    command: sandboxedCommand(kind, workDir, zones, access, ctx.command),
    cwd: workDir,
    env: whitelistEnv(ctx.env, workDir, tmpDir),
  });

export interface BashSandbox {
  readonly sandbox: SandboxKind;
  readonly tool: ReturnType<typeof createBashToolDefinition>;
  allow(runId: string, callId: string, access: GateAccess): void;
  clearRun(runId: string): void;
}

export function createSandboxedBash(
  workDir: string,
  zones: ForbiddenZones,
  activeRunId: () => string | null = () => null,
): BashSandbox {
  const kind = sandboxKind();
  const tmpDir = join(workDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const accessByRun = new Map<string, Map<string, GateAccess>>();
  const base = createBashToolDefinition(workDir);
  const tool = {
    ...base,
    executionMode: "sequential",
    execute: async (...args: Parameters<typeof base.execute>) => {
      const [callId] = args;
      const runId = activeRunId();
      const runAccess = runId === null ? undefined : accessByRun.get(runId);
      const access = runAccess?.get(callId) ?? { network: false, writePaths: [] };
      runAccess?.delete(callId);
      if (runId !== null && runAccess?.size === 0) accessByRun.delete(runId);
      const scoped = createBashToolDefinition(workDir, {
        spawnHook: spawnHook(kind, workDir, zones, tmpDir, access),
      });
      return scoped.execute(...args);
    },
  } satisfies typeof base;
  return {
    sandbox: kind,
    tool,
    allow: (runId, callId, access) => {
      if (!access.network && access.writePaths.length === 0) {
        accessByRun.get(runId)?.delete(callId);
        if (accessByRun.get(runId)?.size === 0) accessByRun.delete(runId);
        return;
      }
      const runAccess = accessByRun.get(runId) ?? new Map<string, GateAccess>();
      runAccess.set(callId, access);
      accessByRun.set(runId, runAccess);
    },
    clearRun: (runId) => {
      accessByRun.delete(runId);
    },
  };
}
