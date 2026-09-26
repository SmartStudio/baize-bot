import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  };
}

export function ensureBotDirs(dirs: BotDirs): BotDirs {
  for (const dir of [dirs.agentDir, dirs.sessionDir, dirs.workDir, dirs.skillsDir, dirs.draftsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

/** 闸门和两种沙箱共用的禁区。hidden 读写都不行，readOnly 能读不能写。 */
export interface ForbiddenZones {
  readonly hidden: readonly string[];
  readonly readOnly: readonly string[];
}

// 助理 Chrome 的 profile 只认 config 给的路径，不按数据目录的布局去猜：猜错了等于没禁。
export function forbiddenZones(dirs: Pick<BotDirs, "draftsDir">, browserProfileDir: string | null): ForbiddenZones {
  const home = homedir();
  return {
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
  };
}

export function logicalResolve(input: string, cwd: string): string {
  let normalized = input;
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  let expanded = normalized;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function realpathExisting(logical: string): string {
  const suffix: string[] = [];
  let current = logical;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return suffix.length === 0 ? real : join(real, ...suffix);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR") return logical;
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
