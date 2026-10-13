import { describe, expect, it } from "vitest";
import {
  CHAIN_GENESIS,
  PRUNED_IMAGE_TEXT,
  RETAIN_TEXT_LIMIT_BYTES,
  SEARCH_TEXT_LIMIT,
  chainHead,
  createRetainer,
  searchTextOf,
  type RetainContext,
} from "../src/work-record.js";

const ctx = { localOnlyToolNames: new Set<string>() };
const localCtx = { localOnlyToolNames: new Set(["mail_read"]) };

const retainEntry = (line: string, c: RetainContext) => createRetainer(c).retain(line);
const isRetained = (line: string, c: RetainContext) => createRetainer(c).check(line);

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
    const retainer = createRetainer(ctx);
    expect(retainer.retain(userText("先有目标条目")).retention).toBe("verbatim");
    const lines = [
      entry({ role: "user", content: [img], timestamp: 1 }),
      JSON.stringify({ type: "custom_message", id: "e2", customType: "x", content: [img], display: true }),
      JSON.stringify({ type: "context_edit", id: "e3", targetId: "e1", replacement: { content: [img] } }),
    ];
    for (const line of lines) {
      const out = retainer.retain(line);
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

const SECRET = "SYNTHETIC_PRIVATE_RESULT_123";
const ISO = "2026-10-13T10:00:00.000Z";
const SECRET_SHA = "477423f9f82a9b652acfa974889414f5023914e0d9b4ba8aa813fb69d5605055";
const secretResult = (extra: object = {}, entryExtra: object = {}, timestamp: unknown = ISO) =>
  JSON.stringify({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "mail_read",
      content: [{ type: "text", text: SECRET }],
      isError: false,
      timestamp: 1,
      ...extra,
    },
    ...entryExtra,
  });
const localPlaceholder = (time: string) =>
  `{"type":"message","id":"e1","parentId":null,"timestamp":${JSON.stringify(ISO)},"message":{"role":"toolResult","toolCallId":"c1","toolName":"mail_read","content":[{"type":"text","text":"[本机工具结果，原文未上传 tool=mail_read time=${time} bytes=55 sha256=${SECRET_SHA}]"}],"isError":false,"timestamp":1}}`;

describe("第二轮：没被过滤动到的数字原文保值", () => {
  it("超精度整数、超精度小数、1e400、1.0、-0 过滤后仍是输入里的原文", () => {
    const line =
      '{"type":"message","n":9007199254740993,"decimal":0.123456789012345678901,"huge":1e400,"one":1.0,"neg":-0,"plain":42,"nested":{"list":[1e3,2.50,7]},"message":{"role":"user","content":[{"type":"image","data":"AAAA"}]}}';
    const out = retainEntry(line, ctx);
    expect(out.retention).toBe("redacted");
    expect(out.line).toBe(
      '{"type":"message","n":9007199254740993,"decimal":0.123456789012345678901,"huge":1e400,"one":1.0,"neg":-0,"plain":42,"nested":{"list":[1e3,2.50,7]},"message":{"role":"user","content":[{"type":"text","text":"（之前的截图已省略）"}]}}',
    );
  });

  it("超长文字过滤时，工具调用参数里的超精度数字也原样", () => {
    const line =
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"w","arguments":{"n":9007199254740993}},{"type":"text","text":"' +
      "a".repeat(20000) +
      '"}]}}';
    const out = retainEntry(line, ctx);
    expect(out.retention).toBe("redacted");
    expect(out.line).toContain('"arguments":{"n":9007199254740993}');
  });

  it("本机工具结果的 timestamp 是超精度数字时保留原文", () => {
    const line = secretResult({ timestamp: 1 }).replace('"timestamp":1}}', '"timestamp":9007199254740993}}');
    const out = retainEntry(line, localCtx);
    expect(out.line).toContain('"timestamp":9007199254740993}}');
    expect(isRetained(out.line, localCtx)).toBe(true);
  });
});

