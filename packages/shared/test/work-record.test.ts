import { describe, expect, it } from "vitest";
import {
  CHAIN_GENESIS,
  PRUNED_IMAGE_TEXT,
  RETAIN_TEXT_LIMIT_BYTES,
  SEARCH_TEXT_LIMIT,
  chainHead,
  isRetained,
  retainEntry,
  searchTextOf,
} from "../src/work-record.js";

const ctx = { localOnlyToolNames: new Set<string>() };
const localCtx = { localOnlyToolNames: new Set(["mail_read"]) };

const entry = (message: object, extra: object = {}) =>
  JSON.stringify({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-10-13T10:00:00.000Z",
    message,
    ...extra,
  });
const userText = (text: string) => entry({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const textOf = (line: string): string => JSON.parse(line).message.content[0].text;
const wellFormed = (s: string) => {
  encodeURIComponent(s);
};

describe("retainEntry 原样放行", () => {
  it("不用改的行返回同一个字符串，键序和空白一个字节都不动", () => {
    const line = ` {"timestamp":"2026-10-13T10:00:00.000Z",  "type":"message","id":"e1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"你好"}],"timestamp":1,"extra":{"b":1,"a":2}}}`;
    const out = retainEntry(line, ctx);
    expect(out.line === line).toBe(true);
    expect(out.retention).toBe("verbatim");
  });

  it.each([
    ["不是 JSON", "this is not json {"],
    ["空行", ""],
    ["JSON 数组", "[1,2,3]"],
    ["JSON 标量", "42"],
    ["null", "null"],
    ["没有 type", '{"id":"x"}'],
    ["Pi 以后加的条目类型", '{"type":"hologram","id":"x","payload":{"content":[{"type":"image","data":"AAAA"}]}}'],
    ["字符串 content 的 system 消息", entry({ role: "system", content: "x".repeat(20000), timestamp: 1 })],
  ])("%s 不抛、原样返回", (_name, line) => {
    const out = retainEntry(line, ctx);
    expect(out.line === line).toBe(true);
    expect(out.retention).toBe("verbatim");
  });

  it("恰好 16384 字节的文字块不动，多一个字节就动", () => {
    expect(RETAIN_TEXT_LIMIT_BYTES).toBe(16384);
    const exact = userText("a".repeat(16384));
    expect(retainEntry(exact, ctx).retention).toBe("verbatim");
    const over = userText("a".repeat(16385));
    expect(retainEntry(over, ctx).retention).toBe("redacted");
  });

  it("按 UTF-8 字节算，不按字符：5462 个汉字是 16386 字节", () => {
    expect(retainEntry(userText("中".repeat(5461)), ctx).retention).toBe("verbatim");
    expect(retainEntry(userText("中".repeat(5462)), ctx).retention).toBe("redacted");
  });
});

describe("retainEntry 图片", () => {
  it("图片块换成和运行时裁图同一个形状，其余字段原样保留", () => {
    expect(PRUNED_IMAGE_TEXT).toBe("（之前的截图已省略）");
    const line = entry({
      role: "toolResult",
      toolCallId: "c1",
      toolName: "screenshot",
      content: [
        { type: "text", text: "截好了", textSignature: "sig" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 5,
    });
    const out = retainEntry(line, ctx);
    expect(out.retention).toBe("redacted");
    expect(out.line).toBe(
      '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-10-13T10:00:00.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"screenshot","content":[{"type":"text","text":"截好了","textSignature":"sig"},{"type":"text","text":"（之前的截图已省略）"}],"isError":false,"timestamp":5}}',
    );
  });

  it("用户消息、custom_message、context_edit 里的图片同样换掉", () => {
    const img = { type: "image", data: "AAAA", mimeType: "image/png" };
    const lines = [
      entry({ role: "user", content: [img], timestamp: 1 }),
      JSON.stringify({ type: "custom_message", id: "e2", customType: "x", content: [img], display: true }),
      JSON.stringify({ type: "context_edit", id: "e3", targetId: "e1", replacement: { content: [img] } }),
    ];
    for (const line of lines) {
      const out = retainEntry(line, ctx);
      expect(out.retention).toBe("redacted");
      expect(out.line).not.toContain("AAAA");
      expect(out.line).toContain("（之前的截图已省略）");
    }
  });
});

describe("retainEntry 超长文字", () => {
  it("留头尾各 2048 字节，中间一行写省略字节数和整段 sha256", () => {
    const out = retainEntry(userText("a".repeat(20000)), ctx);
    expect(out.retention).toBe("redacted");
    expect(textOf(out.line)).toBe(
      `${"a".repeat(2048)}\n[中间省略 15904 字节，整段 sha256=cc17faaad36649c4603dda4d8ff97cb149722af0bcac0746305a2134ad2d0b97]\n${"a".repeat(2048)}`,
    );
  });

  it("中文：切点退到字符边界，头尾各 682 个字", () => {
    const out = retainEntry(userText("中".repeat(10000)), ctx);
    expect(textOf(out.line)).toBe(
      `${"中".repeat(682)}\n[中间省略 25908 字节，整段 sha256=7c55f7fad5aeeb32bb934cf47e6cc9f83ad5cd676f86f6288b70ab6514cb8760]\n${"中".repeat(682)}`,
    );
  });

  it("emoji：切点不落在代理对中间，头 511 个、尾 511 个加末尾的 b", () => {
    const out = retainEntry(userText(`a${"😀".repeat(5000)}b`), ctx);
    const text = textOf(out.line);
    wellFormed(text);
    expect(text).toBe(
      `a${"😀".repeat(511)}\n[中间省略 15912 字节，整段 sha256=f63c2e27e242e55aa07399de7a92cf29cc2988d720851f06cd53ea20ae08cecf]\n${"😀".repeat(511)}b`,
    );
  });

  it("工具结果、assistant 文字、字符串形式的用户消息、bashExecution 输出都按同一条规则", () => {
    const big = "x".repeat(17000);
    const lines = [
      entry({
        role: "toolResult",
        toolCallId: "c",
        toolName: "bash",
        content: [{ type: "text", text: big }],
        isError: false,
        timestamp: 1,
      }),
      entry({ role: "assistant", content: [{ type: "text", text: big }], timestamp: 1 }),
      entry({ role: "user", content: big, timestamp: 1 }),
      entry({
        role: "bashExecution",
        command: "ls",
        output: big,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      }),
    ];
    for (const line of lines) {
      const out = retainEntry(line, ctx);
      expect(out.retention).toBe("redacted");
      expect(Buffer.byteLength(out.line)).toBeLessThan(5000);
    }
  });

  it("思考块和工具调用参数不在文字块规则里，原样放行", () => {
    const line = entry({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(20000), thinkingSignature: "s" },
        { type: "toolCall", id: "c", name: "write", arguments: { content: "w".repeat(20000) } },
      ],
      timestamp: 1,
    });
    expect(retainEntry(line, ctx).line === line).toBe(true);
  });
});

describe("retainEntry 只在本机的工具", () => {
  const result = (toolName: string) =>
    entry({
      role: "toolResult",
      toolCallId: "c1",
      toolName,
      content: [{ type: "text", text: "密钥 sk-123" }],
      details: { raw: "密钥 sk-123" },
      isError: false,
      timestamp: 5,
    });

  it("结果只留工具名、时间、字节数和 sha256，原文和 details 一个字都不留", () => {
    const out = retainEntry(result("mail_read"), localCtx);
    expect(out.retention).toBe("redacted");
    expect(out.line).toBe(
      '{"type":"message","id":"e1","parentId":null,"timestamp":"2026-10-13T10:00:00.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"mail_read","content":[{"type":"text","text":"[本机工具结果，原文未上传 tool=mail_read time=2026-10-13T10:00:00.000Z bytes=40 sha256=adb0d9cc7f12db66acb7b189c66f1d4fbd6645d46691436a98dd5c11afeb4594]"}],"isError":false,"timestamp":5}}',
    );
  });

  it("不在名单里的工具照常放行", () => {
    const line = result("web_search");
    expect(retainEntry(line, localCtx).line === line).toBe(true);
  });

  it("名单为空时同名工具也放行", () => {
    const line = result("mail_read");
    expect(retainEntry(line, ctx).line === line).toBe(true);
  });

  it("工具调用参数留着：它是模型自己写的，群里的工具卡已经把它带给服务器", () => {
    const call = entry({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "mail_read", arguments: { folder: "inbox" } }],
      timestamp: 1,
    });
    expect(retainEntry(call, localCtx).line === call).toBe(true);
  });

  it("已经过滤过的行再过一遍不变", () => {
    const once = retainEntry(result("mail_read"), localCtx).line;
    const twice = retainEntry(once, localCtx);
    expect(twice.line === once).toBe(true);
    expect(twice.retention).toBe("verbatim");
  });
});

