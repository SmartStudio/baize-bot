import { lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BotId, GroupId } from "@baize/shared";

// Pi 有四个独立的落盘回落点，不给就各自回落到 ~/.pi/agent：
// createAgentSession 的 agentDir、DefaultResourceLoader 的 agentDir、
// ModelRuntime 的 authPath / modelsPath / modelsStorePath、SessionManager.continueRecent 的第二参。
// 一台电脑上多个 Bot 共用一个进程，串到 ~/.pi 就等于串到别的 Bot 头上。

export interface BotDirs {
  /** Pi 的 agentDir。auth.json 和 models-store.json 落在这里。 */
  readonly agentDir: string;
  /** 会话根目录。每个群的 JSONL 在 `<sessionDir>/<groupId>/`。 */
  readonly sessionDir: string;
  /** 会话的 cwd，Bot 干活的地方。 */
  readonly workDir: string;
  /** `config.skills` 落成的 `<skillId>/SKILL.md`，Pi 的 `additionalSkillPaths` 指到这里。 */
  readonly skillsDir: string;
  /** 配图起草时拷到这里，按 sha256 命名。Bot 能读不能写，发布时拿到的就是起草时的字节。 */
  readonly draftsDir: string;
  /** 所有 Bot 共用的产出目录。 */
  readonly sharedDir: string;
  /** 云电脑上这个 Bot 自己装的 Python 包：`venv/` 在它下面，沙箱 bash 的 PATH 把 `venv/bin` 放最前。平时只读，批了 pip 才可写。 */
  readonly toolboxDir: string;
}

// GroupId 在边界上已经是这段正则。这里再挡一次：拼路径时不改写，对不上就拒绝。
const GROUP_DIR_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** 这个群的会话目录，SessionManager.continueRecent 的第二参。 */
export function groupSessionDir(dirs: BotDirs, groupId: GroupId): string {
  if (!GROUP_DIR_NAME.test(groupId)) throw new Error(`groupId 不能当会话目录：${groupId}`);
  return join(dirs.sessionDir, groupId);
}

export function botDirs(dataDir: string, botId: BotId): BotDirs {
  const root = join(dataDir, botId);
  return {
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    workDir: join(root, "work"),
    skillsDir: join(root, "skills"),
    draftsDir: join(root, "drafts"),
    sharedDir: resolve(dataDir, "shared"),
    toolboxDir: join(root, "toolbox"),
  };
}

