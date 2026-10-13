import {
  BotTemplate,
  PreferenceId,
  SkillId,
  ToolConnectionId,
  type Bot,
  type ExportTemplateRequest,
  type Group,
  type Preference,
  type Skill,
  type ToolConnection,
  type ToolOperation,
  type UserId,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botPreferences, skills, toolConnectionBots, toolConnections, users } from "../db/schema.js";
import { newId } from "../ids.js";
import { insertMemberBot } from "./bots.js";
import { lockOwner } from "./runs.js";

const DESCRIPTION_MAX = 80;
const SKILLS_MAX = 50;
const PLUGINS_MAX = 20;
const PREFERENCES_MAX = 50;
/** 工具连接名的上限，建连接、改名和分享包都是 40。 */
const PLUGIN_NAME_MAX = 40;

/** zod 的 max 按码元算。截到 units 以内，落在代理对中间就把整个字丢掉。 */
function headWithin(text: string, units: number): string {
  let head = "";
  for (const char of text) {
    if (head.length + char.length > units) break;
    head += char;
  }
  return head;
}

/** 不少 MCP 地址把 key 放在查询串、userinfo 或片段里（D12），一律剥掉，只留协议、主机、端口和路径。 */
export function shareableUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * 分享包。只从这几样东西里挑字段往外拷，凭据、id、对话一样都不经手；偏好只带没标私人的。
 * 第 1 期留下的超长描述截到 80，数组超出包的上限就截掉尾巴，出口再按 BotTemplate 校一遍。
 */
export function buildTemplate(
  bot: Bot,
  botSkills: readonly Skill[],
  tools: readonly ToolConnection[],
  preferences: readonly Preference[],
  choice: ExportTemplateRequest,
): BotTemplate {
  return BotTemplate.parse({
    format: 1,
    name: bot.name,
    tags: bot.tags,
    description: headWithin(bot.description, DESCRIPTION_MAX),
    skills: choice.skills
      ? botSkills
          .filter((skill) => skill.botId === bot.id)
          .slice(0, SKILLS_MAX)
          .map((skill) => ({ name: skill.name, steps: skill.steps }))
      : [],
    plugins: choice.plugins
      ? tools
          .filter((tool) => tool.assignedBotIds.includes(bot.id))
          .slice(0, PLUGINS_MAX)
          .map((tool) => ({
            name: tool.name,
            url: shareableUrl(tool.url),
            operations: tool.operations.map((operation) => ({
              name: operation.name,
              needsApproval: operation.needsApproval,
            })),
          }))
      : [],
    preferences: choice.preferences
      ? preferences
          .filter((preference) => preference.botId === bot.id && !preference.private)
          .slice(0, PREFERENCES_MAX)
          .map((preference) => ({ text: preference.text }))
      : [],
  });
}

/**
 * 包里的操作只有名字和要不要问。描述和参数表要等导入方授权后连上 MCP 才有，
 * 在那之前给一张不收参数的空表；连接记成待授权，运行器照样注册，但调用当场拒绝，不去连包里的地址。
 */
const placeholderOperation = (operation: BotTemplate["plugins"][number]["operations"][number]): ToolOperation => ({
  name: operation.name,
  description: "",
  inputSchema: { type: "object", properties: {} },
  needsApproval: operation.needsApproval,
});

/**
 * 按包建一个新队员：Bot 和单聊、skill（来源 template）、偏好（都不私人）、插件（没有 authorization，只分给它）。
 * 一个事务，失败什么都不留。Bot 名字和工具连接名字撞了都按「名字2、名字3……」避开，超长时截掉尾巴给数字让位，
 * 工具名靠唯一索引判，不先查后写。和 createBot 一样先拿归属人的共享锁：删号进行中就等它提交，人没了回 null。
 */
export async function importTemplate(
  db: Db,
  ownerId: UserId,
  template: BotTemplate,
): Promise<{ bot: Bot; group: Group } | null> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId, "shared");
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId));
    if (owner === undefined) return null;
    const created = await insertMemberBot(
      tx,
      ownerId,
      { name: template.name, tags: template.tags, description: template.description },
      "untaken",
    );
    const botId = created.bot.id;

    if (template.skills.length > 0) {
      await tx
        .insert(skills)
        .values(
          template.skills.map((skill) => ({
            id: SkillId.parse(newId()),
            botId,
            name: skill.name,
            steps: [...skill.steps],
            source: "template" as const,
          })),
        )
        .onConflictDoNothing({ target: [skills.botId, skills.name] });
    }

    if (template.preferences.length > 0) {
      await tx.insert(botPreferences).values(
        template.preferences.map((preference) => ({
          id: PreferenceId.parse(newId()),
          botId,
          text: preference.text,
          private: false,
          sourceMessageId: null,
        })),
      );
    }

    for (const plugin of template.plugins) {
      for (let suffix = 1; ; suffix += 1) {
        const [row] = await tx
          .insert(toolConnections)
          .values({
            id: ToolConnectionId.parse(newId()),
            ownerId,
            name:
              suffix === 1 ? plugin.name : headWithin(plugin.name, PLUGIN_NAME_MAX - String(suffix).length) + suffix,
            url: shareableUrl(plugin.url),
            authorizationEnc: null,
            localOnly: false,
            operations: plugin.operations.map(placeholderOperation),
            status: "awaiting_authorization",
          })
          .onConflictDoNothing({ target: [toolConnections.ownerId, toolConnections.name] })
          .returning({ id: toolConnections.id });
        if (row === undefined) continue;
        await tx.insert(toolConnectionBots).values({ toolConnectionId: row.id, botId });
        break;
      }
    }

    return { bot: created.bot, group: created.group };
  });
}
