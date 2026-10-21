import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeBinDir } from "./contained.js";

export const CLI_TOOLS_SECTION = "cli_tools";

/** 主人在网页终端里装进共用 HOME 的命令。每次派活现读，刚装的下一条就看得见。 */
export function homeCommands(homeDir: string): readonly string[] {
  const dir = homeBinDir(homeDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        const stat = statSync(join(dir, name));
        return stat.isFile() && (stat.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    })
    .toSorted((left, right) => left.localeCompare(right));
}

/** 只在云电脑上给（home 为 null 就不是云电脑）：Mac 和本机的 bash 不给这些命令网络，列了也用不上。 */
export function renderCliToolsSection(home: readonly string[] | null): string | null {
  if (home === null || home.length === 0) return null;
  return [
    "## 命令行工具",
    "主人在云电脑终端里装好、登录过的命令，能联网，登录态在 HOME 里，直接用：",
    ...home.map((name) => `- ${name}`),
    "只有整条命令就是这些工具时才给网络，可以用 | 接 head、grep 这类只读命令。和别的命令用 ;、&& 连起来，加重定向、变量或 $(...)，就按普通命令处理。要用的工具没装或没登录，告诉主人去「设置 › 账号与电脑」的终端里装好、登录。",
  ].join("\n");
}
