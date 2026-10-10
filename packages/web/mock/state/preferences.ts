import { Preference, type BotId, type MessageId } from "@baize/shared";
import { at, groups, nextSuffix, skills } from "./store.js";

export const preferences = new Map<string, Preference>();

// 照 U12：小服一开始记着 5 条，在单聊里再教一句就是第 6 条。
const SEEDED: { botId: string; text: string; private: boolean }[] = [
  { botId: "bot_service", text: "回客户先称呼对方名字", private: false },
  { botId: "bot_service", text: "交期只说确定的日子，不说「尽快」", private: false },
  { botId: "bot_service", text: "退款超过 500 元先问我", private: false },
  { botId: "bot_service", text: "Lisa 喜欢先看结论", private: true },
  { botId: "bot_service", text: "工单标题别超过 15 个字", private: false },
];

export const seedPreferences = (): void => {
  preferences.clear();
  SEEDED.forEach((seed, index) => {
    const preference = Preference.parse({
      id: `prf_seed_${index + 1}`,
      botId: seed.botId,
      text: seed.text,
      sourceMessageId: null,
      private: seed.private,
      createdAt: at(index),
    });
    preferences.set(preference.id, preference);
  });
};

export const preferencesOf = (botId: string): Preference[] =>
  [...preferences.values()].filter((preference) => preference.botId === botId);

// 真运行器里是 Bot 自己判断要不要调 remember_preference；mock 只认「以后」开头的一句，够把记住数推一格。
export const learnFrom = (botId: BotId, text: string, sourceMessageId: MessageId): Preference | null => {
  if (!text.trim().startsWith("以后")) return null;
  const preference = Preference.parse({
    id: `prf_${nextSuffix()}`,
    botId,
    text: text.trim().slice(0, 200),
    sourceMessageId,
    private: false,
    createdAt: new Date().toISOString(),
  });
  preferences.set(preference.id, preference);
  return preference;
};

export const forgetPreference = (id: string): Preference | null => {
  const preference = preferences.get(id);
  if (preference === undefined) return null;
  preferences.delete(id);
  return preference;
};

export const markPreferencePrivate = (id: string, isPrivate: boolean): Preference | null => {
  const preference = preferences.get(id);
  if (preference === undefined) return null;
  const next = Preference.parse({ ...preference, private: isPrivate });
  preferences.set(id, next);
  return next;
};

export const profileOf = (botId: string) => ({
  preferences: preferencesOf(botId).length,
  skills: [...skills.values()].filter((skill) => skill.botId === botId).length,
  projects: [...groups.values()].filter((group) => group.kind === "team" && group.botIds.some((id) => id === botId))
    .length,
});