describe("第二轮：本机工具结果按白名单只留元字段", () => {
  it.each(["rawResult", "output", "error", "extra", "usage", "details", "nestedCalls"])(
    "消息里多出 %s：整个字段丢掉，输出等于标准占位行",
    (key) => {
      const line = secretResult({ [key]: { nested: { content: [{ type: "text", text: SECRET }] } } });
      const out = retainEntry(line, localCtx);
      expect(out.retention).toBe("redacted");
      expect(out.line).toBe(localPlaceholder(ISO));
      expect(isRetained(line, localCtx)).toBe(false);
      expect(isRetained(out.line, localCtx)).toBe(true);
    },
  );

  it.each(["rawResult", "output", "error", "extra"])("条目一层多出 %s 同样丢掉", (key) => {
    const out = retainEntry(secretResult({}, { [key]: SECRET }), localCtx);
    expect(out.line).toBe(localPlaceholder(ISO));
  });

  it("已经是标准占位的行再塞一个 rawResult 不算已过滤，会被剥掉", () => {
    const forged = JSON.stringify({ ...JSON.parse(localPlaceholder(ISO)), rawResult: SECRET });
    expect(isRetained(forged, localCtx)).toBe(false);
    const forgedInMessage = JSON.parse(localPlaceholder(ISO));
    forgedInMessage.message.rawResult = SECRET;
    const line = JSON.stringify(forgedInMessage);
    expect(isRetained(line, localCtx)).toBe(false);
    expect(retainEntry(line, localCtx).line).toBe(localPlaceholder(ISO));
  });

  it("类型不对的元字段也丢掉：toolCallId 是对象、isError 是字符串", () => {
    const line = secretResult({ toolCallId: { x: SECRET }, isError: SECRET });
    expect(retainEntry(line, localCtx).line).toBe(
      `{"type":"message","id":"e1","parentId":null,"timestamp":"${ISO}","message":{"role":"toolResult","toolName":"mail_read","content":[{"type":"text","text":"[本机工具结果，原文未上传 tool=mail_read time=${ISO} bytes=55 sha256=${SECRET_SHA}]"}],"timestamp":1}}`,
    );
  });

  it("没有 content 字段的本机结果也补上占位，字节数按 null 算", () => {
    const line = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: ISO,
      message: { role: "toolResult", toolName: "mail_read", output: SECRET },
    });
    const out = retainEntry(line, localCtx);
    expect(out.line).toBe(
      `{"type":"message","id":"e1","parentId":null,"timestamp":"${ISO}","message":{"role":"toolResult","toolName":"mail_read","content":[{"type":"text","text":"[本机工具结果，原文未上传 tool=mail_read time=${ISO} bytes=4 sha256=74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b]"}]}}`,
    );
  });
});

describe("第二轮：占位里的时间由条目 timestamp 唯一决定", () => {
  it.each([
    ["空格分隔", "2026-10-14 00:00:00"],
    ["斜杠", "2026/10/14"],
    ["空串", ""],
    ["中文", "中文时间"],
    ["下划线时区", "2026-10-14T00:00:00_UTC"],
    ["带换行", "bad\ntime"],
    ["等号和空格", "x bytes=1 sha256=00"],
    ["不是字符串", 1760000000000],
  ])("条目 timestamp %s：写 unknown，输出过复查且再过滤不变", (_name, timestamp) => {
    const out = retainEntry(secretResult({}, {}, timestamp), localCtx);
    expect(out.line).toContain(`tool=mail_read time=unknown bytes=55 sha256=${SECRET_SHA}]`);
    expect(out.line).not.toContain(SECRET);
    expect(isRetained(out.line, localCtx)).toBe(true);
    const again = retainEntry(out.line, localCtx);
    expect(again.line === out.line).toBe(true);
    expect(again.retention).toBe("verbatim");
  });

  it("带时区偏移和纳秒的合法 ISO 原样写进占位", () => {
    const out = retainEntry(secretResult({}, {}, "2026-10-14T08:00:00.123456789+08:00"), localCtx);
    expect(out.line).toContain("time=2026-10-14T08:00:00.123456789+08:00 bytes=55");
    expect(isRetained(out.line, localCtx)).toBe(true);
  });

  it("占位里的 time 和条目 timestamp 对不上就不算已过滤（time=sk-secret123）", () => {
    const forged = JSON.parse(localPlaceholder(ISO));
    forged.message.content[0].text = `[本机工具结果，原文未上传 tool=mail_read time=sk-secret123 bytes=1 sha256=${"0".repeat(64)}]`;
    const line = JSON.stringify(forged);
    expect(isRetained(line, localCtx)).toBe(false);
    const out = retainEntry(line, localCtx);
    expect(out.line).not.toContain("sk-secret123");
    expect(isRetained(out.line, localCtx)).toBe(true);
  });

  it("条目 timestamp 不是 ISO 时，占位写 unknown 才算已过滤；写别的都不算", () => {
    const base = JSON.parse(localPlaceholder(ISO));
    base.timestamp = "not a time";
    base.message.content[0].text = base.message.content[0].text.replace(`time=${ISO}`, "time=unknown");
    expect(isRetained(JSON.stringify(base), localCtx)).toBe(true);
    base.message.content[0].text = base.message.content[0].text.replace("time=unknown", "time=not a time");
    expect(isRetained(JSON.stringify(base), localCtx)).toBe(false);
  });
});

