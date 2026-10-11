import { z } from "zod";
import type { PokerTableView } from "@baize/shared";
import { readBody, send, type Route } from "../routes/http.js";
import { pokerTableOf, pokerView } from "./poker.js";

// 牌桌页「旧版本的推送不覆盖新版本」要一个真伪造的推送：mock 自己的推送永远按版本递增，造不出过时的。
// next 把桌子的版本真的加一再推（后面 mock 自己的推送接着往上数，不会撞版本），stale 推一份版本更小的。
// 两种都只改底池，别的字段照 mock 的整视图。

const ForgedPush = z.object({ groupId: z.string(), kind: z.enum(["next", "stale"]), pot: z.number().int() }).strict();

export const pokerWebCoreRoutes: Route = async ({ req, res, path, method, push }) => {
  if (path !== "/api/poker/test/web-core/push" || method !== "POST") return false;
  const parsed = ForgedPush.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: parsed.error.issues[0]?.message ?? "请求格式不对" });
    return true;
  }
  const { groupId, kind, pot } = parsed.data;
  const table = pokerTableOf(groupId);
  if (table === null) {
    send(res, 404, { error: "没有这张桌" });
    return true;
  }
  if (kind === "next") table.version += 1;
  const view = pokerView(table);
  if (view.hand === null) {
    send(res, 409, { error: "没在打牌，没有底池可改" });
    return true;
  }
  const forged: PokerTableView = {
    ...view,
    version: kind === "stale" ? Math.max(0, view.version - 1) : view.version,
    hand: { ...view.hand, view: { ...view.hand.view, pot } },
  };
  push({ type: "poker_table_updated", table: forged });
  send(res, 200, { version: forged.version });
  return true;
};
