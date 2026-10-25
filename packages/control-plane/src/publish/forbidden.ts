import type { AccountScope, Platform } from "@baize/shared";

/** 发带图的帖子要的授权范围。GitHub App 的权限在应用上定，令牌端点不回 scope，没得比。 */
export const IMAGE_SCOPE: Partial<Record<Platform, AccountScope>> = { x: "media.write" };

export function lacksScope(granted: string, needs: AccountScope): boolean {
  return granted !== "" && !granted.split(" ").includes(needs);
}

export function missingScopeOf(platform: Platform, granted: string): AccountScope | null {
  const needs = IMAGE_SCOPE[platform];
  return needs !== undefined && lacksScope(granted, needs) ? needs : null;
}

export type Forbidden =
  { readonly kind: "missing_scope"; readonly scope: AccountScope } | { readonly kind: "forbidden" };

/** 403 出在哪一步：upload 是往平台传图，post 是发帖本身。 */
export type PublishStep = "upload" | "post";

/**
 * needs 是这一条要、而普通发帖用不着的范围。granted 为空串是不知道给过哪些范围。
 * 传图那一步不会因为内容重复被拒，不点名的 403 只要说不准有没有这个范围，就宁可按缺权限叫人重连一次。
 */
export function classifyForbidden(input: {
  readonly step: PublishStep;
  readonly needs: AccountScope | null;
  readonly granted: string;
  readonly body: string;
}): Forbidden {
  const { step, needs, granted, body } = input;
  if (needs === null) return { kind: "forbidden" };
  const unsureOnUpload = step === "upload" && granted === "";
  if (lacksScope(granted, needs) || body.includes(needs) || unsureOnUpload)
    return { kind: "missing_scope", scope: needs };
  return { kind: "forbidden" };
}
