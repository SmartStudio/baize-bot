import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BotId } from "@baize/shared";

// Pi 有四个独立的落盘回落点，不给就各自回落到 ~/.pi/agent：
// createAgentSession 的 agentDir、DefaultResourceLoader 的 agentDir、
// ModelRuntime 的 authPath / modelsPath / modelsStorePath、SessionManager.create 的第二参。
// 一台云电脑上多个 Bot 共用一个进程，串到 ~/.pi 就等于串到别的 Bot 头上。

export interface BotDirs {
  /** Pi 的 agentDir。auth.json 和 models-store.json 落在这里。 */
  readonly agentDir: string;
  /** 会话 JSONL 的目录，SessionManager.create 的第二参。 */
  readonly sessionDir: string;
  /** 会话的 cwd，Bot 干活的地方。 */
  readonly workDir: string;
  /** `config.skills` 落成的 `<skillId>/SKILL.md`，Pi 的 `additionalSkillPaths` 指到这里。 */
  readonly skillsDir: string;
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
