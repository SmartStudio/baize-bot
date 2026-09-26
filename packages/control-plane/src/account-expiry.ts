import type { AccountId, UserId } from "@baize/shared";
import { PLATFORM_LABEL, type SettleDeps } from "./publish/settle.js";
import { markLoginExpired, type RejectedCredentials } from "./repo/accounts.js";

/**
 * 账号登录过期了：电脑报上来的，或者控制面拿凭据被平台拒了（带着被拒的那一代）。只从已登录变过来才推、才通知，
 * 已经过期的、被拒的那一代已经换掉的，什么都不做。登录状态随 config.accounts 下发，所以最后重发 config。
 */
export async function expireLogin(
  deps: SettleDeps,
  ownerId: UserId,
  accountId: AccountId,
  rejected?: RejectedCredentials,
): Promise<void> {
  const account = await markLoginExpired(deps.db, {
    ownerId,
    accountId,
    evidence: rejected === undefined ? { kind: "reported" } : { kind: "rejected", ...rejected },
  });
  if (account === null) return;
  deps.push.push(ownerId, { type: "account_updated", account });
  await deps.notifications.publish(ownerId, {
    kind: "failed",
    text: `${PLATFORM_LABEL[account.platform]}账号「${account.handle ?? ""}」登录过期了，这个账号的稿子先不发，到账号页重新登录`,
    groupId: null,
  });
  await deps.agents.sendConfig(ownerId);
}
