import { AccountId, type DraftContent } from "@baize/shared";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/repo/drafts.js";

const ACCOUNT = AccountId.parse("0d9a3a55-5b8e-4d1c-9f0e-3f7c1f2a6b01");
const OTHER = AccountId.parse("0d9a3a55-5b8e-4d1c-9f0e-3f7c1f2a6b02");
const A = { kind: "path" as const, path: "/tmp/a.png", sha256: "a".repeat(64) };
const B = { kind: "path" as const, path: "/tmp/b.png", sha256: "b".repeat(64) };

const post: DraftContent = {
  kind: "post",
  title: "周报",
  text: "这周做了三件事",
  images: [A, B],
  github: { repo: "baize/demo", as: "issue" },
};
const reply: DraftContent = {
  kind: "reply",
  text: "谢谢反馈",
  images: [],
  replyTo: { url: "https://x.com/a/status/1", author: "a", quote: "原帖" },
};

const hash = (content: DraftContent, platform: "github" | "x" = "github", account = ACCOUNT) =>
  contentHash({ platform, accountId: account, content });

describe("内容哈希", () => {
  it("是 64 位十六进制，同样的输入同样的结果", () => {
    expect(hash(post)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(post)).toBe(hash(structuredClone(post)));
  });

  it("平台、账号、正文、标题、发布目标、图片哈希和顺序、回复目标，任何一样变了哈希就变", () => {
    const base = hash(post);
    const variants: DraftContent[] = [
      { ...post, text: "这周做了四件事" },
      { ...post, title: "月报" },
      { ...post, github: { repo: "baize/other", as: "issue" } },
      { ...post, github: { repo: "baize/demo", as: "discussion" } },
      { ...post, images: [B, A] },
      { ...post, images: [A] },
      { ...post, images: [A, { ...B, sha256: "c".repeat(64) }] },
    ];
    for (const variant of variants) expect(hash(variant), JSON.stringify(variant)).not.toBe(base);
    expect(hash(post, "x")).not.toBe(base);
    expect(hash(post, "github", OTHER)).not.toBe(base);
    expect(hash({ ...reply, replyTo: { ...reply.replyTo, url: "https://x.com/a/status/2" } }, "x")).not.toBe(
      hash(reply, "x"),
    );
  });

  it("图片的本地路径和回复目标的作者、引文不进哈希", () => {
    expect(hash({ ...post, images: [{ ...A, path: "/elsewhere/a.png" }, B] })).toBe(hash(post));
    expect(hash({ ...reply, replyTo: { ...reply.replyTo, author: "b", quote: "改过的引文" } }, "x")).toBe(
      hash(reply, "x"),
    );
  });

  it("字段拼接不会串位：标题的尾巴挪到正文开头，哈希不同", () => {
    expect(hash({ ...post, title: "周", text: "报这周做了三件事" })).not.toBe(hash(post));
  });
});
