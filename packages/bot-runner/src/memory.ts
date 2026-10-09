import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentToControl, type BotId, type ControlToAgent, type MessageId } from "@baize/shared";
import { type Static, Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";
import type { ActiveRun } from "./topic.js";
import type { MemoryShown } from "./watermark.js";

type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;
export type BrandConfig = ConfigMessage["brand"];
export type PreferencesConfig = ConfigMessage["preferences"];

// 偏好和手册的真相源都在控制面，随 config 下发。运行器每次模型请求都把全量放进系统提示的 <memory> 段，
// 不进会话历史：Pi 在响应后和下一条进会话前都可能自动压缩，进了历史的原文会被揉进摘要，之后再送增量就对不上。
// 送的永远是全量，删掉的那条才能靠「这里没有的已作废」从模型的记忆里抹掉。

export const MEMORY_SECTION = "memory";

const PREFERENCES_HEADER = "你现在记住的偏好（之前说过、这里没有的已作废）：";
const NO_PREFERENCES = "（现在一条都没有，之前记的全部作废）";
const BRAND_WITHDRAWN = "品牌手册已经撤掉，之前给过的版本全部作废。";

const preferencesOf = (preferences: PreferencesConfig, botId: BotId): PreferencesConfig =>
  preferences
    .filter((preference) => preference.botId === botId)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

export interface MemoryRender {
  /** 放进系统提示的整段。没见过也没东西可说就是 null，请求和没有记忆这回事时逐字一致。 */
  readonly text: string | null;
  /** 这一轮进了会话以后模型见过的东西。 */
  readonly shown: MemoryShown;
}

/** 这个 Bot 眼下的偏好和手册。见过后来又没了的，明确说作废，压缩摘要和历史里的旧原文才不会继续生效。 */
export function renderMemory(
  botId: BotId,
  brand: BrandConfig,
  allPreferences: PreferencesConfig,
  shown: MemoryShown,
): MemoryRender {
  const preferences = preferencesOf(allPreferences, botId);
  const parts: string[] = [];
  if (preferences.length > 0) {
    parts.push([PREFERENCES_HEADER, ...preferences.map((preference) => `- ${preference.text}`)].join("\n"));
  } else if (shown.preferences) {
    parts.push(`${PREFERENCES_HEADER}\n${NO_PREFERENCES}`);
  }
  if (brand !== null) {
    parts.push(`品牌手册 v${brand.version}（写每一条内容前先照它，之前给过的版本作废）：\n${brand.text}`);
  } else if (shown.brand) {
    parts.push(BRAND_WITHDRAWN);
  }
  return {
    text: parts.length === 0 ? null : `<${MEMORY_SECTION}>\n${parts.join("\n\n")}\n</${MEMORY_SECTION}>`,
    shown: { brand: shown.brand || brand !== null, preferences: shown.preferences || preferences.length > 0 },
  };
}

/**
 * 把记忆段加到这一轮发给模型的消息副本上。开头那条系统消息是 Pi 拼的，`sections` 按名字渲染在正文之后，
 * 加一段不动别的，也不写进会话 JSONL。
 */
export function injectMemory<M extends { readonly role: string; readonly sections?: Record<string, string | null> }>(
  messages: readonly M[],
  text: string,
): M[] {
  const [head, ...rest] = messages;
  if (head === undefined || head.role !== "system") return [...messages];
  return [{ ...head, sections: { ...head.sections, [MEMORY_SECTION]: text } }, ...rest];
}

export const brandFileOf = (dataDir: string, botId: BotId): string => join(dataDir, botId, "brand.md");

/** 手册落成 `<dataDir>/<botId>/brand.md`，撤掉就删。内容没变不重写。 */
export function writeBrandFile(file: string, brand: BrandConfig): void {
  if (brand === null) {
    rmSync(file, { force: true });
    return;
  }
  const content = `# 品牌手册 v${brand.version}\n\n${brand.text}\n`;
  let existing: string | null;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    existing = null;
  }
  if (existing === content) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

const TEXT_MAX = 200;

// 长度不写进 schema：Pi 拿 schema 挡下的参数，模型收到的是英文 Validation 报错。
const REMEMBER_PARAMS = Type.Object({ text: Type.String(), private: Type.Boolean() });

/** 正在跑的这次 prompt，外加触发它的那条群消息，偏好的来源就记它。 */
export interface RememberingRun extends ActiveRun {
  readonly messageId: MessageId;
  /** 这一轮每次模型请求都放进系统提示的记忆段。runOne 读过会话的记号后定下来，跑的中途来了新 config 也不换。 */
  memory: string | null;
}

/** 项目群里说的话是对整队的，不该被某个 Bot 记成它自己的长期偏好，所以 `remember_preference` 只在单聊里给。 */
export function createMemoryTools(options: {
  readonly groupKind: ActiveRun["groupKind"];
  readonly activeRun: () => RememberingRun | null;
  readonly send: (message: AgentToControl) => void;
}): readonly RunnerTool[] {
  if (options.groupKind !== "solo") return [];
  return [
    {
      name: "remember_preference",
      label: "记下偏好",
      description:
        "用户说了以后一直要这样或别再这样的要求（口吻、格式、字数、忌讳），当场记成一条偏好，以后每次干活都照着做。" +
        "text 用一句话写清这条要求，最多 200 字；涉及账号、联系方式或个人信息的 private 填 true，其余填 false。一次性的吩咐不要记。",
      parameters: REMEMBER_PARAMS,
      execute: async (_callId, params) => {
        const active = options.activeRun();
        if (active === null) throw new Error("这次工具调用不属于任何一次运行，没法记偏好。");
        const { text, private: isPrivate } = params as Static<typeof REMEMBER_PARAMS>;
        const trimmed = text.trim();
        if (trimmed === "") throw new Error("偏好是空的，用一句话写清用户要什么。");
        if (trimmed.length > TEXT_MAX) {
          throw new Error(`一条偏好最多 ${TEXT_MAX} 个字，这条有 ${trimmed.length} 个，写短点。`);
        }
        options.send(
          AgentToControl.parse({
            type: "preference_add",
            runId: active.run.runId,
            botId: active.run.botId,
            groupId: active.run.groupId,
            text: trimmed,
            private: isPrivate,
            sourceMessageId: active.messageId,
          }),
        );
        return { content: [{ type: "text", text: `记下了：${trimmed}` }], details: {} };
      },
    },
  ];
}
