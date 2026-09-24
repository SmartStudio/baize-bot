import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
  };
}

export function ensureBotDirs(dirs: BotDirs): BotDirs {
  for (const dir of [dirs.agentDir, dirs.sessionDir, dirs.workDir, dirs.skillsDir]) mkdirSync(dir, { recursive: true });
  return dirs;
}
