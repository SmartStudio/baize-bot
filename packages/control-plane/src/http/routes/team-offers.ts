import { DecideTeamOfferRequest, DecideTeamOfferResponse, MessageId, type GroupId, type UserId } from "@baize/shared";
import { Hono } from "hono";
import type { AgentHub } from "../../agent/hub.js";
import type { Db } from "../../db/client.js";
import { GROUP_BOT_LIMIT, findGroup } from "../../repo/groups.js";
import { decideTeamOffer, findOwnedTeamOffer } from "../../repo/team-offers.js";
import type { PushHub } from "../../ws/hub.js";
import type { Env } from "../app.js";

export type TeamOfferRouteDeps = { readonly db: Db; readonly hub: PushHub; readonly agents: AgentHub };

const NOT_FOUND = { error: "没有这个对象" } as const;

/** 挂在 /api 下。 */
export function createTeamOfferRoutes({ db, hub, agents }: TeamOfferRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  /** 每个群上一次发布的尾巴。读群和推送排成一队，后进队的读一定在先进队的那次提交之后。 */
  const publishing = new Map<GroupId, Promise<unknown>>();

  /**
   * 确认提交之后重读群再推。不推事务里的快照：两次确认的提交回执可能逆序到达，先提交的那份 3 人快照会盖掉 4 人的。
   * 只重读也不够，两次重读的结果同样可能逆序推出去，所以同一个群的读和推在本进程里串成一队，最后一次推的就是最后一次读到的。
   */
  const publishGroup = (ownerId: UserId, groupId: GroupId): Promise<void> => {
    const turn = (publishing.get(groupId) ?? Promise.resolve()).then(async () => {
      const detail = await findGroup(db, ownerId, groupId);
      if (detail !== null) hub.push(ownerId, { type: "group_updated", group: detail.group });
    });
    const tail = turn.catch(() => undefined);
    publishing.set(groupId, tail);
    void tail.then(() => {
      if (publishing.get(groupId) === tail) publishing.delete(groupId);
    });
    return turn;
  };

  app.post("/messages/:id/team-offer", async (c) => {
    const messageId = MessageId.safeParse(c.req.param("id"));
    if (!messageId.success) return c.json(NOT_FOUND, 404);
    const ownerId = c.get("user").id;
    const offer = await findOwnedTeamOffer(db, ownerId, messageId.data);
    if (offer === null) return c.json(NOT_FOUND, 404);
    const body = DecideTeamOfferRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "请求体不合法" }, 400);

    const decided = await decideTeamOffer(db, ownerId, offer, body.data);
    switch (decided.kind) {
      case "settled":
        return c.json({ error: "这张建队卡已经确认过了" }, 409);
      case "bad_pick":
        return c.json({ error: "至少勾一个卡上的人" }, 400);
      case "too_many":
        return c.json(
          { error: `一个群最多 ${GROUP_BOT_LIMIT} 个 Bot，这样加完是 ${decided.total} 个，少勾几个再确认` },
          400,
        );
      case "member_gone":
        return c.json({ error: `卡上第 ${decided.positions.join("、")} 位已经不在了，重新勾一下` }, 409);
      case "project_gone":
        return c.json(NOT_FOUND, 404);
      case "deferred":
        hub.push(ownerId, { type: "message", message: decided.message });
        return c.json(DecideTeamOfferResponse.parse({ message: decided.message, group: null, bots: [] }));
      case "confirmed": {
        // 新人先到，Web 画群成员时才认得他们；bot_created 带单聊群 id，Web 不用再拉 Bot 列表。
        for (const { bot, groupId } of decided.created) hub.push(ownerId, { type: "bot_created", bot, groupId });
        // 推的是提交后重读的群；回包仍用事务里的快照，和卡上写下的人一致。
        await publishGroup(ownerId, decided.group.id);
        // 卡的状态住在正文里，点完重推那条消息，客户端按 id 覆盖。
        hub.push(ownerId, { type: "message", message: decided.message });
        // 新人要进 config 才跑得起来。只加已有的人时 Bot 列表没变，config 不用重发。
        if (decided.created.length > 0) await agents.sendConfig(ownerId);
        return c.json(
          DecideTeamOfferResponse.parse({ message: decided.message, group: decided.group, bots: decided.added }),
        );
      }
    }
  });

  return app;
}
