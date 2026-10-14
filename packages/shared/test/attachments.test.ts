import { describe, expect, it } from "vitest";
import { AttachmentUploadResponse, DraftContent, DraftImage } from "../src/index.js";

const sha256 = "a".repeat(64);

describe("草稿配图的旧库兼容边界", () => {
  it("没有 kind 的旧配图补为 path 支，整个草稿内容一并解析", () => {
    const image = { path: "/data/bot/drafts/a.png", sha256 };
    expect(DraftImage.parse(image)).toEqual({ kind: "path", ...image });
    const content = DraftContent.parse({ kind: "post", title: "旧稿", text: "正文", github: null, images: [image] });
    expect(content.images).toEqual([{ kind: "path", ...image }]);
  });

  it("新附件支保留 id、哈希和 mime，不允许混入本地路径", () => {
    const image = { kind: "attachment", attachmentId: "attachment-1", sha256, mime: "image/png" };
    expect(DraftImage.parse(image)).toEqual(image);
    expect(DraftImage.safeParse({ ...image, path: "/secret" }).success).toBe(false);
    expect(DraftImage.safeParse({ ...image, mime: "image/svg+xml" }).success).toBe(false);
    expect(DraftImage.safeParse({ ...image, sha256: "bad" }).success).toBe(false);
    expect(DraftImage.safeParse({ ...image, kind: undefined }).success).toBe(false);
    expect(AttachmentUploadResponse.safeParse({ attachmentId: "a", sha256: "bad" }).success).toBe(false);
  });
});
