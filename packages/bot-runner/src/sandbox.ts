import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createBashToolDefinition, type BashSpawnContext, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import type { Containment } from "./contained.js";
import type { GateAccess, SandboxKind } from "./gate.js";
import { type ForbiddenZones, PathError, realpathExisting } from "./paths.js";

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"] as const;

/** 运行器在云电脑上多给的两样：额外盖住的目录，和这个 Bot 的工具箱。本机电脑是 null。 */
export interface CloudBox {
  readonly masked: readonly string[];
  readonly toolboxDir: string;
}

type ClosedContainment = Extract<Containment, { level: "closed" }>;

/** 这次调用是人批准的，还是闸门自动放行的。 */
export type BashApproval = "approved" | "automatic";

/** 批准的命令里只有这四个名字落到工具箱的 venv，其余名字和自动放行时解析到同一个文件。 */
const TOOLBOX_NAMES = ["pip", "pip3", "python", "python3"] as const;

const toolboxShimDir = (toolboxDir: string): string => join(dirname(toolboxDir), "toolbox-bin");

/**
 * 批准的命令的 PATH：四个名字的 shim 在最前，系统目录居中，venv/bin 垫底。pip 装进来的 black 这类程序还能用，
 * 但盖不住系统同名程序。
 * 自动放行的命令跑的是 `containment.searchPath`，和证明器判命令名用的同一串。
 */
export const toolboxSearchPath = (containment: ClosedContainment): string =>
  `${toolboxShimDir(containment.toolboxDir)}:${containment.searchPath}:${join(containment.toolboxDir, "venv", "bin")}`;