// 工具箱也先建出来：bwrap 只能 bind 已存在的路径，批准写一个还不存在的工具箱会退到放开整个 Bot 目录。
export function ensureBotDirs(dirs: BotDirs): BotDirs {
  for (const dir of [
    dirs.agentDir,
    dirs.sessionDir,
    dirs.workDir,
    dirs.skillsDir,
    dirs.draftsDir,
    dirs.sharedDir,
    dirs.toolboxDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

/** 闸门和两种沙箱共用的禁区。hidden 读写都不行，readOnly 能读不能写。 */
export interface ForbiddenZones {
  readonly dataDir: string;
  readonly botDir: string;
  readonly sharedDir: string;
  readonly hidden: readonly string[];
  readonly readOnly: readonly string[];
  /** `hidden` 里来自 `config.browser.profileDir` 的那一条，解不出真实路径时报错要点名这项配置。 */
  readonly browserProfileDir: string | null;
}

// 助理 Chrome 的 profile 只认 config 给的路径，不按数据目录的布局去猜：猜错了等于没禁。
export function forbiddenZones(
  dirs: Pick<BotDirs, "draftsDir" | "workDir" | "sharedDir">,
  browserProfileDir: string | null,
): ForbiddenZones {
  const home = homedir();
  const botDir = dirname(dirs.workDir);
  const dataDir = realpathExisting(dirname(botDir));
  const realBotDir = realpathExisting(botDir);
  const sharedDir = realpathExisting(dirs.sharedDir);
  if (
    realBotDir !== join(dataDir, basename(botDir)) ||
    realpathExisting(dirs.workDir) !== join(realBotDir, "work") ||
    sharedDir !== join(dataDir, "shared")
  ) {
    throw new PathError("Bot 目录隔离配置无效：Bot、工作目录和共享区的根不能通过符号链接指向其他位置。");
  }
  return {
    dataDir,
    botDir: realBotDir,
    sharedDir,
    hidden: [
      join(home, ".ssh"),
      join(home, "Library", "Keychains"),
      "/Library/Keychains",
      join(home, "Library", "Application Support", "Google", "Chrome"),
      join(home, "Library", "Application Support", "Chromium"),
      join(home, "Library", "Application Support", "Microsoft Edge"),
      join(home, "Library", "Application Support", "Firefox", "Profiles"),
      join(home, ".config", "google-chrome"),
      join(home, ".config", "chromium"),
      join(home, ".mozilla", "firefox"),
      ...(browserProfileDir === null ? [] : [browserProfileDir]),
    ],
    readOnly: [dirs.draftsDir],
    browserProfileDir,
  };
}

/** 路径按 Pi 的规则解不出来（比如 `file://` 带了主机名）。闸门拿到它就拒绝，不猜。 */
export class PathError extends Error {}

/** 符号链接成环或套得太深，解不到真正的目标。调用方可以按这一类单独给出路。 */
export class LinkLoopError extends PathError {}

// 下面三段是 Pi dist/utils/paths.js 的 normalizePath / resolvePath 的移植，参数固定成 read、write、edit 打开文件时用的
// `{ normalizeUnicodeSpaces: true, stripAtPrefix: true }`。Pi 没有导出它们；gate.test.ts 拿同一批输入和 Pi 对账。
// 闸门看到的路径必须和 Pi 真正打开的是同一个文件，少一条规则就是一条绕过。
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const normalizeWindowsShellPath = (filePath: string): string => {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(filePath);
  if (match === null || match[1] === undefined) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
};

const normalizeLikePi = (input: string): string => {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch (error) {
      throw new PathError(`file:// 地址解不出本地路径：${normalized}`, { cause: error });
    }
  }
  return normalized;
};

export function logicalResolve(input: string, cwd: string): string {
  const normalized = normalizeLikePi(input);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/** 沿链接往下解最多这么多层，和 Linux 内核的 MAXSYMLINKS 一样；macOS 内核是 32，套到这里 Pi 的 open 早已报 ELOOP。 */
const MAX_LINK_HOPS = 40;

const errorCode = (error: unknown): unknown =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

const realOrSelf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * 内核解链接目标串的顺序：逐段往下走，`..` 退的是已解开链接的目录。`path.resolve` 是字面归一化，`dirlink/../x`
 * 会把 `dirlink/..` 直接抵消，而内核先进 dirlink 的真实目录再退一级，两者落点不同，字面算法就是一条绕过。
 */
const walkTarget = (base: string, raw: string): string => {
  let current = base;
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(realOrSelf(current)) : join(current, part);
  }
  return current;
};

/**
 * `path` 是符号链接就给出它指向的绝对路径，不是链接或读不到返回 null。相对目标的基准是链接所在目录的字面路径：
 * `..` 在 walkTarget 里先 realpath 再退，其余段由调用方接着 realpath，所以基准不必先解开。
 */
const linkTarget = (path: string): string | null => {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    const raw = readlinkSync(path);
    return isAbsolute(raw) ? walkTarget("/", raw) : walkTarget(dirname(path), raw);
  } catch {
    return null;
  }
};

/**
 * 已存在的部分用 realpath，不存在的尾巴原样接上。悬空链接 realpath 解不出来，但 Pi 写它时内核会沿链接把那头的文件
 * 建出来，所以这里也沿 readlink 走到那头再接尾巴，不然工作目录里一条指向外面的悬空链接就是一条绕过。
 * 成环或套得太深的链接解不到真正的目标，抛 PathError，调用方不该猜它落在哪。
 */
export function realpathExisting(logical: string): string {
  return resolveExisting(logical, 0);
}

function resolveExisting(logical: string, hops: number): string {
  const suffix: string[] = [];
  let current = logical;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR" && code !== "ELOOP") {
        return logical;
      }
      const target = linkTarget(current);
      if (target !== null) {
        if (hops >= MAX_LINK_HOPS) {
          throw new LinkLoopError(`符号链接成环或套了超过 ${MAX_LINK_HOPS} 层，解不到真正的目标：${logical}`);
        }
        return resolveExisting(suffix.length === 0 ? target : join(target, ...suffix), hops + 1);
      }
      const parent = dirname(current);
      if (parent === current) return logical;
      suffix.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export function isInsideRoot(realChild: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (value: string): string => (platform === "darwin" ? value.toLocaleLowerCase("en-US") : value);
  const child = fold(realpathExisting(realChild));
  const realRoot = fold(realpathExisting(root));
  return child === realRoot || child.startsWith(`${realRoot}${sep}`);
}
