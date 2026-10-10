import { BrandBook, Grant, GrantId, type BrandEdit, type UpdateBrandRequest } from "@baize/shared";
import type { Outcome } from "./content.js";
import { grants, nextSuffix } from "./store.js";

// 和控制面 repo/brand.ts 同一套口径：四段合计上限、「改过的地方」最多留 50 条、去重键 (draftId, before, after)。
const BRAND_MAX_CHARS = 8000;
const MAX_EDITS = 50;

export const brand: { current: BrandBook | null } = { current: null };

export const resetBrand = (): void => {
  brand.current = null;
};

const write = (book: Omit<BrandBook, "updatedAt">): BrandBook => {
  brand.current = BrandBook.parse({ ...book, updatedAt: new Date().toISOString() });
  return brand.current;
};

export const replaceBrand = (input: UpdateBrandRequest): Outcome<BrandBook> => {
  const length = input.facts.length + input.voice.length + input.taboo.length + (input.assetsDir?.length ?? 0);
  if (length > BRAND_MAX_CHARS) {
    return { ok: false, status: 400, error: `品牌手册四段加起来最多 ${BRAND_MAX_CHARS} 字` };
  }
  if (input.version !== (brand.current?.version ?? 0)) {
    return { ok: false, status: 409, error: "手册刚被更新过，请刷新后再改" };
  }
  const previousAssetsDir = brand.current?.assetsDir ?? null;
  const written = write({ ...input, version: input.version + 1 });
  if (input.assetsDir !== null && input.assetsDir !== previousAssetsDir) grantAssetsRead(input.assetsDir);
  return { ok: true, value: written };
};

// 控制面 grantAssetsRead：素材文件夹换成新值才给本机建永久读授权，同一目标已有就不重复建。
const grantAssetsRead = (prefix: string): void => {
  const target = { kind: "path", computerId: "cmp_local", prefix } as const;
  const same = (grant: Grant) =>
    grant.scope === "forever" && grant.action === "read" && JSON.stringify(grant.target) === JSON.stringify(target);
  if ([...grants.values()].some(same)) return;
  const grant = Grant.parse({
    id: GrantId.parse(`grant_${nextSuffix()}`),
    scope: "forever",
    action: "read",
    target,
    createdAt: new Date().toISOString(),
  });
  grants.set(grant.id, grant);
};

/** 草稿批准时调。同一处改动手册里已经留着就不加，回 null，调用方据此不推 brand_updated。 */
export const recordApprovedEdit = (edit: BrandEdit): BrandBook | null => {
  const current = brand.current;
  const edits = current?.edits ?? [];
  const same = (item: BrandEdit) =>
    item.draftId === edit.draftId && item.before === edit.before && item.after === edit.after;
  if (edits.some(same)) return null;
  return write({
    facts: current?.facts ?? "",
    voice: current?.voice ?? "",
    taboo: current?.taboo ?? "",
    assetsDir: current?.assetsDir ?? null,
    edits: [...edits, edit].slice(-MAX_EDITS),
    version: (current?.version ?? 0) + 1,
  });
};
