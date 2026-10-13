import {
  BotListResponse,
  BotTemplate,
  CreateBotResponse,
  PreferenceListResponse,
  SkillListResponse,
  SkillResponse,
  ToolListResponse,
  ToolResponse,
  type Bot,
  type BotId,
  type ControlToAgent,
  type Group,
  type GroupId,
  type ServerPush,
  type ToolConnection,
} from "@baize/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shareableUrl } from "../src/repo/templates.js";
import { helloAgent, type AgentClient } from "./helpers/agent.js";
import { startTestServer, type ApiClient, type TestServer } from "./helpers/client.js";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { PASSWORD, makeComputer, makeUser, type TestComputer } from "./helpers/fixtures.js";
import { ECHO_AUTHORIZATION_PREFIX, startTestMcp, type TestMcp } from "./helpers/mcp.js";
import { connectPush, type PushClient } from "./helpers/ws.js";

let database: TestDb;
let server: TestServer;
let mcp: TestMcp;

beforeAll(async () => {
  database = await createTestDb();
  server = await startTestServer(database.db);
  mcp = await startTestMcp();
});

afterAll(async () => {
  await mcp.close();
  await server.close();
  await database.close();
});

type Owner = {
  readonly client: ApiClient;
  readonly computer: TestComputer;
  readonly groupId: GroupId;
  readonly botId: BotId;
};

const STEPS = ["打开 CRM 找到这家客户", "按新折扣算一遍填进报价单"];
const SECRET_AUTH = "Bearer sk-live-share-0001";

async function ownerWithBot(name = "小服"): Promise<Owner> {
  const user = await makeUser(database.db);
  const computer = await makeComputer(database.db, user.id);
  const client = server.client();
  expect((await client.login(user.email, PASSWORD)).status).toBe(200);
  const created = CreateBotResponse.parse(
    await (await client.post("/api/bots", { name, tags: ["客服"], description: "接客户的报价单" })).json(),
  );
  return { client, computer, groupId: created.group.id, botId: created.bot.id };
}

async function online(owner: Owner): Promise<AgentClient> {
  const { agent } = await helloAgent(server.server.port, owner.computer.computerId, owner.computer.token);
  return agent;
}

async function agentUntil<T extends ControlToAgent["type"]>(
  agent: AgentClient,
  type: T,
  done: (one: Extract<ControlToAgent, { type: T }>) => boolean = () => true,
): Promise<Extract<ControlToAgent, { type: T }>> {
  for (let seen = 0; seen < 30; seen += 1) {
    const one = await agent.next();
    if (one.type === type && done(one as Extract<ControlToAgent, { type: T }>)) {
      return one as Extract<ControlToAgent, { type: T }>;
    }
  }
  throw new Error(`下发的报文里一直没有要的 ${type}`);
}

async function pushUntil<T extends ServerPush["type"]>(
  push: PushClient,
  type: T,
): Promise<Extract<ServerPush, { type: T }>> {
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await push.next();
    if (one.type === type) return one as Extract<ServerPush, { type: T }>;
  }
  throw new Error(`推送里一直没有要的 ${type}`);
}

async function teach(owner: Owner, botId: BotId, name: string): Promise<void> {
  const response = await owner.client.post(`/api/bots/${botId}/skills`, { name, steps: STEPS });
  expect(response.status).toBe(201);
}

async function plugin(owner: Owner, name: string, botIds: BotId[], url = mcp.url): Promise<ToolConnection> {
  const created = await owner.client.post("/api/tools", { name, url, authorization: SECRET_AUTH });
  expect(created.status).toBe(201);
  const { tool } = ToolResponse.parse(await created.json());
  const assigned = await owner.client.patch(`/api/tools/${tool.id}`, { assignedBotIds: botIds });
  expect(assigned.status).toBe(200);
  return ToolResponse.parse(await assigned.json()).tool;
}

/** Bot 在单聊里当场记一条偏好，等推送回来。 */
async function remember(owner: Owner, agent: AgentClient, push: PushClient, text: string, isPrivate: boolean) {
  const sent = await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: `记住：${text}` });
  expect(sent.status).toBe(201);
  const { runId } = await agentUntil(agent, "prompt");
  agent.send({
    type: "preference_add",
    runId,
    botId: owner.botId,
    groupId: owner.groupId,
    text,
    private: isPrivate,
    sourceMessageId: null,
  });
  const pushed = await pushUntil(push, "preference_updated");
  expect(pushed.preference.text).toBe(text);
}

