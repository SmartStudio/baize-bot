import {
  DecidePreferenceOfferResponse,
  type BotId,
  type GroupId,
  type Message,
  type MessageId,
  type RunId,
} from "@baize/shared";
import { expect } from "vitest";
import type { AgentClient } from "./agent.js";
import type { ApiClient } from "./client.js";
import type { PushClient } from "./ws.js";

export type OfferInput = {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly groupId: GroupId;
  readonly text: string;
  readonly private?: boolean;
  readonly sourceMessageId?: MessageId | null;
};

/** Bot 报一条偏好，不等任何回音。 */
export function sendPreferenceOffer(agent: AgentClient, input: OfferInput): void {
  agent.send({
    type: "preference_offer",
    runId: input.runId,
    botId: input.botId,
    groupId: input.groupId,
    text: input.text,
    private: input.private ?? false,
    sourceMessageId: input.sourceMessageId ?? null,
  });
}

/** Bot 报一条偏好，等群里那张 offered 的确认卡推上来。认卡认到 text 为止，别的推送一概跳过。 */
export async function offerPreference(agent: AgentClient, push: PushClient, input: OfferInput): Promise<Message> {
  sendPreferenceOffer(agent, input);
  for (let seen = 0; seen < 20; seen += 1) {
    const one = await push.next();
    if (one.type !== "message") continue;
    const body = one.message.body;
    if (body.kind === "preference_offer" && body.text === input.text) {
      expect(body.status, "刚推上来的卡还没点过").toBe("offered");
      return one.message;
    }
  }
  throw new Error(`推送里一直没有「${input.text}」的确认卡`);
}

export function decidePreferenceOffer(client: ApiClient, card: Message, decision: "save" | "dismiss") {
  return client.post(`/api/messages/${card.id}/preference-offer`, { decision });
}

/** 点「记住」，要求 200，回响应体。 */
export async function savePreferenceOffer(client: ApiClient, card: Message): Promise<DecidePreferenceOfferResponse> {
  const response = await decidePreferenceOffer(client, card, "save");
  expect(response.status).toBe(200);
  return DecidePreferenceOfferResponse.parse(await response.json());
}
