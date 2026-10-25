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

/** needs 是这一条要、而普通发帖用不着的范围。 */
export function classifyForbidden(input: {
  readonly needs: AccountScope | null;
  readonly granted: string;
  readonly body: string;
}): Forbidden {
  const { needs, granted, body } = input;
  if (needs === null) return { kind: "forbidden" };
  if (lacksScope(granted, needs) || body.includes(needs)) return { kind: "missing_scope", scope: needs };
  return { kind: "forbidden" };
}
