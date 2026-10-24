import { GroupId, ReportMetricRequest, UpdateTaskResponse, metricKeyOf } from "@baize/shared";
import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import { recordSample } from "../../repo/metrics.js";
import { findTaskByGroup } from "../../repo/tasks.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_FOUND = { error: "没有这个项目" } as const;

export type GoalRouteDeps = { readonly db: Db; readonly push: PushHub };

/** 挂在 /api 下。手动记一个数：别人的群、单 Bot 群、成员删光的群都 404。 */
export function createGoalRoutes({ db, push }: GoalRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/projects/:groupId/metric", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("groupId"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const body = ReportMetricRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);

    const ownerId = c.get("user").id;
    const { value, metric } = body.data;
    const recorded = await recordSample(db, ownerId, groupId.data, value, "manual", ({ sources, goalMetric }) =>
      metric === undefined
        ? { kind: "land", metric: goalMetric }
        : sources.some((source) => metricKeyOf(source) === metric)
          ? { kind: "land", metric }
          : { kind: "refused", reason: "unknown_metric" },
    );
    if (recorded.kind === "not_found") return c.json(NOT_FOUND, 404);
    if (recorded.kind === "refused") return c.json({ error: "这个项目没挂这个指标" }, 400);
    const task = await findTaskByGroup(db, recorded.groupId);
    if (task === null) return c.json(NOT_FOUND, 404);
    push.push(ownerId, { type: "task_updated", task });
    return c.json(UpdateTaskResponse.parse({ task }));
  });
  return app;
}
