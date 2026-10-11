import {
  CreatePokerTableRequest,
  HintRequest,
  LeaveTableRequest,
  PokerActRequest,
  StartHandRequest,
  SwapSeatRequest,
  type PokerTableResponse,
  type PokerTableView,
} from "@baize/shared";
import { z } from "zod";
import {
  PokerMockError,
  pokerAskHint,
  pokerCreateTable,
  pokerLeave,
  pokerPublish,
  pokerStartHand,
  pokerStep,
  pokerSwapSeat,
  pokerTableList,
  pokerTableOf,
  pokerTableOfHand,
  pokerTiming,
  pokerUserAct,
  pokerView,
  type MockPokerTable,
} from "../state/poker.js";
import { pokerProjectTestRoute } from "../state/poker-project-review.js";
import { pokerProjectRoutes } from "../state/poker-project-seats.js";
import { readBody, send, type Push, type Route } from "./http.js";

// 牌桌接口，契约在 shared/poker.ts，每个都回整份牌桌视图 { table }。桌子的变化另外推 poker_table_updated。
// 牌友出牌排成任务队，默认每 600ms 走一条；测试用 /api/poker/test/* 改节奏或手动走一拍，不用等真实时间。

const TablePath = /^\/api\/poker\/tables\/([^/]+)(?:\/(hands|leave|seats\/(\d+)))?$/;
const HandPath = /^\/api\/poker\/hands\/([^/]+)\/(act|hint)$/;

const DelayRequest = z.object({ ms: z.number().int().min(0).nullable() }).strict();
const TickRequest = z.object({ groupId: z.string().optional() }).strict();

const reply = (res: Parameters<Route>[0]["res"], table: PokerTableView, status = 200): void => {
  const body: PokerTableResponse = { table };
  send(res, status, body);
};

const parseBody = async <T extends z.ZodType>(context: Parameters<Route>[0], schema: T): Promise<z.infer<T> | null> => {
  const parsed = schema.safeParse(await readBody(context.req));
  if (parsed.success) return parsed.data;
  send(context.res, 400, { error: parsed.error.issues[0]?.message ?? "请求格式不对" });
  return null;
};

const changed = (table: MockPokerTable, push: Push): PokerTableView => {
  pokerPublish(table, push);
  return pokerView(table);
};

const testRoute: Route = async (context) => {
  const { res, path, method, push } = context;
  if (method !== "POST") return false;
  if (path === "/api/poker/test/delay") {
    const body = await parseBody(context, DelayRequest);
    if (body === null) return true;
    const tables = pokerTableList();
    pokerTiming.botTurnMs = body.ms;
    for (const table of tables) pokerPublish(table, push);
    send(res, 200, { ms: body.ms });
    return true;
  }
  if (path === "/api/poker/test/tick") {
    const body = await parseBody(context, TickRequest);
    if (body === null) return true;
    const table = body.groupId === undefined ? (pokerTableList()[0] ?? null) : pokerTableOf(body.groupId);
    if (table === null) {
      send(res, 404, { error: "没有这张桌" });
      return true;
    }
    const ran = pokerStep(table, push);
    send(res, 200, { ran, table: pokerView(table) });
    return true;
  }
  return false;
};

export const pokerRoutes: Route = async (context) => {
  const { res, path, method, push } = context;
  if (!path.startsWith("/api/poker/")) return false;
  if (await pokerProjectTestRoute(context)) return true;
  if (path.startsWith("/api/poker/test/")) return testRoute(context);
  if (await pokerProjectRoutes(context)) return true;

  try {
    if (path === "/api/poker/tables" && method === "GET") {
      send(res, 200, { tables: pokerTableList().map(pokerView) });
      return true;
    }
    if (path === "/api/poker/tables" && method === "POST") {
      const body = await parseBody(context, CreatePokerTableRequest);
      if (body === null) return true;
      const { table, created } = pokerCreateTable(body.requestId);
      reply(res, created ? changed(table, push) : pokerView(table), created ? 201 : 200);
      return true;
    }

    const tableMatch = TablePath.exec(path);
    if (tableMatch !== null) {
      const table = pokerTableOf(decodeURIComponent(tableMatch[1] ?? ""));
      if (table === null) {
        send(res, 404, { error: "没有这张桌" });
        return true;
      }
      const tail = tableMatch[2];
      if (tail === undefined) {
        if (method !== "GET") return false;
        reply(res, pokerView(table));
        return true;
      }
      if (method !== "POST") return false;
      if (tail === "hands") {
        if ((await parseBody(context, StartHandRequest)) === null) return true;
        pokerStartHand(table, push);
      } else if (tail === "leave") {
        if ((await parseBody(context, LeaveTableRequest)) === null) return true;
        pokerLeave(table, push);
      } else {
        const body = await parseBody(context, SwapSeatRequest);
        if (body === null) return true;
        pokerSwapSeat(table, Number(tableMatch[3]), body.persona);
      }
      reply(res, changed(table, push));
      return true;
    }

    const handMatch = HandPath.exec(path);
    if (handMatch !== null && method === "POST") {
      const handId = decodeURIComponent(handMatch[1] ?? "");
      const table = pokerTableOfHand(handId);
      if (table === null) {
        send(res, 404, { error: "没有这手牌" });
        return true;
      }
      if (handMatch[2] === "act") {
        const body = await parseBody(context, PokerActRequest);
        if (body === null) return true;
        pokerUserAct(table, handId, body, push);
      } else {
        const body = await parseBody(context, HintRequest);
        if (body === null) return true;
        pokerAskHint(table, handId, body.seq);
      }
      reply(res, changed(table, push));
      return true;
    }
  } catch (cause) {
    if (!(cause instanceof PokerMockError)) throw cause;
    send(res, cause.status, { error: cause.message });
    return true;
  }
  send(res, 404, { error: `没有这个接口 ${method} ${path}` });
  return true;
};
