import { describe, expect, it } from "vitest";
import type { BotTemplate } from "@baize/shared";
import { shareLinkOf, shareSummary, templateFromLink } from "./shareLink.js";

const template: BotTemplate = {
  format: 1,
  name: "小服",
  tags: ["客服"],
  description: "接工单，退款先问我",
  skills: [{ name: "回工单", steps: ["先称呼名字", "再给结论"] }],
  plugins: [
    { name: "工单系统", url: "https://tickets.example/mcp", operations: [{ name: "lookup", needsApproval: false }] },
  ],
  preferences: [{ text: "交期只说确定的日子" }],
};

describe("分享链接", () => {
  it("整包放在 # 后面，只用 base64url 字符，中文来回不丢", () => {
    const link = shareLinkOf(template, "https://app.example");
    expect(link.startsWith("https://app.example/share#")).toBe(true);
    expect(link.split("#")[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(templateFromLink(link)).toEqual({ kind: "template", template });
  });

  it("只粘了 # 后面那段、前后带空白也认", () => {
    const payload = shareLinkOf(template, "https://app.example").split("#")[1] ?? "";
    expect(templateFromLink(`  ${payload}\n`)).toEqual({ kind: "template", template });
  });

  it("不是分享包的一律认不出", () => {
    expect(templateFromLink("这不是链接")).toEqual({ kind: "unrecognized" });
    expect(templateFromLink("https://app.example/share#")).toEqual({ kind: "unrecognized" });
    const extra = shareLinkOf({ ...template, token: "x" } as BotTemplate, "https://app.example");
    expect(templateFromLink(extra), "多出字段整包拒收").toEqual({ kind: "unrecognized" });
  });

  it("131072 字符以内照常认，多一个字符就算太长", () => {
    const limit = 131072;
    const linkWith = (pad: number) =>
      shareLinkOf(
        { ...template, plugins: [{ name: "插件", url: `https://example.invalid/${"a".repeat(pad)}`, operations: [] }] },
        "https://app.example",
      );
    let pad = Math.floor(((limit - linkWith(0).length) * 3) / 4) - 8;
    while (linkWith(pad + 1).length <= limit) pad += 1;
    const atLimit = linkWith(pad);
    expect(atLimit.length, "正好卡在上限上").toBe(limit);
    expect(templateFromLink(atLimit).kind, `${atLimit.length} 字符还认`).toBe("template");
    expect(templateFromLink(`${atLimit}a`), "多一个字符就不解码").toEqual({ kind: "too_long" });
    expect(templateFromLink(`  ${atLimit}\n`).kind, "前后空白不算长度").toBe("template");
  });
});

describe("分享那段话", () => {
  const base = { botName: "小服", hasTags: true, skills: 3, plugins: 2, preferences: 4, keptPrivate: 1 };

  it("默认带什么都写进去，不带的四样固定写明", () => {
    expect(shareSummary(base)).toBe(
      "对方拿到一个新的小服，带着名字、标签、描述、3 个技能、2 个插件的配置、4 条偏好。有 1 条只和你的号有关，自动留下。你的登录、对话、文件和项目不带。导入后两边各走各的，你以后改不会同步过去。",
    );
  });

  it("不带的类别和零条都不提", () => {
    expect(shareSummary({ ...base, hasTags: false, skills: 0, plugins: 0, preferences: 0, keptPrivate: 0 })).toBe(
      "对方拿到一个新的小服，带着名字、描述。你的登录、对话、文件和项目不带。导入后两边各走各的，你以后改不会同步过去。",
    );
  });
});
