import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { BotId, type CliToolConfig, type CliToolId, redactCredential } from "@baize/shared";
import { createBashToolDefinition, type BashSpawnContext, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import {
  type ClosedContainment,
  type Containment,
  HOME_LOCKED_DIRS,
  HOME_LOCKED_FILES,
  homeBinDir,
  homeLockedPaths,
  toolboxNodeDir,
  toolboxSearchPath,
  toolboxShimDir,
} from "./contained.js";
import type { GateAccess, SandboxKind } from "./gate.js";
import { botDirs, type ForbiddenZones, hostHidden, PathError, realpathExisting } from "./paths.js";

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"] as const;

/** 运行器在云电脑上多给的：这个 Bot 的工具箱和整台电脑共用的 HOME。本机电脑是 null。 */
export interface CloudBox {
  readonly toolboxDir: string;
  readonly homeDir: string;
}

/** 云电脑上只有这四个名字落到工具箱的 venv，其余名字落到系统目录。 */
const TOOLBOX_NAMES = ["pip", "pip3", "python", "python3"] as const;

// shim 不能是软链：Python 按可执行文件旁边的 pyvenv.cfg 认 venv，软链过去 sys.prefix 退回系统。
// shim 目录在 Bot 目录下、工具箱之外，工作区和批准的装包都写不到；但 S-8 下批准的写可能放开整个 Bot 目录，
// 所以每条命令起之前在新建的空目录里写好再整个换上去：多放的程序、预先埋的软链都留不下，也不跟着软链写到别处。
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

// 云电脑的 HOME 换成数据目录下共用的那份，主人在终端里登录的 CLI 读得到登录态；它平时只读，只有登记的命令行工具写得进。
// 包管理器写不进 HOME 下的默认缓存就装不上；缓存改指到沙箱私有的 /tmp 里，每条命令都是新挂的，
// 没批准的命令改写不了下一次批准的装包会信任的 wheel 和 index，代价是每次装包重新下载。
// 工作区的 .npmrc、.yarnrc、.pnpmfile.cjs 是 Bot 不问就能写的：env 里的 registry 盖过 .npmrc，yarn-path 和 pnpmfile 关掉，
// 批准的装包从哪下、跑哪个 yarn、跑哪段钩子就不由工作区定。
// toolEnv 只在闸门把整条命令判成命令行工具时才有，排在最后、不盖住上面定好的键。
export function whitelistEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
  tmpDir: string,
  cloud: Pick<ClosedContainment, "searchPath" | "homeDir"> | null = null,
  toolEnv: Readonly<Record<string, string>> = {},
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
    next["HOME"] = cloud.homeDir;
    next["XDG_CACHE_HOME"] = "/tmp/cache";
    next["npm_config_cache"] = "/tmp/cache/npm";
    next["npm_config_store_dir"] = "/tmp/cache/pnpm-store";
    next["PIP_CACHE_DIR"] = "/tmp/cache/pip";
    next["YARN_CACHE_FOLDER"] = "/tmp/cache/yarn";
    next["npm_config_registry"] = env["npm_config_registry"] ?? "https://registry.npmjs.org/";
    next["npm_config_ignore_pnpmfile"] = "true";
    next["YARN_IGNORE_PATH"] = "1";
  }
  for (const [key, value] of Object.entries(toolEnv)) {
    if (!(key in next)) next[key] = value;
  }
  return next;
}

/**
 * 批准写工具箱的那条命令先把 venv 建出来。系统 python3 没带 pip，venv 的 ensurepip 会带上；建过一次就跳过。
 * cwd 是工作区，`python3 -m` 默认把 cwd 放在 sys.path 头上，工作区里的 venv.py、./pip/ 就顶掉了真模块：
 * 建 venv 用 -I，装包整条命令带 PYTHONSAFEPATH。
 */