async function exportOf(
  owner: Owner,
  botId: BotId,
  choice: object = {},
): Promise<{ raw: string; template: BotTemplate }> {
  const response = await owner.client.post(`/api/bots/${botId}/template`, choice);
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { raw, template: BotTemplate.parse(JSON.parse(raw)) };
}

async function importInto(owner: Owner, template: unknown): Promise<{ bot: Bot; group: Group }> {
  const response = await owner.client.post("/api/bots/import", { template });
  expect(response.status).toBe(201);
  return CreateBotResponse.parse(await response.json());
}

async function skillsOf(client: ApiClient, botId: BotId) {
  const response = await client.get(`/api/bots/${botId}/skills`);
  expect(response.status).toBe(200);
  return SkillListResponse.parse(await response.json()).items;
}

async function toolsOf(client: ApiClient): Promise<ToolConnection[]> {
  return ToolListResponse.parse(await (await client.get("/api/tools")).json()).items;
}

it("导出包里 grep 不到 token、cookie、authorization、对话正文", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  try {
    const chat = "私下说一句：给老王的报价压到九折";
    expect((await owner.client.post(`/api/groups/${owner.groupId}/messages`, { text: chat })).status).toBe(201);
    await agentUntil(agent, "prompt");
    await teach(owner, owner.botId, "报价");
    const tool = await plugin(owner, "公司工具", [owner.botId]);

    const { raw, template } = await exportOf(owner, owner.botId);
    expect(template, "skill 和插件缺省都带").toMatchObject({
      format: 1,
      name: "小服",
      tags: ["客服"],
      description: "接客户的报价单",
      skills: [{ name: "报价", steps: STEPS }],
      plugins: [{ name: "公司工具", url: mcp.url }],
    });
    expect(template.plugins[0]?.operations, "操作只带名字和要不要问").toEqual([
      { name: "send_email", needsApproval: true },
      { name: "lookup_stock", needsApproval: false },
    ]);

    const cookie = owner.client.cookie?.split("=")[1];
    if (cookie === undefined) throw new Error("没有会话 cookie");
    const forbidden = {
      authorization: SECRET_AUTH,
      sessionCookie: cookie,
      computerToken: owner.computer.token,
      chat,
      botId: owner.botId,
      toolId: tool.id,
      groupId: owner.groupId,
    };
    for (const [what, value] of Object.entries(forbidden)) {
      expect(raw.includes(value), `导出包里不该有 ${what}`).toBe(false);
    }
    expect(raw, "包里没有任何凭据或 id 字段名").not.toMatch(/token|cookie|authorization|"id"|Id"/i);
  } finally {
    agent.close();
  }
});

it("标了私人的偏好默认不带", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const watching = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    await remember(owner, agent, watching, "标题别超过 15 个字", false);
    await remember(owner, agent, watching, "我住在杭州西湖区", true);

    expect((await exportOf(owner, owner.botId)).template.preferences, "私人的那条不在包里").toEqual([
      { text: "标题别超过 15 个字" },
    ]);
    expect(
      (await exportOf(owner, owner.botId, { preferences: false })).template.preferences,
      "不勾偏好就一条不带",
    ).toEqual([]);
  } finally {
    watching.close();
    agent.close();
  }
});

it("插件 URL 带 ?key= 时导出包里没有查询串", async () => {
  const owner = await ownerWithBot();
  const withKey = `${mcp.url}?key=sk-query-0001&team=a#frag-0001`;
  const tool = await plugin(owner, "带 key 的工具", [owner.botId], withKey);
  expect(tool.url, "建连接时 url 原样存着，key 在查询串里").toBe(withKey);

  const { raw, template } = await exportOf(owner, owner.botId);
  expect(
    template.plugins.map((one) => one.url),
    "只剩协议、主机、端口和路径",
  ).toEqual([mcp.url]);
  for (const leaked of ["sk-query-0001", "team=a", "frag-0001", "?"]) {
    expect(raw.includes(leaked), `包里不该有 ${leaked}`).toBe(false);
  }
  // 带 userinfo 的地址 fetch 根本发不出去，建不成连接，只能直接核剥地址的那个函数。
  expect(shareableUrl("http://alice:pw-0001@mcp.example.com:8080/mcp?key=sk-1#f"), "userinfo 也剥掉").toBe(
    "http://mcp.example.com:8080/mcp",
  );
});