// shim 不能是软链：Python 按可执行文件旁边的 pyvenv.cfg 认 venv，软链过去 sys.prefix 退回系统。
// shim 目录在 Bot 目录下、工具箱之外，工作区和批准的装包都写不到；但 S-8 下批准的写可能放开整个 Bot 目录，
// 所以每次在新建的空目录里写好再整个换上去：多放的程序、预先埋的软链都留不下，也不跟着软链写到别处。
const writeToolboxShims = (containment: ClosedContainment): void => {
  const dir = toolboxShimDir(containment.toolboxDir);
  const botDir = dirname(dir);
  if (lstatSync(botDir).isSymbolicLink()) {
    throw new Error(`Bot 目录 ${botDir} 是软链，工具箱入口不往链过去的地方写，这条命令没有执行。`);
  }
  const venvBin = join(containment.toolboxDir, "venv", "bin");
  const systemDirs = containment.searchPath
    .split(":")
    .filter((entry) => entry !== "")
    .map(shSingleQuote)
    .join(" ");
  const fresh = mkdtempSync(join(botDir, ".toolbox-bin-"));
  for (const name of TOOLBOX_NAMES) {
    const target = shSingleQuote(join(venvBin, name));
    const script = [
      "#!/bin/sh",
      `[ -x ${target} ] && exec ${target} "$@"`,
      `for dir in ${systemDirs}; do [ -x "$dir/${name}" ] && exec "$dir/${name}" "$@"; done`,
      `echo "${name}: command not found" >&2`,
      "exit 127",
      "",
    ].join("\n");
    writeFileSync(join(fresh, name), script, { flag: "wx" });
    chmodSync(join(fresh, name), 0o755);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(fresh, dir);
};
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

// 云电脑的 HOME=/home/node 在只读根上，包管理器写不进默认缓存就装不上；缓存改指到沙箱私有的 /tmp 里，每条命令都是新挂的，
// 没批准的命令改写不了下一次批准的装包会信任的 wheel 和 index，代价是每次装包重新下载。
// 工作区的 .npmrc、.yarnrc、.pnpmfile.cjs 是 Bot 不问就能写的：env 里的 registry 盖过 .npmrc，yarn-path 和 pnpmfile 关掉，
// 批准的装包从哪下、跑哪个 yarn、跑哪段钩子就不由工作区定。
export function whitelistEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  tmpDir: string,
  cloud: Pick<ClosedContainment, "searchPath"> | null = null,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { PWD: cwd, TMPDIR: tmpDir };
  for (const key of ENV_ALLOW) {
    const value = env[key];
    if (value !== undefined) next[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PI_") && value !== undefined) next[key] = value;
  }
  if (cloud !== null) {
    next["PATH"] = cloud.searchPath;
    next["XDG_CACHE_HOME"] = "/tmp/cache";
    next["npm_config_cache"] = "/tmp/cache/npm";
    next["npm_config_store_dir"] = "/tmp/cache/pnpm-store";
    next["PIP_CACHE_DIR"] = "/tmp/cache/pip";
    next["YARN_CACHE_FOLDER"] = "/tmp/cache/yarn";
    next["npm_config_registry"] = env["npm_config_registry"] ?? "https://registry.npmjs.org/";
    next["npm_config_ignore_pnpmfile"] = "true";
    next["YARN_IGNORE_PATH"] = "1";
  }
  return next;
}

/**
 * 批准写工具箱的那条命令先把 venv 建出来。系统 python3 没带 pip，venv 的 ensurepip 会带上；建过一次就跳过。
 * cwd 是工作区，`python3 -m` 默认把 cwd 放在 sys.path 头上，工作区里的 venv.py、./pip/ 就顶掉了真模块：
 * 建 venv 用 -I，装包整条命令带 PYTHONSAFEPATH。
 */
export const toolboxCommand = (toolboxDir: string, access: GateAccess, command: string): string => {
  if (!access.writePaths.includes(toolboxDir)) return command;
  const venv = join(toolboxDir, "venv");
  return `export PYTHONSAFEPATH=1; { [ -x ${shSingleQuote(join(venv, "bin", "pip"))} ] || python3 -I -m venv ${shSingleQuote(venv)}; } && ${command}`;
};

// 禁区来自配置，Bot 改不动它；解不出来就是配置本身的问题，报错点名那一项，让用户知道改哪里。
const realZone = (zones: ForbiddenZones, prefix: string): string => {
  try {
    return realpathExisting(prefix);
  } catch (error) {
    if (error instanceof PathError && prefix === zones.browserProfileDir) {
      throw new PathError(
        `config.browser.profileDir 指向的助理 Chrome profile 解不出真实路径，请让用户改这项配置：${error.message}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
};

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
    ...access.writePaths.flatMap((path) => {
      const real = realpathExisting(path);
      return [`(allow file-write* (subpath ${seatbeltString(real)}))`];
    }),
    `(deny file-read* file-write* (subpath ${seatbeltString(realpathExisting(zones.dataDir))}))`,
    // Node、git 和 mkdir 的绝对路径校验会逐段 stat；只放数据根本身的元数据，不放列目录或文件内容。
    `(allow file-read-metadata (literal ${seatbeltString(realpathExisting(zones.dataDir))}))`,
    `(allow file-read* (subpath ${seatbeltString(realpathExisting(zones.botDir))}))`,
    `(allow file-read* file-write* (subpath ${seatbeltString(realpathExisting(zones.sharedDir))}))`,
    `(allow file-write* (subpath ${seatbeltString(work)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/stdout"))',
    '(allow file-write* (literal "/dev/stderr"))',
    '(allow file-write* (literal "/dev/fd/1"))',
    '(allow file-write* (literal "/dev/fd/2"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
    // 根被换成指向其他 Bot 的链接后，下次 realpath 会把放行范围移过去；只准修改根里面的文件。
    `(deny file-write* (literal ${seatbeltString(work)}))`,
    `(deny file-write* (literal ${seatbeltString(realpathExisting(zones.sharedDir))}))`,
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
      const real = seatbeltString(realZone(zones, prefix));
      return [
        `(deny file-read* (subpath ${real}))`,
        `(deny file-write* (subpath ${real}))`,
        `(deny network-outbound (remote unix-socket (subpath ${real})))`,
      ];
    }),
    ...zones.readOnly.map((prefix) => `(deny file-write* (subpath ${seatbeltString(realZone(zones, prefix))}))`),
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
 * 包缓存的 /tmp/cache 在写路径之后再新挂一次：批准写 /tmp 时真 /tmp 绑进来，缓存不能借它留到下一条命令。
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
  sharedDir: string,
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
    "--bind",
    sharedDir,
    sharedDir,
    ...access.writePaths.flatMap((path) => ["--bind", path, path]),
    "--tmpfs",
    "/tmp/cache",
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

export const otherBotDirs = (botDir: string, sharedDir: string, directories: readonly string[]): readonly string[] =>
  directories.filter((path) => path !== botDir && path !== sharedDir);

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

const existingReal = (zones: ForbiddenZones, paths: readonly string[]): readonly string[] => [
  ...new Set(paths.map((path) => realZone(zones, path)).filter(existsSync)),
];

/** `masked` 是运行器按电脑额外盖住的目录：云电脑放宽了询问，自己的 Pi 配置和会话记录也不给 bash 看。 */
export const bwrapCommand = (
  workDir: string,
  zones: ForbiddenZones,
  access: GateAccess,
  command: string,
  masked: readonly string[],
): string => {
  const work = realpathExisting(workDir);
  const shared = realpathExisting(zones.sharedDir);
  const directories = readdirSync(realpathExisting(zones.dataDir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => realpathExisting(join(zones.dataDir, entry.name)));
  const forbidden = existingReal(zones, [
    ...zones.hidden,
    ...otherBotDirs(realpathExisting(zones.botDir), shared, directories),
    X11_SOCKET_DIR,
    ...masked,
  ]);
  const writePaths = access.writePaths.flatMap((path) => writeMountPoint(path) ?? []);
  const args = bwrapArgs(
    work,
    { network: access.network, writePaths },
    forbidden,
    existingReal(zones, zones.readOnly),
    shared,
  );
  return ["bwrap", ...args, "/bin/bash", "-c", command].map(shSingleQuote).join(" ");
};

const sandboxedCommand = (
  kind: SandboxKind,
  workDir: string,
  zones: ForbiddenZones,
  access: GateAccess,
  command: string,
  masked: readonly string[],
): string => {
  switch (kind) {
    case "seatbelt":
      return `/usr/bin/sandbox-exec -p ${shSingleQuote(sandboxProfile(workDir, access, zones))} /bin/bash -c ${shSingleQuote(command)}`;
    case "bwrap":
      return bwrapCommand(workDir, zones, access, command, masked);
    case "none":
      return command;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const spawnHook =
  (
    kind: SandboxKind,
    workDir: string,
    zones: ForbiddenZones,
    tmpDir: string,
    permit: BashPermit,
    cloud: CloudBox | null,
    containment: Containment,
  ): BashSpawnHook =>
  (ctx: BashSpawnContext) => {
    const closed = containment.level === "closed" ? containment : null;
    const command = closed === null ? ctx.command : toolboxCommand(closed.toolboxDir, permit.access, ctx.command);
    // 按授权自动放行的装包没人点批准，但和批准的装包一样要落到工具箱的 pip。
    const toolbox =
      closed !== null && (permit.approval === "approved" || permit.access.writePaths.includes(closed.toolboxDir));
    if (toolbox) writeToolboxShims(closed);
    const searchPath = closed === null ? null : toolbox ? toolboxSearchPath(closed) : closed.searchPath;
    return {
      command: sandboxedCommand(kind, workDir, zones, permit.access, command, cloud?.masked ?? []),
      cwd: workDir,
      env: whitelistEnv(ctx.env, workDir, tmpDir, searchPath === null ? null : { searchPath }),
    };
  };

interface BashPermit {
  readonly access: GateAccess;
  readonly approval: BashApproval;
}

const AUTOMATIC: BashPermit = { access: { network: false, writePaths: [] }, approval: "automatic" };

export interface BashSandbox {
  readonly sandbox: SandboxKind;
  /** 闸门要的 containment 从这里拿，证明器用的 PATH 就是自动放行的命令真正跑的 PATH。 */
  readonly containment: Containment;
  readonly tool: ReturnType<typeof createBashToolDefinition>;
  allow(runId: string, callId: string, access: GateAccess, approval: BashApproval): void;
  clearRun(runId: string): void;
}

export function createSandboxedBash(
  workDir: string,
  zones: ForbiddenZones,
  activeRunId: () => string | null = () => null,
  cloud: CloudBox | null = null,
): BashSandbox {
  const kind = sandboxKind();
  const tmpDir = join(workDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const containment: Containment =
    cloud === null
      ? { level: "none" }
      : { level: "closed", searchPath: process.env["PATH"] ?? "", toolboxDir: cloud.toolboxDir };
  if (containment.level === "closed") writeToolboxShims(containment);
  const permitsByRun = new Map<string, Map<string, BashPermit>>();
  const base = createBashToolDefinition(workDir);
  const tool = {
    ...base,
    executionMode: "sequential",
    execute: async (...args: Parameters<typeof base.execute>) => {
      const [callId] = args;
      const runId = activeRunId();
      const permits = runId === null ? undefined : permitsByRun.get(runId);
      const permit = permits?.get(callId) ?? AUTOMATIC;
      permits?.delete(callId);
      if (runId !== null && permits?.size === 0) permitsByRun.delete(runId);
      const scoped = createBashToolDefinition(workDir, {
        spawnHook: spawnHook(kind, workDir, zones, tmpDir, permit, cloud, containment),
      });
      return scoped.execute(...args);
    },
  } satisfies typeof base;
  return {
    sandbox: kind,
    containment,
    tool,
    allow: (runId, callId, access, approval) => {
      if (approval === "automatic" && !access.network && access.writePaths.length === 0) {
        permitsByRun.get(runId)?.delete(callId);
        if (permitsByRun.get(runId)?.size === 0) permitsByRun.delete(runId);
        return;
      }
      const permits = permitsByRun.get(runId) ?? new Map<string, BashPermit>();
      permits.set(callId, { access, approval });
      permitsByRun.set(runId, permits);
    },
    clearRun: (runId) => {
      permitsByRun.delete(runId);
    },
  };
}
