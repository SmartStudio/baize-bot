import type { Bot, BotId } from "@baize/shared";
import type { Conversation } from "../state/app.js";
import { pathOf } from "../routes/screen.js";

export type SwitchKind = "bot" | "group" | "project";

export type SwitchItem = { kind: SwitchKind; key: string; name: string; path: string; bot: Bot | null };

export const SWITCH_KINDS: readonly SwitchKind[] = ["bot", "group", "project"];

export const SWITCH_KIND_LABEL: Record<SwitchKind, string> = { bot: "Bot", group: "群", project: "项目" };

export const switchItems = (conversations: readonly Conversation[], bots: Record<BotId, Bot>): SwitchItem[] =>
  conversations.flatMap((item): SwitchItem[] => {
    if (item.kind === "solo") {
      const bot = bots[item.botId];
      if (bot === undefined) return [];
      const path = pathOf({ kind: "group", groupId: item.groupId });
      return [{ kind: "bot", key: `bot:${item.groupId}`, name: bot.name, path, bot }];
    }
    const lead = item.botIds.map((botId) => bots[botId]).find((bot) => bot !== undefined) ?? null;
    const name = item.task.title;
    return [
      {
        kind: "group",
        key: `group:${item.groupId}`,
        name,
        path: pathOf({ kind: item.poker ? "table" : "group", groupId: item.groupId }),
        bot: lead,
      },
      {
        kind: "project",
        key: `project:${item.groupId}`,
        name,
        path: pathOf({ kind: "project", groupId: item.groupId }),
        bot: lead,
      },
    ];
  });

const rankOf = (name: string, query: string): number | null => {
  const target = name.toLowerCase();
  if (target.startsWith(query)) return 0;
  if (target.includes(query)) return 1;
  let at = 0;
  for (const char of query) {
    if (char.trim() === "") continue;
    const found = target.indexOf(char, at);
    if (found === -1) return null;
    at = found + char.length;
  }
  return 2;
};

export const matchItems = (items: readonly SwitchItem[], query: string): SwitchItem[] => {
  const wanted = query.trim().toLowerCase();
  const ranked = items.flatMap((item) => {
    const rank = wanted === "" ? 0 : rankOf(item.name, wanted);
    return rank === null ? [] : [{ item, rank }];
  });
  return SWITCH_KINDS.flatMap((kind) =>
    ranked
      .filter(({ item }) => item.kind === kind)
      .sort((a, b) => a.rank - b.rank)
      .map(({ item }) => item),
  );
};
