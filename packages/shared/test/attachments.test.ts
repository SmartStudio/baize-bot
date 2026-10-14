import { describe, expect, it } from "vitest";
import { AttachmentUploadResponse, DraftContent, DraftImage, imageMime } from "../src/index.js";

const sha256 = "a".repeat(64);

describe("共用图片魔数", () => {
  it.each([
    [[137, 80, 78, 71, 13, 10, 26, 10], "image/png"],
    [[255, 216, 255], "image/jpeg"],
    [[82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], "image/webp"],
    [[71, 73, 70, 56, 55, 97], "image/gif"],
    [[71, 73, 70, 56, 57, 97], "image/gif"],
  ] as const)("按完整字节签名判定 %j", (signature, mime) => {
    expect(imageMime(new Uint8Array(signature))).toBe(mime);
    expect(imageMime(new Uint8Array(signature.slice(0, -1)))).toBeNull();
  });

  it("空体、文本和高位字节伪造 GIF 头都不认图片", () => {
    expect(imageMime(new Uint8Array())).toBeNull();
    expect(imageMime(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
    expect(imageMime(new Uint8Array([199, 201, 198, 184, 185, 225]))).toBeNull();
  });
});

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