describe("第二轮：context_edit 不能把本机工具结果的原文带回去", () => {
  const edit = (id: string, targetId: unknown, content: unknown) =>
    JSON.stringify({ type: "context_edit", id, parentId: "e1", timestamp: ISO, targetId, replacement: { content } });
  const secretContent = [{ type: "text", text: SECRET }];
  const editPlaceholder = (id: string, targetId: string) =>
    `{"type":"context_edit","id":"${id}","parentId":"e1","timestamp":"${ISO}","targetId":"${targetId}","replacement":{"content":[{"type":"text","text":"[上下文编辑，原文未上传 bytes=55 sha256=${SECRET_SHA}]"}]}}`;

  it("指向本机工具结果的编辑，replacement 换成占位（字面量）", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(secretResult());
    const out = retainer.retain(edit("e2", "e1", secretContent));
    expect(out.retention).toBe("redacted");
    expect(out.line).toBe(editPlaceholder("e2", "e1"));
  });

  it("复查：同一条流里的原文编辑判不合规，过滤后的编辑合规", () => {
    const filtered = createRetainer(localCtx);
    const l1 = filtered.retain(secretResult()).line;
    const l2 = filtered.retain(edit("e2", "e1", secretContent)).line;
    const server = createRetainer(localCtx);
    expect(server.check(l1)).toBe(true);
    expect(server.check(l2)).toBe(true);
    const bad = createRetainer(localCtx);
    expect(bad.check(l1)).toBe(true);
    expect(bad.check(edit("e2", "e1", secretContent))).toBe(false);
  });

  it("编辑指向还没见过的条目（前向引用）同样按本机处理", () => {
    const retainer = createRetainer(localCtx);
    const out = retainer.retain(edit("e2", "e9", secretContent));
    expect(out.line).toBe(editPlaceholder("e2", "e9"));
    expect(retainer.check(out.line)).toBe(true);
  });

  it("targetId 不是字符串也按本机处理", () => {
    const out = retainEntry(edit("e2", { x: 1 }, secretContent), localCtx);
    expect(out.line).not.toContain(SECRET);
  });

  it("指向普通条目的编辑照常：内容原样，图片和超长文字照常过滤", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(userText("目标"));
    const plain = edit("e2", "e1", [{ type: "text", text: "改过的话" }]);
    expect(retainer.retain(plain).line === plain).toBe(true);
    const big = edit("e3", "e1", [{ type: "text", text: "a".repeat(20000) }]);
    expect(retainer.retain(big).retention).toBe("redacted");
  });

  it("replacement 为 null（从上下文里去掉目标）原样放行，本机目标也一样", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(secretResult());
    const line = JSON.stringify({ type: "context_edit", id: "e2", parentId: "e1", targetId: "e1", replacement: null });
    expect(retainer.retain(line)).toEqual({ line, retention: "verbatim" });
  });

  it("编辑的 replacement 里多出别的键，对本机目标只留占位", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(secretResult());
    const line = JSON.stringify({
      type: "context_edit",
      id: "e2",
      parentId: "e1",
      timestamp: ISO,
      targetId: "e1",
      replacement: { content: secretContent, extra: SECRET },
    });
    expect(retainer.retain(line).line).toBe(editPlaceholder("e2", "e1"));
  });

  it("字符串形式的 replacement.content 对本机目标同样换占位", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(secretResult());
    const out = retainer.retain(edit("e2", "e1", SECRET));
    expect(out.line).not.toContain(SECRET);
    expect(retainer.check(out.line)).toBe(true);
  });

  it("snapshot 带到下一帧：新 Retainer 照样认得本机条目", () => {
    const first = createRetainer(localCtx);
    first.retain(secretResult());
    first.retain(userText("别的"));
    const snapshot = first.snapshot();
    expect(snapshot).toEqual({ knownIds: ["e1"], localIds: ["e1"] });
    const second = createRetainer(localCtx, snapshot);
    expect(second.retain(edit("e2", "e1", secretContent)).line).toBe(editPlaceholder("e2", "e1"));
    expect(createRetainer(localCtx).retain(edit("e2", "e1", secretContent)).line).toBe(editPlaceholder("e2", "e1"));
  });

  it("名单里没有 mail_read 时，同样的编辑是普通编辑", () => {
    const retainer = createRetainer(ctx);
    retainer.retain(secretResult());
    const line = edit("e2", "e1", secretContent);
    expect(retainer.retain(line).line === line).toBe(true);
  });
});