it("导入得到新 Bot，skill 来源是 template", async () => {
  const author = await ownerWithBot();
  const authorAgent = await online(author);
  const authorPush = await connectPush(server.server.port, author.client.cookie ?? "");
  try {
    await teach(author, author.botId, "报价");
    await plugin(author, "公司工具", [author.botId]);
    await remember(author, authorAgent, authorPush, "标题别超过 15 个字", false);
  } finally {
    authorPush.close();
    authorAgent.close();
  }
  const { template } = await exportOf(author, author.botId);

  const importer = await ownerWithBot("小服");
  const taken = await importer.client.post("/api/tools", { name: "公司工具", url: mcp.url });
  expect(taken.status).toBe(201);
  const agent = await online(importer);
  try {
    const { bot, group } = await importInto(importer, template);
    expect(bot.name, "导入方已有「小服」，自动避开").toBe("小服2");
    expect(bot, "标签和描述照包").toMatchObject({ tags: ["客服"], description: "接客户的报价单", role: "member" });
    expect(group.botIds, "建出它的单聊").toEqual([bot.id]);

    expect(
      (await skillsOf(importer.client, bot.id)).map(({ name, steps, source }) => ({ name, steps, source })),
    ).toEqual([{ name: "报价", steps: STEPS, source: "template" }]);

    const preferences = PreferenceListResponse.parse(
      await (await importer.client.get(`/api/bots/${bot.id}/preferences`)).json(),
    ).items;
    expect(
      preferences.map(({ text, private: isPrivate, sourceMessageId }) => ({ text, isPrivate, sourceMessageId })),
    ).toEqual([{ text: "标题别超过 15 个字", isPrivate: false, sourceMessageId: null }]);

    const imported = (await toolsOf(importer.client)).filter((tool) => tool.assignedBotIds.includes(bot.id));
    expect(
      imported.map(({ name, url }) => ({ name, url })),
      "撞了已有工具名也自动避开",
    ).toEqual([{ name: "公司工具2", url: mcp.url }]);
    expect(imported[0]?.operations.map(({ name, needsApproval }) => ({ name, needsApproval }))).toEqual(
      template.plugins[0]?.operations,
    );

    const config = await agentUntil(agent, "config", (one) => one.bots.some((entry) => entry.id === bot.id));
    expect(
      config.tools.filter((tool) => tool.assignedBotIds.includes(bot.id)).map((tool) => "authorization" in tool),
      "代理插件不下发授权，导入方自己去授权",
    ).toEqual([false]);
    expect(config.skills?.filter((skill) => skill.botId === bot.id).map((skill) => skill.source)).toEqual(["template"]);
  } finally {
    agent.close();
  }
});

it("导入后原 Bot 再改不影响新 Bot", async () => {
  const owner = await ownerWithBot();
  await teach(owner, owner.botId, "报价");
  const original = await plugin(owner, "公司工具", [owner.botId]);
  const { template } = await exportOf(owner, owner.botId);
  const { bot } = await importInto(owner, template);
  const copiedSkills = await skillsOf(owner.client, bot.id);
  const copiedTool = (await toolsOf(owner.client)).find((tool) => tool.assignedBotIds.includes(bot.id));
  if (copiedTool === undefined) throw new Error("新 Bot 没分到插件");
  expect(copiedTool.id, "插件是新建的一条连接，不是共用原来的").not.toBe(original.id);

  const [originalSkill] = await skillsOf(owner.client, owner.botId);
  if (originalSkill === undefined) throw new Error("原 Bot 没有 skill");
  const edited = await owner.client.patch(`/api/skills/${originalSkill.id}`, { steps: ["全改了"] });
  expect(SkillResponse.parse(await edited.json()).skill.steps).toEqual(["全改了"]);
  expect((await owner.client.patch(`/api/bots/${owner.botId}`, { description: "改行做采购" })).status).toBe(200);
  expect(
    (
      await owner.client.patch(`/api/tools/${original.id}`, {
        operations: [{ name: "lookup_stock", needsApproval: true }],
      })
    ).status,
  ).toBe(200);

  expect(await skillsOf(owner.client, bot.id), "新 Bot 的 skill 原样").toEqual(copiedSkills);
  const bots = BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items;
  expect(bots.find((entry) => entry.bot.id === bot.id)?.bot.description, "新 Bot 的描述原样").toBe("接客户的报价单");
  expect(
    (await toolsOf(owner.client)).find((tool) => tool.id === copiedTool.id),
    "新 Bot 的插件原样",
  ).toEqual(copiedTool);
});

