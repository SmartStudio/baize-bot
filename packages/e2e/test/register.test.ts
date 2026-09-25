import { describe, expect, it } from "vitest";
import { BotListResponse, Computer, MeResponse, MessageListResponse } from "@baize/shared";
import { startStack } from "../src/stack.js";
import { startUpstream } from "../src/upstream.js";

describe("端到端：注册账号并启动本机代理", () => {
  it("注册账号、领取本机 token、上线代理后能收到 Bot 回话", async () => {
    const upstream = await startUpstream(() => ({ textChunks: ["注册路径已连通"], usage: { input: 20, output: 5 } }));
    const stack = await startStack({
      upstreamBaseUrl: upstream.baseUrl,
      priceInputPerM: 3,
      priceOutputPerM: 15,
      bootstrap: "register",
    });

    try {
      const me = MeResponse.parse(await stack.get("/api/me"));
      expect(me.user.name).toBe("E2E 用户");
      expect(Computer.parse(await stack.get("/api/computer")).status).toBe("online");

      const first = BotListResponse.parse(await stack.get("/api/bots")).items[0];
      if (first === undefined) throw new Error("注册路径没有建出可对话 Bot");
      await stack.post(`/api/groups/${first.groupId}/messages`, { text: "请确认注册路径已经打通" });

      for (;;) {
        const push = await stack.nextPush();
        if (push.type !== "message" || push.message.groupId !== first.groupId) continue;
        if (push.message.body.kind === "cost") break;
      }
      const messages = MessageListResponse.parse(await stack.get(`/api/groups/${first.groupId}/messages`)).messages;
      const bot = messages.toReversed().find((message) => message.body.kind === "bot");
      expect(bot?.body.kind === "bot" && bot.body.text).toBe("注册路径已连通");
    } finally {
      await stack.close();
      await upstream.close();
    }
  });
});
