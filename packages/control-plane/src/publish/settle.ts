import type { Draft, Platform, PublishFailureReason, UserId } from "@baize/shared";
import type { AgentHub } from "../agent/hub.js";
import type { Db } from "../db/client.js";
import type { NoticePublisher } from "../notifications.js";
import type { RejectedCredentials } from "../repo/accounts.js";
import { settleFailed, settlePublished, type LoginEffect, type SettleScope } from "../repo/drafts.js";
import type { PushHub } from "../ws/hub.js";
import type { Published } from "./platforms.js";

export type SettleDeps = {
  readonly db: Db;
  readonly push: PushHub;
  readonly notifications: NoticePublisher;
  readonly agents: Pick<AgentHub, "sendConfig">;
};

export const PLATFORM_LABEL: Record<Platform, string> = { github: "GitHub", x: "X", xiaohongshu: "小红书" };
const FAILURE_TEXT: Record<PublishFailureReason, string> = {
  login_expired: "账号登录过期了，重新登录后让 Bot 再起一稿",
  page_changed: "平台页面变了，没找到发布的地方",
  error: "发布出错了",
};

/** 发出去了：先推发布记录再推草稿，客户端拿到 published 的草稿时链接已经在手上。 */
export async function publishSucceeded(
  deps: SettleDeps,
  scope: SettleScope,
  publishedOn: (platform: Platform) => Published,
): Promise<void> {
  const settled = await settlePublished(deps.db, scope, publishedOn, new Date());
  if (settled === null) return;
  deps.push.push(settled.ownerId, { type: "publication_created", publication: settled.publication });
  deps.push.push(settled.ownerId, { type: "draft_updated", draft: settled.draft });
}

/** 控制面拿凭据被拒的 login_expired 带上被拒的那一代，电脑报上来的不带。 */
export async function publishFailed(
  deps: SettleDeps,
  scope: SettleScope,
  reason: PublishFailureReason,
  rejected?: RejectedCredentials,
): Promise<void> {
  const settled = await settleFailed(deps.db, scope, reason, rejected);
  if (settled !== null) await announceFailure(deps, settled, settled.login);
}

/**
 * 没发出去的草稿推一次新状态，再发一条「没办成」。通知按普通通知走免打扰，用户不在线就丢。
 * 这一下把账号记成过期的，账号的新状态夹在两者之间推，不另发通知：草稿那条已经叫人去重新登录。
 * 账号这边已经有结论的（早先记过期、通知过了，或认领之后已经重登），这里只推草稿状态，不再发通知。
 */
export async function announceFailure(
  deps: SettleDeps,
  settled: { readonly draft: Draft; readonly ownerId: UserId },
  login: LoginEffect = { kind: "unchanged" },
): Promise<void> {
  const { draft, ownerId } = settled;
  deps.push.push(ownerId, { type: "draft_updated", draft });
  if (login.kind === "already_known") return;
  if (login.kind === "expired_now") deps.push.push(ownerId, { type: "account_updated", account: login.account });
  const reason = FAILURE_TEXT[draft.failure ?? "error"];
  await deps.notifications.publish(ownerId, {
    kind: "failed",
    text: `${PLATFORM_LABEL[draft.platform]}上的「${titleOf(draft)}」没发出去：${reason}`,
    groupId: draft.groupId,
  });
  // 登录状态随 config.accounts 下发，运行器按它决定可直接发布档还放不放行。
  if (login.kind === "expired_now") await deps.agents.sendConfig(ownerId);
}

export function titleOf(draft: Draft): string {
  const title = draft.content.kind === "post" ? (draft.content.title ?? draft.content.text) : draft.content.text;
  const chars = [...title.replaceAll("\n", " ")];
  return chars.length > 30 ? `${chars.slice(0, 30).join("")}…` : title;
}
