import { CreatePokerTableRequest, Group, TaskId, TopicTask, type PokerTableResponse } from "@baize/shared";
import { groups, nextTaskNumber, tasks, user } from "./store.js";
import { pokerCreateTable, pokerPublish, pokerView, type MockPokerTable } from "./poker.js";
import { readBody, send, type Route } from "../routes/http.js";

// 牌桌在控制面里是一个团队群加一张任务卡，项目页和侧栏认的是这个群。poker.ts 的桌子只有视图没有群，
// 这里在建桌时补上，群的 id 就是桌子的 groupId。预置牌友不在 /api/bots 里，群成员照样带着他们。

export const POKER_PROJECT_TITLE = "周末德州";

const registerProject = (table: MockPokerTable): void => {
  const view = pokerView(table);
  const taskId = TaskId.parse(`tsk_${table.groupId}`);
  groups.set(
    table.groupId,
    Group.parse({
      id: table.groupId,
      ownerId: user.id,
      kind: "team",
      botIds: [...view.seats.flatMap((seat) => (seat.botId === null ? [] : [seat.botId])), view.host.botId],
      taskId,
      chiefBotId: view.host.botId,
      createdAt: new Date().toISOString(),
    }),
  );
  tasks.set(
    taskId,
    TopicTask.parse({
      id: taskId,
      groupId: table.groupId,
      number: nextTaskNumber(),
      title: POKER_PROJECT_TITLE,
      summary: "每周六一局，赛后复盘",
      dueAt: null,
      checklist: [],
      currentBotId: null,
      handled: [],
      status: "active",
      cadence: "",
      goal: null,
      metricSources: [],
      metric: { kind: "unread" },
      metrics: [],
    }),
  );
};

// 建桌顺带建项目群，其余牌局路由仍归 routes/poker.ts。
export const pokerProjectRoutes: Route = async (context) => {
  const { req, res, path, method, push } = context;
  if (path !== "/api/poker/tables" || method !== "POST") return false;
  const parsed = CreatePokerTableRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: parsed.error.issues[0]?.message ?? "请求格式不对" });
    return true;
  }
  const { table, created } = pokerCreateTable(parsed.data.requestId);
  if (created) {
    registerProject(table);
    pokerPublish(table, push);
  }
  const body: PokerTableResponse = { table: pokerView(table) };
  send(res, created ? 201 : 200, body);
  return true;
};
