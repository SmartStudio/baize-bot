import { BotId, Message, MessageId, PokerPersona, Timestamp } from "@baize/shared";
import { z } from "zod";
import { readBody, send, type Route } from "../routes/http.js";
import { messagesByGroupId, nextSuffix } from "./store.js";
import { pokerTableOf } from "./poker.js";

// 牌桌右栏要两样 mock 本体没有的东西：牌桌群的消息历史（刷新后「牌桌上」和老白的建议从这里回来），
// 和一个往牌桌群里塞任意几条话的口子（顺序、溢出、署名这几类用例要造本体不会自己产生的话）。
// 牌桌没有对应的 Group，通用的群消息路由会回 404，所以历史由这里接。

const MESSAGES_PATH = /^\/api\/groups\/([^/]+)\/messages$/;

const Line = z
  .object({
    speaker: z.union([PokerPersona, z.literal("user")]),
    text: z.string().min(1),
    at: Timestamp.optional(),
    private: z.boolean().optional(),
  })
  .strict();
const SayRequest = z.object({ groupId: z.string().min(1), lines: z.array(Line).min(1) }).strict();

// 和 state/poker.ts 的 botIdOf 同一个写法：牌友的 botId 是 bot_poker_ 加人设名。
const botIdOf = (persona: PokerPersona): BotId => BotId.parse(`bot_poker_${persona}`);

export const tableSideRoutes: Route = async ({ req, res, path, method, url, push }) => {
  const listed = MESSAGES_PATH.exec(path);
  if (listed !== null && method === "GET") {
    const groupId = decodeURIComponent(listed[1] ?? "");
    if (pokerTableOf(groupId) === null) return false;
    const all = messagesByGroupId.get(groupId) ?? [];
    const before = url.searchParams.get("before");
    const end = before === null ? all.length : all.findIndex((message) => message.id === before);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const start = Math.max(0, (end < 0 ? all.length : end) - limit);
    send(res, 200, {
      messages: all.slice(start, end < 0 ? all.length : end),
      hasMore: start > 0,
      approvals: [],
      handoffs: [],
      drafts: [],
      plans: [],
      publications: [],
    });
    return true;
  }

  if (path === "/api/poker/test/side/say" && method === "POST") {
    const parsed = SayRequest.safeParse(await readBody(req));
    if (!parsed.success) {
      send(res, 400, { error: parsed.error.issues[0]?.message ?? "请求格式不对" });
      return true;
    }
    const { groupId, lines } = parsed.data;
    if (pokerTableOf(groupId) === null) {
      send(res, 404, { error: "没有这张桌" });
      return true;
    }
    const list = messagesByGroupId.get(groupId) ?? [];
    messagesByGroupId.set(groupId, list);
    for (const line of lines) {
      const message = Message.parse({
        id: MessageId.parse(`msg_side_${nextSuffix()}`),
        groupId,
        body:
          line.speaker === "user"
            ? { kind: "user", text: line.text }
            : { kind: "bot", botId: botIdOf(line.speaker), text: line.text, streaming: false },
        createdAt: line.at ?? new Date().toISOString(),
        revision: 0,
        visibleTo: line.private === true ? [{ kind: "user" }] : null,
      });
      list.push(message);
      push({ type: "message", message });
    }
    send(res, 200, { said: lines.length });
    return true;
  }
  return false;
};
