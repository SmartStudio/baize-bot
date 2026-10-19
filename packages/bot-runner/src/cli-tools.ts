import type { BotId, CliInstall, CliToolConfig } from "@baize/shared";

export const CLI_TOOLS_SECTION = "cli_tools";

/** 这个 Bot 能用的登记工具。bots 为 null 是全部 Bot。 */
export const cliToolsFor = (botId: BotId, tools: readonly CliToolConfig[]): readonly CliToolConfig[] =>
  tools.filter((tool) => tool.bots === null || tool.bots.includes(botId));

const installLine = (install: CliInstall | null): string => {
  if (install === null) return "没有登记装法，没装就告诉主人";
  return install.manager === "npm" ? `npm i -g ${install.package}` : `pip install ${install.package}`;
};

/** 只列命令名和装法，不带值。只在云电脑上给：Mac 和本机的 bash 不带工具的密钥，列了也用不上。 */
export function renderCliToolsSection(tools: readonly CliToolConfig[], closed: boolean): string | null {
  if (!closed || tools.length === 0) return null;
  const lines = [
    "## 命令行工具",
    "这些命令能联网、自带密钥，直接用；没装就先用 npm i -g / pip install 装。",
    ...tools
      .toSorted((left, right) => left.command.localeCompare(right.command))
      .map((tool) => `- ${tool.command}（装法：${installLine(tool.install)}）`),
    "只有整条命令就是这些工具时才带密钥和网络，可以用 | 接 head、grep 这类只读命令。和别的命令用 ;、&& 连起来，加重定向、变量或 $(...)，就按普通命令处理，拿不到密钥。密钥的值不会出现在你看到的输出里。",
  ];
  return lines.join("\n");
}
