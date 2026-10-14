import { BotId, GroupId, HubLaneSnapshot, RecallRequest, RecallResponse, WorkStream } from "@baize/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";
import { toComputer } from "../repo/rows.js";
import { readWorkLane, recallWorkRecords } from "../repo/work-records.js";
import { hubAuth, type HubEnv } from "./hub-auth.js";
import { createAttachmentRoutes } from "./routes/attachments.js";
import { LANE_FENCE_ERRORS, validateLaneFence } from "./lane-fence.js";

export const HUB_PATH = "/hub/v1";

export function createHub(deps: { readonly db: Db }): Hono<HubEnv> {
  const app = new Hono<HubEnv>();
  app.use("*", hubAuth(deps.db));
  app.route("/", createAttachmentRoutes(deps));
  app.post("/recall", async (c) =>
    deps.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(computers)
          .where(eq(computers.id, c.get("computerId")));
        if (row === undefined) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
        const fence = await validateLaneFence(tx, toComputer(row), c.req.header("x-baize-lane"));
        if (fence.kind !== "ok") return c.json({ error: LANE_FENCE_ERRORS[fence.kind] }, 409);
        const request = RecallRequest.safeParse(await c.req.json().catch(() => null));
        if (!request.success) return c.json({ error: "召回参数格式不对" }, 400);
        return c.json(
          RecallResponse.parse(
            await recallWorkRecords(
              tx,
              c.get("ownerId"),
              { kind: "bot", botId: fence.lane.botId },
              fence.lane.groupId,
              request.data.query,
            ),
          ),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ),
  );
  app.get("/lanes/:botId/:groupId/:stream", async (c) =>
    deps.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(computers)
          .where(eq(computers.id, c.get("computerId")));
        if (row === undefined) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
        const fence = await validateLaneFence(tx, toComputer(row), c.req.header("x-baize-lane"));
        if (fence.kind !== "ok") return c.json({ error: LANE_FENCE_ERRORS[fence.kind] }, 409);
        const bot = BotId.safeParse(c.req.param("botId"));
        const group = GroupId.safeParse(c.req.param("groupId"));
        const stream = WorkStream.safeParse(c.req.param("stream"));
        if (
          !bot.success ||
          !group.success ||
          !stream.success ||
          bot.data !== fence.lane.botId ||
          group.data !== fence.lane.groupId
        )
          return c.json({ error: LANE_FENCE_ERRORS.not_holder }, 409);
        const after = integerQuery(c.req.query("after"), -1, -1, Number.MAX_SAFE_INTEGER);
        const limit = integerQuery(c.req.query("limit"), 64, 1, 200);
        if (after === null || limit === null) return c.json({ error: "分页参数格式不对" }, 400);
        return c.json(HubLaneSnapshot.parse(await readWorkLane(tx, fence.lane, stream.data, after, limit)));
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ),
  );
  return app;
}

function integerQuery(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}
