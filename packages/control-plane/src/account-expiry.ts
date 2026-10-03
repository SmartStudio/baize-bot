import type { AccountId, UserId } from "@baize/shared";
import { PLATFORM_LABEL, type SettleDeps } from "./publish/settle.js";
import { markLoginExpired, type RejectedCredentials, type ReportingConnection } from "./repo/accounts.js";

/**
 * 过期的依据：控制面拿凭据被平台拒了（带着被拒的那一代），或电脑代理在某条连接上看着浏览器说的
 * （带那条连接，连接被顶掉之后写不进去）。
 */
export type ExpiryCause = RejectedCredentials | ReportingConnection;

/**
 * 账号登录过期了。只从已登录变过来才推、才通知：已经过期的、被拒的那一代已经换掉的、报它的连接已经被顶掉的，
 * 什么都不做。登录状态随 config.accounts 下发，所以最后重发 config。
 */
export async function expireLogin(
  deps: SettleDeps,
  ownerId: UserId,
  accountId: AccountId,
  cause: ExpiryCause,
): Promise<void> {
  const account = await markLoginExpired(deps.db, {
    ownerId,
    accountId,
    evidence: "gatewayKey" in cause ? { kind: "reported", connection: cause } : { kind: "rejected", ...cause },
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
