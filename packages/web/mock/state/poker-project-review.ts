import { BotId, Group, GroupId, TopicTask } from "@baize/shared";
import { z } from "zod";
import { createGroup } from "./groups.js";
import { pokerPublish, pokerTableList, pokerTableOf } from "./poker.js";
import { groups, messagesByGroupId, tasks, TEAM_BOT_IDS } from "./store.js";
import { send, readBody, type Route } from "../routes/http.js";

// 牌桌的 mock 原本没有群，项目页进不去。这里给一张桌补一个团队群，群 id 就用牌桌的 groupId，
// 侧栏和 /p/:groupId 才认得出这张桌。只有测试入口会调它，别的 mock 流程不走这里。
export const attachPokerProjectGroup = (groupId: GroupId, title: string): boolean => {
  if (pokerTableOf(groupId) === null) return false;
  if (groups.has(groupId)) return true;
  const created = createGroup({ title, botIds: TEAM_BOT_IDS.map((id) => BotId.parse(id)) });
  groups.delete(created.group.id);
  messagesByGroupId.delete(created.group.id);
  groups.set(groupId, Group.parse({ ...created.group, id: groupId }));
  tasks.set(created.task.id, TopicTask.parse({ ...created.task, groupId }));
  return true;
};

// 测试入口：attach 把群挂上，republish 把每张桌的整份视图再推一遍。页面是后开的，推送要等它连上才收得到。
const AttachRequest = z.object({ groupId: GroupId, title: z.string().min(1).optional() }).strict();

export const pokerProjectTestRoute: Route = async ({ req, res, path, method, push }) => {
  if (path === "/api/poker/test/project-group" && method === "POST") {
    const parsed = AttachRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "挂群的字段不对" });
    else if (!attachPokerProjectGroup(parsed.data.groupId, parsed.data.title ?? "牌桌")) {
      send(res, 404, { error: "没有这张桌" });
    } else send(res, 200, { groupId: parsed.data.groupId });
    return true;
  }
  if (path === "/api/poker/test/republish" && method === "POST") {
    const tables = pokerTableList();
    for (const table of tables) pokerPublish(table, push);
    send(res, 200, { tables: tables.length });
    return true;
  }
  return false;
};
