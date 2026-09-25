import { BotId, Group, GroupId, Notice, ServerPush } from "@baize/shared";
import { z } from "zod";
import {
  confirmNextHandoff,
  addTodayApproval,
  expireLatestPending,
  groups,
  holdHandoffAccept,
  reseed,
  resetToday,
  seedUnseenHandoff,
  setTodayMode,
  settleUnseenHandoff,
} from "../state.js";
import { resetRegisteredEmails } from "./auth.js";
import { readBody, send, type Route } from "./http.js";

const GroupUpdateTrigger = z.object({ groupId: GroupId, chiefBotId: BotId.nullable() });
const TodayModeRequest = z.object({ mode: z.enum(["full", "empty", "performance"]) }).strict();
const TodayPendingRequest = z.object({ title: z.string().min(1).max(80) }).strict();
const activeTurns = new Map<GroupId, Extract<ServerPush, { type: "group_turn" }>>();
const turnEpochs = new Map<GroupId, number>();

export const currentTurns = (): Iterable<Extract<ServerPush, { type: "group_turn" }>> => activeTurns.values();

export const testRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/test/reset") {
    reseed();
    resetToday();
    resetRegisteredEmails();
    activeTurns.clear();
    turnEpochs.clear();
    send(res, 204);
    return true;
  }

  if (method === "POST" && path === "/api/test/today") {
    const parsed = TodayModeRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Today 模式不对" });
    else {
      setTodayMode(parsed.data.mode);
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/today/pending") {
    const parsed = TodayPendingRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Today 待办参数不对" });
    else {
      const approval = addTodayApproval(parsed.data.title);
      push({ type: "approval_updated", approval });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/notify") {
    const parsed = Notice.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "通知参数不对" });
    else {
      push({ type: "notify", notice: parsed.data });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/group/updated") {
    const parsed = GroupUpdateTrigger.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "群更新参数不对" });
    else {
      const group = groups.get(parsed.data.groupId);
      if (group === undefined) send(res, 404, { error: "没有这个群" });
      else if (parsed.data.chiefBotId !== null && !group.botIds.includes(parsed.data.chiefBotId)) {
        send(res, 400, { error: "首席不在群里" });
      } else {
        const updated = Group.parse({ ...group, chiefBotId: parsed.data.chiefBotId });
        groups.set(updated.id, updated);
        push({ type: "group_updated", group: updated });
        send(res, 204);
      }
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/group/turn") {
    const body = await readBody(req);
    const parsed = ServerPush.safeParse(
      typeof body === "object" && body !== null ? { ...body, type: "group_turn" } : body,
    );
    if (!parsed.success || parsed.data.type !== "group_turn") send(res, 400, { error: "群回合参数不对" });
    else if (!groups.has(parsed.data.groupId)) send(res, 404, { error: "没有这个群" });
    else {
      const turn = parsed.data;
      if (turn.epoch >= (turnEpochs.get(turn.groupId) ?? -1)) {
        turnEpochs.set(turn.groupId, turn.epoch);
        if (turn.current === null && turn.next.length === 0) activeTurns.delete(turn.groupId);
        else activeTurns.set(turn.groupId, turn);
      }
      push(turn);
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/pending") {
    send(res, 201, { handoff: seedUnseenHandoff() });
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/hold") {
    holdHandoffAccept();
    send(res, 204);
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/accept") {
    if (confirmNextHandoff()) send(res, 204);
    else {
      const accepted = settleUnseenHandoff();
      if (accepted === null) send(res, 404, { error: "没有待确认的交接" });
      else {
        push({ type: "handoff_updated", handoff: accepted });
        send(res, 204);
      }
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/approval/expire") {
    const expired = expireLatestPending();
    if (expired === null) send(res, 409, { error: "没有待失效的审批" });
    else {
      push({ type: "approval_updated", approval: expired });
      send(res, 204);
    }
    return true;
  }

  return false;
};
