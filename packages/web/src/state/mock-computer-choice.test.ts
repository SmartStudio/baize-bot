import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { BotId, ComputerChoices, ServerPush } from "@baize/shared";
import { computerChoiceRoutes } from "../../mock/routes/computer-choices.js";
import {
  messagesByGroupId,
  removedComputers,
  reseed,
  resetToday,
  settleLatestPending,
  streamBotReply,
} from "../../mock/state.js";

const SOLO = "grp_service";
const TEAM = "grp_order";
const SERVICE = BotId.parse("bot_service");

// 直接调 mock 的路由函数，拿回状态码、JSON 和推出去的帧。
const call = async (method: string, path: string, body?: unknown) => {
  const reply: { status: number; json: unknown } = { status: 0, json: null };
  const pushes: ServerPush[] = [];
  const res = {
    writeHead: (status: number) => {
      reply.status = status;
      return res;
    },
    end: (payload?: string) => {
      reply.json = payload === undefined || payload === "" ? null : JSON.parse(payload);
    },
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const handled = await computerChoiceRoutes({
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    url: new URL(`http://mock${path}`),
    path,
    method,
    push: (push) => void pushes.push(ServerPush.parse(push)),
  });
  return { handled, ...reply, pushes };
};

const choices = async (groupId: string) => {
  const got = await call("GET", `/api/groups/${groupId}/computer-choices`);
  expect(got.status).toBe(200);
  return ComputerChoices.parse(got.json);
};

const choose = (groupId: string, botId: string, kind: unknown) =>
  call("PUT", `/api/groups/${groupId}/bots/${botId}/computer`, { kind });

beforeEach(() => {
  reseed();
  resetToday();
});

describe("mock 的电脑选择两个端点对齐控制面", () => {
  it("GET 按成员顺序每个 Bot 一项，没选过、没在跑都是 null", async () => {
    expect(await choices(TEAM)).toEqual([
      { botId: "bot_service", kind: null, runningOn: null },
      { botId: "bot_sales", kind: null, runningOn: null },
      { botId: "bot_buy", kind: null, runningOn: null },
    ]);
    expect(await choices(SOLO)).toEqual([{ botId: "bot_service", kind: null, runningOn: null }]);
  });

  it("PUT 换了：群里先落一条系统消息再推 computer_choice_updated，回 204；同一个值再选一次不推", async () => {
    const changed = await choose(TEAM, "bot_sales", "remote");
    expect(changed.status).toBe(204);
    expect(changed.pushes.map((push) => push.type)).toEqual(["message", "computer_choice_updated"]);
    const [line, updated] = changed.pushes;
    expect(line?.type === "message" ? line.message.body : null).toEqual({
      kind: "system",
      text: "小销之后在这个群里用云电脑",
    });
    expect(messagesByGroupId.get(TEAM)?.at(-1)?.body, "系统消息进了群历史，刷新还在").toEqual({
      kind: "system",
      text: "小销之后在这个群里用云电脑",
    });
    expect(updated).toEqual({ type: "computer_choice_updated", groupId: TEAM, botId: "bot_sales", kind: "remote" });
    expect((await choices(TEAM))[1]).toEqual({ botId: "bot_sales", kind: "remote", runningOn: null });
    expect((await choices(SOLO))[0]?.kind, "同一个 Bot 在单聊里的选择不受影响").toBeNull();

    const again = await choose(TEAM, "bot_sales", "remote");
    expect(again.status).toBe(204);
    expect(again.pushes, "值没变不推").toEqual([]);

    const back = await choose(TEAM, "bot_sales", "local");
    expect(back.pushes[0]?.type === "message" ? back.pushes[0].message.body : null).toEqual({
      kind: "system",
      text: "小销之后在这个群里用你的电脑",
    });
  });

  it("离线的那台照样能选；账号下没有那台才 409，带中文原文", async () => {
    const offline = await choose(SOLO, "bot_service", "remote");
    expect(offline.status, "选云电脑不要求它此刻在线").toBe(204);

    removedComputers.add("cmp_remote");
    const missing = await choose(TEAM, "bot_service", "remote");
    expect(missing).toMatchObject({ status: 409, json: { error: "你还没有云电脑，选不了" }, pushes: [] });
    removedComputers.add("cmp_local");
    expect((await choose(TEAM, "bot_service", "local")).json).toEqual({ error: "你还没有接上自己的电脑，选不了" });
  });

  it("群不存在、Bot 不在这个群里回 404，请求体不对回 400", async () => {
    expect((await choose("grp_nope", "bot_service", "remote")).status).toBe(404);
    expect((await choose(SOLO, "bot_sales", "remote")).status).toBe(404);
    expect((await call("GET", "/api/groups/grp_nope/computer-choices")).status).toBe(404);
    expect((await choose(SOLO, "bot_service", "cloud")).status).toBe(400);
  });

  it("别的路径不归它管", async () => {
    expect((await call("GET", `/api/groups/${SOLO}/messages`)).handled).toBe(false);
  });
});

describe("mock 的 runningOn：这一轮还在开跑时那台上，跑完的推送出去之前已经清掉", () => {
  it("等审批时换到云电脑，runningOn 还是你的电脑；批了跑完，花费卡推出去那一刻已经是 null", async () => {
    const atCost: ComputerChoices[] = [];
    const pending: { resolve: () => void } = { resolve: () => undefined };
    const asked = new Promise<void>((resolve) => {
      pending.resolve = resolve;
    });
    const done = streamBotReply(SOLO, SERVICE, "帮我退款", (push) => {
      if (push.type === "approval_updated" && push.approval.status === "pending") pending.resolve();
      // 推送是同步发出去的：网页收到花费卡再来拉，读到的不会比这一刻更早。
      if (push.type === "message" && push.message.body.kind === "cost") void choices(SOLO).then((c) => atCost.push(c));
    });
    await asked;
    expect(await choices(SOLO), "没选过走默认，开跑时在你的电脑上").toEqual([
      { botId: "bot_service", kind: null, runningOn: "local" },
    ]);

    expect((await choose(SOLO, "bot_service", "remote")).status).toBe(204);
    expect(await choices(SOLO), "这一轮还在你的电脑上跑完").toEqual([
      { botId: "bot_service", kind: "remote", runningOn: "local" },
    ]);

    expect(settleLatestPending(SOLO, "approved")).not.toBeNull();
    await done;
    expect(atCost.flat()).toEqual([{ botId: "bot_service", kind: "remote", runningOn: null }]);

    const next = streamBotReply(SOLO, SERVICE, "查一下库存", (push) => {
      if (push.type === "message" && push.message.body.kind === "tool_call")
        void choices(SOLO).then((c) => atCost.push(c));
    });
    await next;
    expect(atCost.at(-1), "下一条起用云电脑").toEqual([{ botId: "bot_service", kind: "remote", runningOn: "remote" }]);
  });
});