describe("isRetained", () => {
  const offenders: Array<[string, string]> = [
    [
      "含图片",
      entry({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 }),
    ],
    ["含超长文字", userText("a".repeat(16385))],
    [
      "本机工具结果带原文",
      entry({
        role: "toolResult",
        toolCallId: "c",
        toolName: "mail_read",
        content: [{ type: "text", text: "密钥" }],
        isError: false,
        timestamp: 1,
      }),
    ],
    [
      "本机工具结果伪造占位文字夹带原文",
      entry({
        role: "toolResult",
        toolCallId: "c",
        toolName: "mail_read",
        content: [{ type: "text", text: "[本机工具结果，原文未上传 tool=mail_read time=t bytes=1 sha256=00] 密钥" }],
        isError: false,
        timestamp: 1,
      }),
    ],
    [
      "本机工具结果占位文字正确但 details 带原文",
      entry({
        role: "toolResult",
        toolCallId: "c",
        toolName: "mail_read",
        content: [
          {
            type: "text",
            text: `[本机工具结果，原文未上传 tool=mail_read time=2026-10-13T10:00:00.000Z bytes=1 sha256=${"0".repeat(64)}]`,
          },
        ],
        details: { raw: "密钥" },
        isError: false,
        timestamp: 1,
      }),
    ],
  ];

  it.each(offenders)("%s 判不合规", (_name, line) => {
    expect(isRetained(line, localCtx)).toBe(false);
  });

  it.each([
    ["普通行", userText("你好")],
    ["非 JSON", "oops"],
    ["未知类型", '{"type":"hologram"}'],
    ["恰好 16384 字节", userText("a".repeat(16384))],
  ])("%s 合规", (_name, line) => {
    expect(isRetained(line, localCtx)).toBe(true);
  });

  it("对 retainEntry 的任意输出恒为 true，且再过滤不变（确定性随机样例）", () => {
    let seed = 20261014;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ["a", "中", "😀", "é", "\n", '"', "\\", "\u0000", " "];
    const text = (len: number) => Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join("");
    const lens = [0, 1, 100, 2048, 4096, 16383, 16384, 16385, 20000, 40000];
    const block = (): object => {
      const kind = rand(4);
      if (kind === 0) return { type: "image", data: text(rand(50)), mimeType: "image/png" };
      if (kind === 1) return { type: "thinking", thinking: text(rand(30000)) };
      return { type: "text", text: text(lens[rand(lens.length)] ?? 0) };
    };
    const tools = ["bash", "mail_read", "read"];
    let redacted = 0;
    for (let i = 0; i < 400; i += 1) {
      const content = Array.from({ length: 1 + rand(3) }, block);
      const role = ["user", "assistant", "toolResult"][rand(3)];
      const message =
        role === "toolResult"
          ? {
              role,
              toolCallId: "c",
              toolName: tools[rand(3)],
              content,
              details: { d: text(20) },
              isError: false,
              timestamp: i,
            }
          : { role, content, timestamp: i };
      const line = entry(message);
      const out = retainEntry(line, localCtx);
      if (out.retention === "redacted") redacted += 1;
      expect(isRetained(out.line, localCtx), `样例 ${i}`).toBe(true);
      const again = retainEntry(out.line, localCtx);
      expect(again.line === out.line, `样例 ${i} 幂等`).toBe(true);
      expect(again.retention).toBe("verbatim");
      wellFormed(out.line);
    }
    expect(redacted).toBeGreaterThan(100);
  });
});

