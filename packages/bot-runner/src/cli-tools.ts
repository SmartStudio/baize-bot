import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { installCommand, type BotId, type CliInstall, type CliToolConfig } from "@baize/shared";
import { homeBinDir } from "./contained.js";

export const CLI_TOOLS_SECTION = "cli_tools";

/** 这个 Bot 能用的登记工具。bots 为 null 是全部 Bot。 */
export const cliToolsFor = (botId: BotId, tools: readonly CliToolConfig[]): readonly CliToolConfig[] =>
  tools.filter((tool) => tool.bots === null || tool.bots.includes(botId));

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

const installLine = (install: CliInstall | null): string => {
  if (install === null) return "没有登记装法，没装就告诉主人";
  return installCommand(install);
};

/**
 * 只列命令名和装法，不带值。只在云电脑上给（home 为 null 就不是云电脑）：Mac 和本机的 bash 不带工具的密钥和网络，列了也用不上。
 * home 是主人装在共用 HOME 里的命令，和登记工具重名的只按登记工具列。
 */
export function renderCliToolsSection(tools: readonly CliToolConfig[], home: readonly string[] | null): string | null {
  if (home === null) return null;
  const registered = new Set(tools.map((tool) => tool.command));
  const owned = home.filter((name) => !registered.has(name));
  if (tools.length === 0 && owned.length === 0) return null;
  const lines = ["## 命令行工具"];
  if (tools.length > 0) {
    lines.push(
      "这些命令能联网、自带密钥，直接用；没装就照下面的装法原样装。",
      ...tools
        .toSorted((left, right) => left.command.localeCompare(right.command))
        .map((tool) => `- ${tool.command}（装法：${installLine(tool.install)}）`),
    );
  }
  if (owned.length > 0) {
    lines.push(
      "主人在云电脑终端里装好、登录过的命令，能联网，登录态在 HOME 里，直接用：",
      ...owned.map((name) => `- ${name}`),
    );
  }
  lines.push(
    "只有整条命令就是这些工具时才给网络和登记的密钥，可以用 | 接 head、grep 这类只读命令。和别的命令用 ;、&& 连起来，加重定向、变量或 $(...)，就按普通命令处理。密钥的值不会出现在你看到的输出里。要用的工具没装或没登录，告诉主人去「设置 › 账号与电脑」的终端里装好、登录。",
  );
  return lines.join("\n");
}
