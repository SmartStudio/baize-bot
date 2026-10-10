import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContentPlan,
  Draft,
  GroupListResponse,
  PublicationId,
  ServerPush,
  UpdateTaskResponse,
  type BotId,
} from "@baize/shared";
import { groupRoutes } from "../../mock/routes/groups.js";
import {
  bots,
  drafts,
  groups,
  plans,
  projectOf,
  publications,
  recordSample,
  reseed,
  resetToday,
  seedProjectGoal,
  tasks,
  todayOf,
  writeTask,
} from "../../mock/state.js";

const ORDER = "grp_order";

const rowOf = (groupId: string) => todayOf().running.filter((item) => item.groupId === groupId);

const approvedPlan = (id: string, groupId: string, decidedAt: string, statuses: Draft["status"][]) => {
  const template = [...drafts.values()][0];
  if (template === undefined) throw new Error("mock 种子里没有稿子");
  const draftIds = statuses.map((status, at) => {
    const draft = Draft.parse({ ...template, id: `draft_${id}_${at}`, groupId, planId: id, status });
    drafts.set(draft.id, draft);
    return draft.id;
  });
  const plan = ContentPlan.parse({
    id,
    groupId,
    botId: null,
    title: `计划 ${id}`,
    status: "approved",
    draftIds,
    createdAt: decidedAt,
    decidedAt,
  });
  plans.set(plan.id, plan);
  return plan;
};

const emptyMembers = (groupId: string) => {
  const group = groups.get(groupId);
  if (group === undefined) throw new Error(`mock 里没有 ${groupId}`);
  for (const botId of group.botIds) bots.delete(botId as BotId);
};

beforeEach(() => {
  reseed();
  resetToday();
  for (const plan of [...plans.values()]) if (plan.groupId === ORDER) plans.delete(plan.id);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mock 首页在进行对齐控制面", () => {
  it("有目标的项目按最新一份已批计划计数", () => {
    seedProjectGoal();
    approvedPlan("plan_old", ORDER, "2026-10-01T00:00:00.000Z", ["published"]);
    approvedPlan("plan_new", ORDER, "2026-10-02T00:00:00.000Z", ["approved", "approved"]);

    expect(rowOf(ORDER), "按 decidedAt 取 P2，不是先放进去的 P1").toEqual([
      expect.objectContaining({ published: 0, planned: 2, goal: expect.objectContaining({ target: 1000 }) }),
    ]);
  });

  it("decidedAt 相同按 id 取大的那份", () => {
    approvedPlan("plan_a", ORDER, "2026-10-02T00:00:00.000Z", ["approved"]);
    approvedPlan("plan_b", ORDER, "2026-10-02T00:00:00.000Z", ["approved", "approved", "approved"]);

    expect(rowOf(ORDER)).toEqual([expect.objectContaining({ title: "计划 plan_b", planned: 3 })]);
  });

  it("同一个群两份已批计划只出一行", () => {
    approvedPlan("plan_first", ORDER, "2026-10-01T00:00:00.000Z", ["approved"]);
    approvedPlan("plan_second", ORDER, "2026-10-02T00:00:00.000Z", ["approved", "published"]);

    expect(rowOf(ORDER), "按群去重，只留最新的计划").toEqual([
      expect.objectContaining({ title: "计划 plan_second", published: 1, planned: 2, goal: null }),
    ]);
  });

  it("没有目标、最新计划全部发完的项目不出行", () => {
    approvedPlan("plan_unsent", ORDER, "2026-10-01T00:00:00.000Z", ["approved"]);
    approvedPlan("plan_sent", ORDER, "2026-10-02T00:00:00.000Z", ["published"]);

    expect(rowOf(ORDER), "最新那份发完了，旧计划没发完也不回来").toEqual([]);
  });

  it("任务卡做完的项目有未发完计划也不出行", () => {
    seedProjectGoal();
    approvedPlan("plan_unsent", ORDER, "2026-10-01T00:00:00.000Z", ["approved"]);
    const taskId = groups.get(ORDER)?.taskId ?? "";
    writeTask(taskId, { status: "done" });

    expect(tasks.get(taskId)?.status).toBe("done");
    expect(rowOf(ORDER)).toEqual([]);
  });

  it("成员删空的项目不出行，也记不进数", () => {
    seedProjectGoal();
    approvedPlan("plan_unsent", ORDER, "2026-10-01T00:00:00.000Z", ["approved"]);
    emptyMembers(ORDER);

    expect(rowOf(ORDER), "有目标也有未发完计划，成员没了就不出行").toEqual([]);
    expect(recordSample(ORDER, 888), "空群记数回 null，路由回 404").toBeNull();
  });

  it("跨过上海周一 00:00 没有新样本，本周变化归零", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T15:59:00Z"));
    reseed();
    resetToday();
    seedProjectGoal();
    expect(rowOf(ORDER)[0]?.metric, "周日 23:59 还是本周 +37").toMatchObject({ current: 412, weekDelta: 37 });

    vi.setSystemTime(new Date("2026-10-11T16:01:00Z"));
    expect(rowOf(ORDER)[0]?.metric, "周一 00:01 当前值不变，变化归零").toMatchObject({ current: 412, weekDelta: 0 });
  });
});