describe("searchTextOf", () => {
  it("用户和助手的文字块、工具结果的文字按顺序用换行连起来，别的都不进", () => {
    const user = entry({
      role: "user",
      content: [
        { type: "text", text: "帮我查" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "天气" },
      ],
      timestamp: 1,
    });
    expect(searchTextOf(user)).toBe("帮我查\n天气");
    const assistant = entry({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先想想", thinkingSignature: "sig" },
        { type: "text", text: "好的", textSignature: "ts" },
        { type: "toolCall", id: "c", name: "weather", arguments: { city: "北京" } },
      ],
      model: "m",
      usage: { input: 1, output: 2 },
      timestamp: 1,
    });
    expect(searchTextOf(assistant)).toBe("好的");
    const toolResult = entry({
      role: "toolResult",
      toolCallId: "c",
      toolName: "weather",
      content: [{ type: "text", text: "晴，25 度" }],
      details: { secret: "不进" },
      isError: false,
      timestamp: 1,
    });
    expect(searchTextOf(toolResult)).toBe("晴，25 度");
  });

  it("字符串形式的用户消息也抽", () => {
    expect(searchTextOf(entry({ role: "user", content: "直接一句话", timestamp: 1 }))).toBe("直接一句话");
  });

  it.each([
    ["system 消息", entry({ role: "system", content: "你是助手", timestamp: 1 })],
    ["非消息条目", JSON.stringify({ type: "model_change", id: "m", provider: "p", modelId: "x" })],
    [
      "compaction",
      JSON.stringify({ type: "compaction", id: "c", summary: "摘要", firstKeptEntryId: "e1", tokensBefore: 1 }),
    ],
    ["非 JSON", "oops"],
    ["空行", ""],
  ])("%s 抽出空串", (_name, line) => {
    expect(searchTextOf(line)).toBe("");
  });

  it("长度上限 8192 个 UTF-16 单元，不切断代理对", () => {
    expect(SEARCH_TEXT_LIMIT).toBe(8192);
    expect(searchTextOf(userText("a".repeat(8192)))).toBe("a".repeat(8192));
    expect(searchTextOf(userText("a".repeat(8193)))).toBe("a".repeat(8192));
    const cut = searchTextOf(userText(`a${"😀".repeat(5000)}`));
    wellFormed(cut);
    expect(cut).toBe(`a${"😀".repeat(4095)}`);
  });

  it("过滤后的长文字抽到的是头尾加省略行", () => {
    const out = retainEntry(userText("a".repeat(20000)), ctx);
    expect(searchTextOf(out.line)).toBe(textOf(out.line));
  });
});

