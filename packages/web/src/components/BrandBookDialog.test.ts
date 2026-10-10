import { describe, expect, it } from "vitest";
import { BrandBook, type BrandEdit } from "@baize/shared";
import { editKey, lengthOf, requestOf, textsOf } from "./BrandBookDialog.js";

const edit = (draftId: string, after: string): BrandEdit =>
  ({ draftId, before: "原句", after, at: "2026-10-09T02:00:00.000Z" }) as BrandEdit;

const book = (version: number, voice: string, edits: BrandEdit[]): BrandBook =>
  BrandBook.parse({
    facts: "白泽做企业 Bot",
    voice,
    taboo: "",
    assetsDir: null,
    edits,
    version,
    updatedAt: "2026-10-09T02:00:00.000Z",
  });

describe("品牌手册保存的请求", () => {
  it("开着弹窗时批草稿追加了改动：按最新版本存，新改动一并带上，不撞 409", () => {
    const base = book(3, "口吻", [edit("drf_a", "甲")]);
    const latest = book(4, "口吻", [edit("drf_a", "甲"), edit("drf_b", "乙")]);
    const request = requestOf(base, latest, { ...textsOf(base), voice: "新口吻" }, new Set());
    expect(request.version).toBe(4);
    expect(request.voice).toBe("新口吻");
    expect(request.edits.map((item) => item.draftId)).toEqual(["drf_a", "drf_b"]);
  });

  it("四段在别处被改过：仍按打开时的版本存，让控制面回 409，不盖掉别人的字", () => {
    const base = book(3, "口吻", []);
    const latest = book(4, "别处改的口吻", []);
    expect(requestOf(base, latest, textsOf(base), new Set()).version).toBe(3);
  });

  it("删掉的那条不随保存送出，其余照旧", () => {
    const kept = edit("drf_a", "甲");
    const dropped = edit("drf_b", "乙");
    const latest = book(2, "口吻", [kept, dropped]);
    const request = requestOf(latest, latest, textsOf(latest), new Set([editKey(dropped)]));
    expect(request.edits).toEqual([kept]);
  });

  it("还没有手册时按版本 0 第一次写，素材文件夹空着送 null", () => {
    const request = requestOf(null, null, { ...textsOf(null), assetsDir: "  " }, new Set());
    expect(request.version).toBe(0);
    expect(request.assetsDir).toBeNull();
  });

  it("字数和控制面一样算四段，素材文件夹去掉首尾空白再算", () => {
    expect(lengthOf({ facts: "一二", voice: "三", taboo: "四五六", assetsDir: " /a " })).toBe(8);
  });
});
