import { GroupId, RoutineId } from "@baize/shared";
import { Hono } from "hono";
import type { Db } from "../../db/client.js";
import { loadRoutine, markGroupRoutineRunsSeen } from "../../repo/routines.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

const NOT_FOUND = { error: "没有这个对象" } as const;

export type SeenRouteDeps = { readonly db: Db; readonly push: PushHub };

/** 挂在 /api 下。用户打开了群或它的项目页，群里已结束的例行运行记成看过，盖了章的例行各推一遍。 */
export function createSeenRoutes({ db, push }: SeenRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.post("/groups/:id/seen", async (c) => {
    const groupId = GroupId.safeParse(c.req.param("id"));
    if (!groupId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const stamped = await markGroupRoutineRunsSeen(db, ownerId, groupId.data);
    if (stamped === null) return c.json(NOT_FOUND, 404);
    for (const routineId of stamped) {
      const loaded = await loadRoutine(db, RoutineId.parse(routineId));
      if (loaded !== null) push.push(ownerId, { type: "routine_updated", routine: loaded.routine });
    }
    return c.body(null, 204);
  });
  return app;
}
