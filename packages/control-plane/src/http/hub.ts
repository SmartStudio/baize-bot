import {
  BotId,
  GroupId,
  HubLaneSnapshot,
  RecallRequest,
  RecallResponse,
  SwitchComputerRequest,
  SwitchComputerResponse,
  WorkStream,
  type ServerPush,
} from "@baize/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { computerAvailability, type AvailabilityAgents } from "../agent/computer-availability.js";
import { requestSwitch } from "../agent/continuation.js";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";
import { toComputer } from "../repo/rows.js";
import { readWorkLane, recallWorkRecords } from "../repo/work-records.js";
import type { PushHub } from "../ws/hub.js";
import { hubAuth, type HubEnv } from "./hub-auth.js";
import { createAttachmentRoutes } from "./routes/attachments.js";
import { LANE_FENCE_ERRORS, validateLaneFence } from "./lane-fence.js";

export const HUB_PATH = "/hub/v1";

export type HubDeps = { readonly db: Db; readonly agents: AvailabilityAgents; readonly push: PushHub };

export function createHub(deps: HubDeps): Hono<HubEnv> {
  const app = new Hono<HubEnv>();
  app.use("*", hubAuth(deps.db));
  app.route("/", createAttachmentRoutes(deps));
  // Bot 在这一轮里换电脑。选择和 run 上的标记一个事务落下，推送等提交后再出。
  app.post("/lane/computer", async (c) => {
    const pushes: ServerPush[] = [];
    const ownerId = c.get("ownerId");
    const response = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(computers)
        .where(eq(computers.id, c.get("computerId")));
      if (row === undefined) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
      const computer = toComputer(row);
      const fence = await validateLaneFence(tx, computer, c.req.header("x-baize-lane"));
      if (fence.kind !== "ok") return c.json({ error: LANE_FENCE_ERRORS[fence.kind] }, 409);
      const request = SwitchComputerRequest.safeParse(await c.req.json().catch(() => null));
      if (!request.success) return c.json({ error: "换电脑的参数格式不对" }, 400);
      const { outcome, pushes: changed } = await requestSwitch(
        tx,
        { ownerId, computerId: computer.id, lane: fence.lane, runId: request.data.runId, kind: request.data.kind },
        { availability: () => computerAvailability(tx, deps.agents, ownerId) },
      );
      pushes.push(...changed);
      return c.json(SwitchComputerResponse.parse(outcome));
    });
    for (const one of pushes) deps.push.push(ownerId, one);
    return response;
  });
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