it("格式版本不对回 400", async () => {
  const owner = await ownerWithBot();
  const { template } = await exportOf(owner, owner.botId);
  const before = BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items.length;

  for (const [what, bad] of [
    ["format 2", { ...template, format: 2 }],
    ["没有 format", { ...template, format: undefined }],
    ["多出 token 字段", { ...template, token: "x" }],
  ] as const) {
    const response = await owner.client.post("/api/bots/import", { template: bad });
    expect(response.status, what).toBe(400);
  }
  expect(
    BotListResponse.parse(await (await owner.client.get("/api/bots")).json()).items,
    "一个 Bot 都没多",
  ).toHaveLength(before);
});

function sharedPlugin(url: string, operations: BotTemplate["plugins"][number]["operations"]): BotTemplate {
  return {
    format: 1,
    name: "导入的",
    tags: [],
    description: "",
    skills: [],
    plugins: [{ name: "公司工具", url, operations }],
    preferences: [],
  };
}

async function importedTool(owner: Owner, botId: BotId): Promise<ToolConnection> {
  const tool = (await toolsOf(owner.client)).find((one) => one.assignedBotIds.includes(botId));
  if (tool === undefined) throw new Error("新 Bot 没分到插件");
  return tool;
}

/** 收到屏障那条 bot_updated 之前的全部推送，屏障本身也算进去。 */
async function pushesThroughBotUpdate(owner: Owner, push: PushClient, botId: BotId): Promise<ServerPush[]> {
  expect((await owner.client.patch(`/api/bots/${botId}`, { description: "屏障" })).status).toBe(200);
  const seen: ServerPush[] = [];
  for (let received = 0; received < 30; received += 1) {
    const one = await push.next();
    seen.push(one);
    if (one.type === "bot_updated" && one.bot.id === botId) return seen;
  }
  throw new Error("推送里一直没有屏障 bot_updated");
}

it("导入的插件 PATCH 带授权后操作表换成真实列表，同名操作保留包里的 needsApproval", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    const { bot } = await importInto(
      owner,
      sharedPlugin(mcp.url, [
        { name: "send_email", needsApproval: false },
        { name: "old_only", needsApproval: true },
      ]),
    );
    const before = await importedTool(owner, bot.id);

    const secret = "Bearer sk-reauth-0002";
    const response = await owner.client.patch(`/api/tools/${before.id}`, { authorization: secret });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw.includes(secret), "PATCH 回包里没有凭据").toBe(false);
    const { tool } = ToolResponse.parse(JSON.parse(raw));
    expect(
      tool.operations.map(({ name, description, needsApproval }) => ({ name, description, needsApproval })),
      "换成 MCP 的真实列表：send_email 沿用包里的不问，lookup_stock 按注解不问，old_only 没了",
    ).toEqual([
      { name: "send_email", description: "对外发送邮件", needsApproval: false },
      { name: "lookup_stock", description: "查询库存", needsApproval: false },
    ]);
    expect(mcp.authorizations(), "探测时带的是新凭据").toContain(secret);
    expect(
      { ...tool, operations: [], status: "awaiting_authorization" },
      "其余字段不变，只有状态从待授权转为可用",
    ).toEqual({
      ...before,
      operations: [],
    });
    expect(tool.status).toBe("ready");

    const listed = await (await owner.client.get("/api/tools")).text();
    expect(listed.includes(secret), "工具列表里没有凭据").toBe(false);
    const pushes = await pushesThroughBotUpdate(owner, push, bot.id);
    expect(JSON.stringify(pushes).includes(secret), "推送里没有凭据").toBe(false);

    const config = await agentUntil(agent, "config", (one) =>
      one.tools.some((entry) => entry.id === tool.id && entry.status === "ready"),
    );
    expect(config.tools.find((entry) => entry.id === tool.id)?.operations, "下发给电脑的就是新操作表").toEqual(
      tool.operations,
    );
  } finally {
    push.close();
    agent.close();
  }
});

