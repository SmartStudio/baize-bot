import type { AgentToControl, BrowserPlatform, ControlToAgent } from "@baize/shared";

export type PublishDraftMessage = Extract<ControlToAgent, { type: "publish_draft" }>;
export type PublishResultMessage = Extract<AgentToControl, { type: "publish_result" }>;
type Publisher = (draft: PublishDraftMessage) => Promise<PublishResultMessage["result"]>;

// 本机发布器按平台登记，P1-5 接小红书时往这里加一行。
const PUBLISHERS: Partial<Record<BrowserPlatform, Publisher>> = {};

/** 控制面下行的 publish_draft 走到这里，回一条 publish_result，控制面按它改草稿状态。 */
export async function publishDraft(message: PublishDraftMessage): Promise<PublishResultMessage> {
  const publisher = PUBLISHERS[message.platform];
  const result: PublishResultMessage["result"] =
    publisher === undefined
      ? { status: "failed", reason: "error", detail: "本机发布器还没接上" }
      : await publisher(message);
  return { type: "publish_result", draftId: message.draftId, result };
}
