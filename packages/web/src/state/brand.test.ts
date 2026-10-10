import { describe, expect, it } from "vitest";
import { BrandBook } from "@baize/shared";
import { reduceBrand } from "./brand.js";
import type { ReadyState } from "./types.js";

const book = (version: number, voice: string) =>
  BrandBook.parse({
    facts: "白泽明理",
    voice,
    taboo: "",
    assetsDir: null,
    edits: [],
    version,
    updatedAt: "2026-10-10T08:00:00.000Z",
  });

// 品牌这条只读写 brand，别的字段用不上。
const initial = { brand: null } as unknown as ReadyState;

describe("品牌手册", () => {
  it("先到 v2 后到 v1，停在 v2", () => {
    const v2 = reduceBrand(initial, { type: "brand_set", brand: book(2, "新口吻") });
    const late = reduceBrand(v2, { type: "brand_set", brand: book(1, "旧口吻") });
    expect(late.brand).toEqual(book(2, "新口吻"));
  });

  it("同一版重复到达不换，新版照换", () => {
    const v1 = reduceBrand(initial, { type: "brand_set", brand: book(1, "第一版") });
    expect(reduceBrand(v1, { type: "brand_set", brand: book(1, "同版另一份") }).brand?.voice).toBe("第一版");
    expect(reduceBrand(v1, { type: "brand_set", brand: book(2, "第二版") }).brand?.voice).toBe("第二版");
  });
});