it("授权后连不上回 400 且原操作表不变", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    const { bot } = await importInto(
      owner,
      sharedPlugin("http://127.0.0.1:1/mcp", [{ name: "send_email", needsApproval: false }]),
    );
    const before = await importedTool(owner, bot.id);

    const secret = "Bearer sk-dead-0003";
    const response = await owner.client.patch(`/api/tools/${before.id}`, { authorization: secret });
    expect(response.status).toBe(400);
    expect((await response.text()).includes(secret), "错误回包里没有凭据").toBe(false);
    expect(await importedTool(owner, bot.id), "操作表和其余字段都没动").toEqual(before);

    const pushes = await pushesThroughBotUpdate(owner, push, bot.id);
    expect(JSON.stringify(pushes).includes(secret), "推送里没有凭据").toBe(false);
    const config = await agentUntil(agent, "config", (one) =>
      one.bots.some((entry) => entry.id === bot.id && entry.description === "屏障"),
    );
    expect(
      config.tools.find((entry) => entry.id === before.id),
      "代理配置不带凭据，新凭据没存下",
    ).not.toHaveProperty("authorization");
  } finally {
    push.close();
    agent.close();
  }
});

it("导入的插件补授权之前下发给电脑的是待授权，补完才可用；自己建的匿名连接一直可用", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  try {
    const anonymous = await plugin(owner, "匿名工具", [owner.botId]);
    const anonymousConfig = await agentUntil(agent, "config", (one) =>
      one.tools.some((entry) => entry.id === anonymous.id && entry.assignedBotIds.includes(owner.botId)),
    );
    expect(anonymousConfig.tools.find((entry) => entry.id === anonymous.id)?.status, "自己建的连接发现过操作").toBe(
      "ready",
    );

    const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
    const imported = await importedTool(owner, bot.id);
    const pending = await agentUntil(agent, "config", (one) => one.tools.some((entry) => entry.id === imported.id));
    expect(
      pending.tools.find((entry) => entry.id === imported.id),
      "没补授权的插件下发成待授权，运行器据此拒绝执行",
    ).toMatchObject({ localOnly: false, status: "awaiting_authorization" });

    const authorized = await owner.client.patch(`/api/tools/${imported.id}`, { authorization: "Bearer sk-ready-0004" });
    expect(authorized.status).toBe(200);
    const ready = await agentUntil(agent, "config", (one) =>
      one.tools.some((entry) => entry.id === imported.id && entry.status === "ready"),
    );
    expect(ready.tools.find((entry) => entry.id === imported.id)?.status, "补完授权就可用").toBe("ready");
  } finally {
    agent.close();
  }
});

it("补授权等 MCP 回列表的时候用户改了审批，写回不把它盖掉", async () => {
  const owner = await ownerWithBot();
  const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
  const imported = await importedTool(owner, bot.id);

  const held = mcp.holdNextList();
  const authorizing = owner.client.patch(`/api/tools/${imported.id}`, { authorization: "Bearer sk-race-0005" });
  await held.arrived;
  const tightened = await owner.client.patch(`/api/tools/${imported.id}`, {
    operations: [{ name: "send_email", needsApproval: true }],
  });
  expect(tightened.status, "补授权还在探测，改审批照常落库").toBe(200);
  held.release();
  const authorized = await authorizing;
  expect(authorized.status).toBe(200);

  const after = await importedTool(owner, bot.id);
  expect(
    after.operations.map(({ name, description, needsApproval }) => ({ name, description, needsApproval })),
    "操作表换成真实列表，send_email 沿用的是用户刚改的「要问」",
  ).toEqual([
    { name: "send_email", description: "对外发送邮件", needsApproval: true },
    { name: "lookup_stock", description: "查询库存", needsApproval: false },
  ]);
  expect(ToolResponse.parse(await authorized.json()).tool, "补授权的回包就是落库后的样子").toEqual(after);
});

it("40 个字的插件名撞名后照样能再导出，名字截短给序号让位", async () => {
  const owner = await ownerWithBot();
  const longName = "插".repeat(40);
  const template: BotTemplate = {
    ...sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]),
    plugins: [{ name: longName, url: mcp.url, operations: [{ name: "send_email", needsApproval: false }] }],
  };
  await importInto(owner, template);
  const second = await importInto(owner, template);

  const tool = await importedTool(owner, second.bot.id);
  expect(tool.name, "截掉尾巴一个字，接上序号 2").toBe(`${"插".repeat(39)}2`);
  const { template: again } = await exportOf(owner, second.bot.id);
  expect(again.plugins.map((one) => one.name)).toEqual([tool.name]);
});