describe("第二轮：随机流的性质", () => {
  const MARK = "RANDOM_PRIVATE_MARK";
  const names = ["mail_read", "tool with spaces", "tool[time=]", "web_search"];
  const randomCtx: RetainContext = { localOnlyToolNames: new Set(names.slice(0, 3)) };
  const times: unknown[] = [
    ISO,
    "2026-10-14T08:00:00+08:00",
    "2026-10-14 00:00:00",
    "2026/10/14",
    "",
    "中文时间",
    "time=sk-secret",
    "bad\ntime",
    "2026-10-14T00:00:00_UTC",
    1760000000000,
    null,
  ];

  it("2000 条随机流：过滤输出逐行过复查、再过滤不变、本机原文一个字不剩", () => {
    let seed = 0x12a2026;
    const rand = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const pick = <T>(list: readonly T[]): T => list[rand(list.length)] as T;
    const numbers = ["9007199254740993", "0.123456789012345678901", "1e400", "1.0", "-0", "7"];
    const extraKeys = ["rawResult", "output", "error", "extra", "details", "nestedCalls", "usage"];
    let redacted = 0;
    let editsToGuarded = 0;
    for (let stream = 0; stream < 200; stream += 1) {
      const ids: Array<{ id: string; local: boolean }> = [];
      const lines: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `s${stream}-${i}`;
        const time = pick(times);
        const shape = rand(4);
        if (shape === 0 || shape === 1) {
          const local = shape === 0;
          const name = local ? pick(names.slice(0, 3)) : pick(["web_search", "bash"]);
          const extra: Record<string, unknown> = {};
          for (let k = local ? rand(3) : 0; k > 0; k -= 1)
            extra[pick(extraKeys)] = { content: [{ type: "text", text: MARK }] };
          const text = local ? MARK : "普通结果";
          const body =
            `{"type":"message","id":${JSON.stringify(id)},"parentId":null,"timestamp":${JSON.stringify(time)},` +
            (rand(2) === 0 && local ? `"rawResult":${JSON.stringify(MARK)},` : "") +
            `"n":${pick(numbers)},"message":${JSON.stringify({
              role: "toolResult",
              toolCallId: "c",
              toolName: name,
              content: [rand(3) === 0 ? { type: "image", data: "IMG" } : { type: "text", text }],
              isError: false,
              timestamp: i,
              ...extra,
            })}}`;
          lines.push(body);
          ids.push({ id, local });
        } else if (shape === 2) {
          lines.push(
            entry({ role: pick(["user", "assistant"]), content: [{ type: "text", text: "你好" }], timestamp: i }),
          );
          ids.push({ id: "e1", local: false });
        } else {
          const target = ids.length > 0 && rand(4) > 0 ? pick(ids) : { id: `ghost-${i}`, local: true };
          const guarded = target.local;
          editsToGuarded += Number(guarded);
          lines.push(
            JSON.stringify({
              type: "context_edit",
              id,
              parentId: null,
              timestamp: pick(times),
              targetId: target.id,
              replacement: { content: [{ type: "text", text: guarded ? MARK : "改写" }] },
            }),
          );
        }
      }
      const filter = createRetainer(randomCtx);
      const out = lines.map((line) => filter.retain(line));
      redacted += out.filter((o) => o.retention === "redacted").length;
      const server = createRetainer(randomCtx);
      const again = createRetainer(randomCtx);
      out.forEach((o, i) => {
        wellFormed(o.line);
        expect(server.check(o.line), `流 ${stream} 行 ${i} 复查`).toBe(true);
        expect(again.retain(o.line), `流 ${stream} 行 ${i} 幂等`).toEqual({ line: o.line, retention: "verbatim" });
        expect(o.line, `流 ${stream} 行 ${i} 原文`).not.toContain(MARK);
      });
    }
    expect(redacted).toBeGreaterThan(500);
    expect(editsToGuarded).toBeGreaterThan(100);
  });
});