export const toolboxCommand = (toolboxDir: string, access: GateAccess, command: string): string => {
  // npm 的 prefix 只用环境变量给：命令行上的 --prefix 由 Bot 写，盖过它也写不出沙箱放开的这一个目录。
  const nodeDir = toolboxNodeDir(toolboxDir);
  if (access.writePaths.includes(nodeDir)) return `export NPM_CONFIG_PREFIX=${shSingleQuote(nodeDir)}; ${command}`;
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

// 真正跑命令时建的 namespace 探测时一个不少：宿主不许非特权建 user namespace 时探测就失败，回落成每条都问，
// 不会探测通过、之后每条命令都起不来。
const NAMESPACES = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"] as const;

export const BWRAP_PROBE_ARGS: readonly string[] = ["--ro-bind", "/", "/", ...NAMESPACES, "--unshare-net", "true"];

const detectSandbox = (): SandboxKind => {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform !== "linux") {
    console.warn(`这台电脑是 ${process.platform}，没有 bash 沙箱，Bot 的每条 bash 都要问`);
    return "none";
  }
  const probe = spawnSync("bwrap", BWRAP_PROBE_ARGS, { encoding: "utf8" });
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

/** 入参都已是 realpath，都已存在：只读根上建不了挂载点，不存在的路径会让 bwrap 报「Can't mkdir parents ... Read-only file system」。 */
export interface BwrapMounts {
  /** 整块用 tmpfs 盖住。之后新建的 Bot 目录也落在被盖住的这一块里，不用按当时的目录列表逐个遮。 */
  readonly dataDir: string;
  readonly workDir: string;
  readonly sharedDir: string;
  /** 盖住数据目录之后只读挂回的自己的目录。批准写它们（比如装包写工具箱）时可写的那份叠在上面。 */
  readonly ownReadable: readonly string[];
  /** 批准写它的祖先也改不动。 */
  readonly readOnly: readonly string[];
  readonly forbidden: readonly string[];
}

const isUnder = (path: string, root: string): boolean => path.startsWith(`${root}/`);
const bind = (path: string): string[] => ["--bind", path, path];
const roBind = (path: string): string[] => ["--ro-bind", path, path];

/**
 * bwrap 按参数顺序叠挂载，后挂的盖住先挂的。
 * 批准的写路径在数据目录外（包括数据目录本身和它的祖先）的，挂在盖住数据目录之前，放开再大也看不见别的 Bot；
 * 在数据目录里的（工具箱、自己的 Bot 目录）挂在挂回的只读目录之后。
 * 包缓存的 /tmp/cache 在写路径之后再新挂一次：批准写 /tmp 时真 /tmp 绑进来，缓存不能借它留到下一条命令。
 * 禁区放在所有 bind 之后：禁区落在工作目录或批准的写路径里面时照样被盖住；工作目录本身落在禁区里时 --chdir 失败，命令起不来。
 * 空 tmpfs 默认可写，写进去的东西随沙箱消失，命令却报成功，所以再逐个 --remount-ro。先挂完全部 tmpfs 再改只读，
 * 里层的挂载点还建得出来；--remount-ro 只改这一层，挂在里面的工作目录照样可写。
 * 不挂 --proc：docker 遮住了部分 /proc，新挂 proc 会失败，沙箱和容器共用 /proc。挡住 /proc/<pid>/root、environ 的是
 * 沙箱在自己的 user namespace 里，跨 namespace 不许 ptrace 读，所以 --unshare-user 显式写上，不靠 bwrap 隐式建。
 *
 * session 默认 "new"：Bot 的命令脱离控制终端，TIOCSTI 塞不回运行器。网页终端传 "inherit"，不然 bash 没有控制终端，
 * 作业控制和 Ctrl-C 都失效。
 */
export function bwrapArgs(
  mounts: BwrapMounts,
  access: GateAccess,
  session: "new" | "inherit" = "new",
): readonly string[] {
  return [
    ...roBind("/"),
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...access.writePaths.filter((path) => !isUnder(path, mounts.dataDir)).flatMap(bind),
    "--tmpfs",
    "/tmp/cache",
    "--tmpfs",
    mounts.dataDir,
    ...mounts.ownReadable.flatMap(roBind),
    ...bind(mounts.workDir),
    ...bind(mounts.sharedDir),
    ...access.writePaths.filter((path) => isUnder(path, mounts.dataDir)).flatMap(bind),
    ...mounts.readOnly.flatMap(roBind),
    ...mounts.forbidden.flatMap((path) => ["--tmpfs", path]),
    ...[...mounts.forbidden, mounts.dataDir].flatMap((path) => ["--remount-ro", path]),
    ...NAMESPACES,
    "--die-with-parent",
    ...(session === "new" ? ["--new-session"] : []),
    ...(access.network ? [] : ["--unshare-net"]),
    "--chdir",
    mounts.workDir,
  ];
}

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

/** 只读挂回要求源存在：不存在的锁定路径事先建成空的，不然工具命令能新建一个 .bashrc。已有的不动。 */
const ensureHomeLocked = (homeDir: string): void => {
  for (const name of HOME_LOCKED_DIRS) mkdirSync(join(homeDir, name), { recursive: true });
  for (const name of HOME_LOCKED_FILES) {
    try {
      // ~/.inputrc 存在 readline 就不读 /etc/inputrc，空文件会让主人终端里的 Home、End 这类键失灵。
      writeFileSync(join(homeDir, name), name === ".inputrc" ? "$include /etc/inputrc\n" : "", { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
};

/**
 * 自己的 Pi 配置和会话记录（agent、sessions）不挂回，bash 看不见。云电脑的 HOME 只读挂回，批准写它时可写的那份叠在上面，
 * 再在可写的那份之上只读挂回 .local 和 shell 启动文件。
 */
export const bwrapCommand = (
  workDir: string,
  zones: ForbiddenZones,
  access: GateAccess,
  command: string,
  homeDir: string | null = null,
): string => {
  const own = botDirs(zones.dataDir, BotId.parse(basename(zones.botDir)));
  const args = bwrapArgs(
    {
      dataDir: zones.dataDir,
      workDir: realpathExisting(workDir),
      sharedDir: realpathExisting(zones.sharedDir),
      ownReadable: existingReal(zones, [
        own.skillsDir,
        own.toolboxDir,
        toolboxShimDir(own.toolboxDir),
        ...(homeDir === null ? [] : [homeDir]),
      ]),
      readOnly: existingReal(zones, [...zones.readOnly, ...(homeDir === null ? [] : homeLockedPaths(homeDir))]),
      forbidden: existingReal(zones, [
        ...zones.hidden,
        ...(homeDir === null ? [] : hostHidden(homeDir)),
        X11_SOCKET_DIR,
      ]),
    },
    { network: access.network, writePaths: access.writePaths.flatMap((path) => writeMountPoint(path) ?? []) },
  );
  return ["bwrap", ...args, "/bin/bash", "-c", command].map(shSingleQuote).join(" ");
};

const sandboxedCommand = (
  kind: SandboxKind,
  workDir: string,
  zones: ForbiddenZones,
  access: GateAccess,
  command: string,
  homeDir: string | null,
): string => {
  switch (kind) {
    case "seatbelt":
      return `/usr/bin/sandbox-exec -p ${shSingleQuote(sandboxProfile(workDir, access, zones))} /bin/bash -c ${shSingleQuote(command)}`;
    case "bwrap":
      return bwrapCommand(workDir, zones, access, command, homeDir);
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
    permit: GateAccess,
    containment: Containment,
    toolEnv: Readonly<Record<string, string>>,
  ): BashSpawnHook =>
  (ctx: BashSpawnContext) => {
    const closed = containment.level === "closed" ? containment : null;
    const command = closed === null ? ctx.command : toolboxCommand(closed.toolboxDir, permit, ctx.command);
    if (closed !== null) writeToolboxShims(closed);
    return {
      command: sandboxedCommand(kind, workDir, zones, permit, command, closed?.homeDir ?? null),
      cwd: workDir,
      env: whitelistEnv(
        ctx.env,
        workDir,
        tmpDir,
        closed === null ? null : { searchPath: toolboxSearchPath(closed), homeDir: closed.homeDir },
        toolEnv,
      ),
    };
  };

/** 闸门给的工具 id 换成这一刻配置里的 env。只在云电脑上给：Mac 和本机没有工具箱 PATH，同名的系统程序会拿到值。 */
const envForTools = (
  ids: readonly CliToolId[],
  tools: readonly CliToolConfig[],
  containment: Containment,
): Record<string, string> => {
  if (containment.level !== "closed") return {};
  const env: Record<string, string> = {};
  for (const tool of tools) {
    if (!ids.includes(tool.id)) continue;
    for (const entry of tool.env) env[entry.name] = entry.value;
  }
  return env;
};

/** 每个值单独换，长的先换：短值是长值的一截时，先换短的会把长值切碎留下尾巴。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].toSorted((a, b) => b.length - a.length);
  return ordered.reduce((out, secret) => redactCredential(out, secret), text);
}

const redactDeep = (value: unknown, secrets: readonly string[]): unknown => {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)]));
  }
  return value;
};

const redactError = (error: unknown, secrets: readonly string[]): unknown => {
  if (!(error instanceof Error)) return error;
  const redacted = new Error(redactSecrets(error.message, secrets));
  redacted.name = error.name;
  return redacted;
};

const FULL_OUTPUT_IN_ERROR = /Full output: ([^\]\n]+)\]/g;

/** Pi 截断时把完整输出写进 tmpdir 下的 pi-bash-*.log，模型能 read 它，所以也要换。只认 Pi 自己起的那种文件名。 */
const redactOutputFile = (path: string | undefined, secrets: readonly string[]): void => {
  if (path === undefined || dirname(path) !== tmpdir()) return;
  const name = basename(path);
  if (!name.startsWith("pi-bash-") || !name.endsWith(".log")) return;
  try {
    if (!lstatSync(path).isFile()) return;
    const text = readFileSync(path, "utf8");
    const redacted = redactSecrets(text, secrets);
    if (redacted !== text) writeFileSync(path, redacted);
  } catch {
    // 文件已被清掉就没有可换的
  }
};

const AUTOMATIC: GateAccess = { network: false, writePaths: [] };

export interface BashSandbox {
  readonly sandbox: SandboxKind;
  /** 闸门要的 containment 从这里拿，批 pip 时放开写的工具箱就是这里的 toolboxDir。 */
  readonly containment: Containment;
  readonly tool: ReturnType<typeof createBashToolDefinition>;
  allow(runId: string, callId: string, access: GateAccess): void;
  clearRun(runId: string): void;
}

export function createSandboxedBash(
  workDir: string,
  zones: ForbiddenZones,
  activeRunId: () => string | null = () => null,
  cloud: CloudBox | null = null,
  cliTools: () => readonly CliToolConfig[] = () => [],
): BashSandbox {
  const kind = sandboxKind();
  const tmpDir = join(workDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const containment: Containment =
    cloud === null
      ? { level: "none" }
      : {
          level: "closed",
          searchPath: process.env["PATH"] ?? "",
          toolboxDir: cloud.toolboxDir,
          homeDir: cloud.homeDir,
        };
  if (containment.level === "closed") {
    writeToolboxShims(containment);
    // bwrap 只能 bind 已存在的路径：批准 npm -g 时不存在就会退到放开整个工具箱；HOME 不存在就挂不回来。
    mkdirSync(toolboxNodeDir(containment.toolboxDir), { recursive: true });
    mkdirSync(containment.homeDir, { recursive: true });
    ensureHomeLocked(containment.homeDir);
  }
  const permitsByRun = new Map<string, Map<string, GateAccess>>();
  const base = createBashToolDefinition(workDir);
  const tool = {
    ...base,
    executionMode: "sequential",
    execute: async (...args: Parameters<typeof base.execute>) => {
      const [callId, params, signal, onUpdate, ctx] = args;
      const runId = activeRunId();
      const permits = runId === null ? undefined : permitsByRun.get(runId);
      const permit = permits?.get(callId) ?? AUTOMATIC;
      permits?.delete(callId);
      if (runId !== null && permits?.size === 0) permitsByRun.delete(runId);
      const tools = cliTools();
      const toolEnv = envForTools(permit.cliTools ?? [], tools, containment);
      // 结果进模型、进会话记录（工作记录从它镜像）之前换掉：这个 Bot 拿得到的值都换，不只这条命令注入的。
      const secrets = [...tools.flatMap((one) => one.env.map((entry) => entry.value)), ...Object.values(toolEnv)];
      const scoped = createBashToolDefinition(workDir, {
        spawnHook: spawnHook(kind, workDir, zones, tmpDir, permit, containment, toolEnv),
      });
      if (secrets.length === 0) return scoped.execute(...args);
      const update: typeof onUpdate =
        onUpdate === undefined ? undefined : (partial) => onUpdate(redactDeep(partial, secrets) as typeof partial);
      try {
        const result = await scoped.execute(callId, params, signal, update, ctx);
        redactOutputFile(result.details?.fullOutputPath, secrets);
        return redactDeep(result, secrets) as typeof result;
      } catch (error) {
        if (error instanceof Error) {
          for (const match of error.message.matchAll(FULL_OUTPUT_IN_ERROR)) redactOutputFile(match[1], secrets);
        }
        throw redactError(error, secrets);
      }
    },
  } satisfies typeof base;
  return {
    sandbox: kind,
    containment,
    tool,
    allow: (runId, callId, access) => {
      if (!access.network && access.writePaths.length === 0 && (access.cliTools ?? []).length === 0) {
        permitsByRun.get(runId)?.delete(callId);
        if (permitsByRun.get(runId)?.size === 0) permitsByRun.delete(runId);
        return;
      }
      const permits = permitsByRun.get(runId) ?? new Map<string, GateAccess>();
      permits.set(callId, access);
      permitsByRun.set(runId, permits);
    },
    clearRun: (runId) => {
      permitsByRun.delete(runId);
    },
  };
}

export interface TerminalSpawn {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/**
 * 云电脑上网页终端的那个 bash。挂载和 Bot 的命令同一套，工作目录换成共用的 HOME：数据目录整块盖住，只有 HOME 和共享区可写，
 * 网络开着。不另起会话，bash 才有控制终端，作业控制和 Ctrl-C 才管用。不带 -l：Debian 的 /etc/profile 会把 PATH 重设回去，
 * HOME 的 .local/bin 就没了。三个入参都必须已经存在。
 */
export function terminalSpawn(dataDir: string, homeDir: string, sharedDir: string): TerminalSpawn {
  const home = realpathExisting(homeDir);
  const data = realpathExisting(dataDir);
  // 数据目录整块盖住了，里面的助理 Chrome profile 不用再列；外面的禁区和 Bot 的命令同一份。
  const hidden = [...new Set(hostHidden().map(realpathExisting))].filter(
    (path) => existsSync(path) && path !== data && !isUnder(path, data),
  );
  const args = bwrapArgs(
    {
      dataDir: data,
      workDir: home,
      sharedDir: realpathExisting(sharedDir),
      ownReadable: [],
      readOnly: [],
      forbidden: [...hidden, X11_SOCKET_DIR],
    },
    { network: true, writePaths: [] },
    "inherit",
  );
  const user = process.env["USER"] ?? userInfo().username;
  return {
    file: "bwrap",
    args: [...args, "/bin/bash", "-i"],
    env: {
      HOME: home,
      PATH: `${homeBinDir(home)}:${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      NPM_CONFIG_PREFIX: join(home, ".local"),
      USER: user,
      LOGNAME: user,
      SHELL: "/bin/bash",
    },
  };
}
