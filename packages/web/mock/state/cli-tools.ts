import { CliTool, CliToolId } from "@baize/shared";

// 假控制面只存末四位，和真的一样值不出去。
export const cliTools = new Map<string, CliTool>();

export const resetCliTools = (): void => {
  cliTools.clear();
  const grok = CliTool.parse({
    id: CliToolId.parse("cli_grok"),
    command: "grok",
    install: { manager: "npm", package: "@vibe-kit/grok-cli" },
    env: [{ name: "GROK_API_KEY", last4: "WXYZ" }],
    computers: ["remote"],
    bots: null,
    createdAt: "2026-10-19T01:00:00.000Z",
  });
  cliTools.set(grok.id, grok);
};