// 直接调 mock 的路由函数，拿回状态码、JSON 和推出去的帧。
const callGroups = async (method: string, path: string, body?: unknown) => {
  const reply: { status: number; json: unknown } = { status: 0, json: null };
  const pushes: ServerPush[] = [];
  const res = {
    writeHead: (status: number) => {
      reply.status = status;
      return res;
    },
    end: (payload?: string) => {
      reply.json = payload === undefined ? null : JSON.parse(payload);
    },
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  await groupRoutes({
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    url: new URL(`http://mock${path}`),
    path,
    method,
    push: (push) => void pushes.push(ServerPush.parse(push)),
  });
  return { ...reply, pushes };
};

describe("mock 群列表、任务卡和项目页对齐控制面", () => {
  const crossWeek = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T15:59:00Z"));
    reseed();
    resetToday();
    seedProjectGoal();
    vi.setSystemTime(new Date("2026-10-11T16:01:00Z"));
  };

  it("跨过上海周一 00:00 没有新样本，群列表里的本周变化按当前周重算", async () => {
    crossWeek();
    const listed = await callGroups("GET", "/api/groups");
    const task = GroupListResponse.parse(listed.json).items.find((item) => item.group.id === ORDER)?.task;

    expect(task?.metric, "群列表和首页一样，周一 00:01 变化归零").toMatchObject({ current: 412, weekDelta: 0 });
    expect(rowOf(ORDER)[0]?.metric).toMatchObject({ current: 412, weekDelta: 0 });
  });

  it("跨周后改任务卡，回包和推送里的本周变化也按当前周重算", async () => {
    crossWeek();
    const taskId = groups.get(ORDER)?.taskId ?? "";
    const patched = await callGroups("PATCH", `/api/tasks/${taskId}`, { cadence: "每周一" });

    expect(patched.status).toBe(200);
    expect(UpdateTaskResponse.parse(patched.json).task.metric, "PATCH 回包不带上周的 +37").toMatchObject({
      weekDelta: 0,
    });
    expect(patched.pushes, "task_updated 推出去的也是重算后的").toEqual([
      expect.objectContaining({
        type: "task_updated",
        task: expect.objectContaining({ metric: expect.objectContaining({ weekDelta: 0 }) }),
      }),
    ]);
  });

  it("成果只给 20 条，本周发布数照实数，不被更晚的复盘挤掉", () => {
    seedProjectGoal();
    const template = [...publications.values()][0];
    if (template === undefined) throw new Error("mock 种子里没有发布记录");
    publications.clear();
    for (let at = 0; at < 20; at += 1) {
      const id = PublicationId.parse(`pub_week_${at}`);
      const publishedAt = new Date(Date.now() - 3_600_000 - at * 1000).toISOString();
      publications.set(id, { ...template, id, groupId: groups.get(ORDER)?.id ?? null, publishedAt });
    }
    const project = projectOf(ORDER);

    expect(project?.achievements, "复盘比 20 条发布都晚，成果里占掉一格").toHaveLength(20);
    expect(project?.achievements.filter((item) => item.kind === "review")).toHaveLength(1);
    expect(project?.weekPublished, "本周发了 20 条就是 20，和成果分页无关").toBe(20);
  });
});
