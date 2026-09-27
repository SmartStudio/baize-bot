import { describe, expect, it } from "vitest";
import { oauthNoticeText, oauthReturnOf } from "./oauth.js";

const read = (search: string) => oauthReturnOf(new URLSearchParams(search));

describe("授权回跳的查询串", () => {
  it("认得控制面回跳带的平台和结果", () => {
    expect(read("?oauth=github&result=connected")).toEqual({ platform: "github", result: "connected" });
    expect(read("?oauth=x&result=invalid_state")).toEqual({ platform: "x", result: "invalid_state" });
  });

  it("平台或结果认不出、缺一个，都当没带", () => {
    expect(read("")).toBeNull();
    expect(read("?oauth=xiaohongshu&result=connected"), "小红书不走授权登录").toBeNull();
    expect(read("?oauth=github&result=ok")).toBeNull();
    expect(read("?oauth=github")).toBeNull();
  });

  it("四种结果各有一句中文提示，带上平台名", () => {
    const texts = (["connected", "denied", "invalid_state", "failed"] as const).map((result) =>
      oauthNoticeText({ platform: "x", result }),
    );
    expect(texts).toEqual([
      "X 账号接好了",
      "你在 X 那边没有同意授权，账号没接上",
      "这次 X 授权过期了或不是从这里发起的，再点一次接入",
      "X 授权没成，账号没接上，稍后再试一次",
    ]);
  });
});