describe("chainHead", () => {
  it("初始头是 64 个 0", () => {
    expect(CHAIN_GENESIS).toBe("0".repeat(64));
  });

  it("三行固定输入滚出字面量期望值（外部 sha256 算得）", () => {
    const lines = ['{"type":"message","id":"a1"}', '{"type":"message","id":"a2"}', '{"type":"custom","id":"a3"}'];
    const heads: string[] = [];
    let head = CHAIN_GENESIS;
    for (const line of lines) {
      head = chainHead(head, line);
      heads.push(head);
    }
    expect(heads).toEqual([
      "baae23408c37b08b41872e1ccc364eb840eeb818f696ab8cf82600a2aea88c3d",
      "6b395f68df9226621ec7c86191f45e6c7d25157bce426f07d689dcc0ad3a3bb1",
      "79c0e041bf3ef9a698ca2e9547a1c89bade7b46338af3187418a2d9f86b93714",
    ]);
  });

  it("顺序和内容都进头：换序、改一个字节结果都不同", () => {
    const a = chainHead(chainHead(CHAIN_GENESIS, "x"), "y");
    expect(chainHead(chainHead(CHAIN_GENESIS, "y"), "x")).not.toBe(a);
    expect(chainHead(chainHead(CHAIN_GENESIS, "x"), "y ")).not.toBe(a);
  });

  it("空行也能滚，按 UTF-8 字节算", () => {
    expect(chainHead(CHAIN_GENESIS, "")).toBe("a52a21f725cb0dd2daf7c11bd583b94248c564712c1daa5b86d30cb17847aa11");
  });
});
