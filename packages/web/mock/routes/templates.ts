import {
  Bot,
  BotTemplate,
  ExportTemplateRequest,
  ImportTemplateRequest,
  Preference,
  ToolConnection,
  ToolConnectionId,
} from "@baize/shared";
import {
  bots,
  createBot,
  createSkill,
  nextSuffix,
  preferences,
  preferencesOf,
  skillsOf,
  tools,
  user,
} from "../state.js";
import { readBody, send, type Route } from "./http.js";

// D12：插件地址剥掉查询串、片段和 userinfo，带过去的只是能自己再授权的那个地址。
const bareUrl = (raw: string): string => {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const templateOf = (bot: Bot, choice: ExportTemplateRequest): BotTemplate =>
  BotTemplate.parse({
    format: 1,
    name: bot.name,
    tags: bot.tags,
    description: bot.description.slice(0, 80),
    skills: choice.skills ? skillsOf(bot.id).map((skill) => ({ name: skill.name, steps: skill.steps })) : [],
    plugins: choice.plugins
      ? [...tools.values()]
          .filter((tool) => tool.assignedBotIds.includes(bot.id))
          .map((tool) => ({
            name: tool.name,
            url: bareUrl(tool.url),
            operations: tool.operations.map((operation) => ({
              name: operation.name,
              needsApproval: operation.needsApproval,
            })),
          }))
      : [],
    preferences: choice.preferences
      ? preferencesOf(bot.id)
          .filter((preference) => !preference.private)
          .map((preference) => ({ text: preference.text }))
      : [],
  });

// 撞名就往后加「 2」「 3」，截在名字上限 20 以内。
const freeName = (name: string): string => {
  const taken = new Set([...bots.values()].map((bot) => bot.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${name.slice(0, 20 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

const importTemplate = (template: BotTemplate) => {
  const created = createBot({ name: freeName(template.name), tags: template.tags, description: template.description });
  for (const skill of template.skills) createSkill(created.bot.id, skill, "template");
  for (const preference of template.preferences) {
    const row = Preference.parse({
      id: `prf_${nextSuffix()}`,
      botId: created.bot.id,
      text: preference.text,
      sourceMessageId: null,
      private: false,
      createdAt: new Date().toISOString(),
    });
    preferences.set(row.id, row);
  }
  const toolConnectionIds = template.plugins.map((plugin) => {
    const tool = ToolConnection.parse({
      id: ToolConnectionId.parse(`tool_new_${nextSuffix()}`),
      ownerId: user.id,
      name: plugin.name,
      url: plugin.url,
      operations: plugin.operations.map((operation) => ({ ...operation, description: "", inputSchema: {} })),
      assignedBotIds: [created.bot.id],
    });
    tools.set(tool.id, tool);
    return tool.id;
  });
  const bot = Bot.parse({ ...created.bot, toolConnectionIds });
  bots.set(bot.id, bot);
  return { bot, group: created.group };
};

export const templateRoutes: Route = async ({ req, res, path, method }) => {
  if (method !== "POST") return false;
  if (path === "/api/bots/import") {
    const parsed = ImportTemplateRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "分享包认不出来" });
    else send(res, 201, importTemplate(parsed.data.template));
    return true;
  }
  const match = /^\/api\/bots\/([^/]+)\/template$/.exec(path);
  if (match === null) return false;
  const bot = bots.get(decodeURIComponent(match[1] ?? ""));
  const choice = ExportTemplateRequest.safeParse(await readBody(req));
  if (bot === undefined) send(res, 404, { error: "没有这个 Bot" });
  else if (!choice.success) send(res, 400, { error: "要带什么没说清" });
  else send(res, 200, templateOf(bot, choice.data));
  return true;
};