it("MCP 把收到的凭据写进 tools/list 的报错里：补授权的 400 回包和推送里都没有凭据", async () => {
  const owner = await ownerWithBot();
  const push = await connectPush(server.server.port, owner.client.cookie ?? "");
  try {
    const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
    const before = await importedTool(owner, bot.id);
    const token = "sk-echo-0006";
    const secret = `${ECHO_AUTHORIZATION_PREFIX}${token}`;

    const response = await owner.client.patch(`/api/tools/${before.id}`, { authorization: secret });
    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(mcp.authorizations(), "假 MCP 确实收到了这把凭据").toContain(secret);
    expect(raw, "报错照样说清是连不上 MCP").toMatch(/连不上 MCP/);
    expect(raw.includes(token), `错误回包里没有凭据：${raw}`).toBe(false);
    expect(await importedTool(owner, bot.id), "什么都没改").toEqual(before);

    const pushes = await pushesThroughBotUpdate(owner, push, bot.id);
    expect(JSON.stringify(pushes).includes(token), "推送里没有凭据").toBe(false);
  } finally {
    push.close();
  }
});

it("补授权等 MCP 回列表的时候用户改了分配：200 回包里是改过之后的分配", async () => {
  const owner = await ownerWithBot();
  const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
  const imported = await importedTool(owner, bot.id);
  expect(imported.assignedBotIds).toEqual([bot.id]);

  const held = mcp.holdNextList();
  const authorizing = owner.client.patch(`/api/tools/${imported.id}`, { authorization: "Bearer sk-race-0014" });
  await held.arrived;
  const moved = await owner.client.patch(`/api/tools/${imported.id}`, { assignedBotIds: [owner.botId] });
  expect(moved.status, "补授权还在探测，改分配照常落库").toBe(200);
  held.release();
  const authorized = await authorizing;
  expect(authorized.status).toBe(200);

  const after = await importedTool(owner, owner.botId);
  expect(after.assignedBotIds).toEqual([owner.botId]);
  expect(ToolResponse.parse(await authorized.json()).tool.assignedBotIds, "回包不拿进来时那份旧分配").toEqual([
    owner.botId,
  ]);
});

it("导入的匿名插件不带凭据补授权（authorization: null）：不带头重新探测，成功就可用", async () => {
  const owner = await ownerWithBot();
  const agent = await online(owner);
  try {
    const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
    const imported = await importedTool(owner, bot.id);
    const seenBefore = mcp.authorizations().length;

    const response = await owner.client.patch(`/api/tools/${imported.id}`, { authorization: null });
    expect(response.status).toBe(200);
    expect(
      ToolResponse.parse(await response.json()).tool.operations.map(({ name, needsApproval }) => ({
        name,
        needsApproval,
      })),
      "换成 MCP 的真实列表",
    ).toEqual([
      { name: "send_email", needsApproval: false },
      { name: "lookup_stock", needsApproval: false },
    ]);
    expect(new Set(mcp.authorizations().slice(seenBefore)), "探测时一个 Authorization 头都没带").toEqual(
      new Set([null]),
    );
    const ready = await agentUntil(agent, "config", (one) =>
      one.tools.some((entry) => entry.id === imported.id && entry.status === "ready"),
    );
    expect(
      ready.tools.find((entry) => entry.id === imported.id),
      "代理配置不带凭据",
    ).not.toHaveProperty("authorization");
  } finally {
    agent.close();
  }
});

it("导入的插件在 GET /api/tools 里是待授权，补授权后变可用；自己建的连接一直是可用", async () => {
  const owner = await ownerWithBot();
  const own = await plugin(owner, "自己的工具", [owner.botId]);
  expect(own.status, "自己建的连接建出来就可用").toBe("ready");

  const { bot } = await importInto(owner, sharedPlugin(mcp.url, [{ name: "send_email", needsApproval: false }]));
  const imported = await importedTool(owner, bot.id);
  expect(imported.status, "包里带的占位操作表，补授权之前不许用").toBe("awaiting_authorization");

  const authorized = await owner.client.patch(`/api/tools/${imported.id}`, { authorization: "Bearer sk-ready-0005" });
  expect(authorized.status).toBe(200);
  const listed = await toolsOf(owner.client);
  expect(listed.find((tool) => tool.id === imported.id)?.status, "补完授权就可用").toBe("ready");
  expect(listed.find((tool) => tool.id === own.id)?.status).toBe("ready");
});
