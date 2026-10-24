import { describe, expect, it } from "vitest";
import {
  PRUNED_IMAGE_TEXT,
  RetainSnapshot,
  assertRawJsonSupport,
  checkFrame,
  createRetainer,
  emptySnapshot,
  toolListFingerprint,
  type FrameCheck,
  type RetainContext,
  type RetainResult,
} from "../src/work-record.js";
import { RETAIN_TEXT_LIMIT_BYTES } from "../src/retention.js";

const ctx = { localOnlyToolNames: new Set<string>() };
const localCtx = { localOnlyToolNames: new Set(["mail_read"]) };

const retained = (result: RetainResult) => {
  if (result.status !== "retained") throw new Error(`被拒收：${result.reason}`);
  return { line: result.line, retention: result.retention };
};
/** 运行器侧的一条流：拒收就让用例失败。 */
const session = (c: RetainContext, resume?: RetainSnapshot) => {
  const retainer = createRetainer(c, resume);
  return { retain: (line: string) => retained(retainer.retain(line)), snapshot: () => retainer.snapshot() };
};
/** 服务器侧的一条流：每帧都从已提交 snapshot 复查，成功才提交，和 P3-10 的事务边界同构。 */
const server = (c: RetainContext, resume?: RetainSnapshot) => {
  let committed = resume ?? emptySnapshot(c);
  return {
    frame(lines: readonly string[]): FrameCheck {
      const result = checkFrame(c, committed, lines);
      if (result.ok) committed = result.snapshot;
      return result;
    },
    check(line: string): boolean {
      return this.frame([line]).ok;
    },
    committed: () => committed,
  };
};
const retainEntry = (line: string, c: RetainContext) => retained(createRetainer(c).retain(line));
const isRetained = (line: string, c: RetainContext) => checkFrame(c, emptySnapshot(c), [line]).ok;

const entry = (message: object, extra: object = {}) =>
  JSON.stringify({
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-10-13T10:00:00.000Z",
    message,
    ...extra,
  });
const userText = (text: string, id = "e1") =>
  entry({ role: "user", content: [{ type: "text", text }], timestamp: 1 }, { id });
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
    const retainer = session(ctx);
    expect(retainer.retain(userText("先有目标条目")).retention).toBe("verbatim");
    const lines = [
      entry({ role: "user", content: [img], timestamp: 1 }, { id: "e5" }),
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
    const retainer = session(localCtx);
    retainer.retain(secretResult());
    const out = retainer.retain(edit("e2", "e1", secretContent));
    expect(out.retention).toBe("redacted");
    expect(out.line).toBe(editPlaceholder("e2", "e1"));
  });

  it("复查：同一条流里的原文编辑判不合规，过滤后的编辑合规", () => {
    const filtered = session(localCtx);
    const l1 = filtered.retain(secretResult()).line;
    const l2 = filtered.retain(edit("e2", "e1", secretContent)).line;
    const good = server(localCtx);
    expect(good.check(l1)).toBe(true);
    expect(good.check(l2)).toBe(true);
    const bad = server(localCtx);
    expect(bad.check(l1)).toBe(true);
    expect(bad.check(edit("e2", "e1", secretContent))).toBe(false);
  });

  it("编辑指向还没见过的条目（前向引用）同样按本机处理", () => {
    const retainer = session(localCtx);
    const out = retainer.retain(edit("e2", "e9", secretContent));
    expect(out.line).toBe(editPlaceholder("e2", "e9"));
    expect(server(localCtx).check(out.line)).toBe(true);
  });

  it("指向普通条目的编辑照常：内容原样，图片和超长文字照常过滤", () => {
    const retainer = session(localCtx);
    retainer.retain(userText("目标"));
    const plain = edit("e2", "e1", [{ type: "text", text: "改过的话" }]);
    expect(retainer.retain(plain).line === plain).toBe(true);
    const big = edit("e3", "e1", [{ type: "text", text: "a".repeat(20000) }]);
    expect(retainer.retain(big).retention).toBe("redacted");
  });

  it("replacement 为 null（从上下文里去掉目标）原样放行，本机目标也一样", () => {
    const retainer = session(localCtx);
    retainer.retain(secretResult());
    const line = JSON.stringify({ type: "context_edit", id: "e2", parentId: "e1", targetId: "e1", replacement: null });
    expect(retainer.retain(line)).toEqual({ line, retention: "verbatim" });
  });

  it("编辑的 replacement 里多出别的键，对本机目标只留占位", () => {
    const retainer = session(localCtx);
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
    const retainer = session(localCtx);
    retainer.retain(secretResult());
    const out = retainer.retain(edit("e2", "e1", SECRET));
    expect(out.line).not.toContain(SECRET);
    const checker = server(localCtx);
    expect(checker.check(retainEntry(secretResult(), localCtx).line)).toBe(true);
    expect(checker.check(out.line)).toBe(true);
  });

  it("snapshot 带到下一帧：新 Retainer 照样认得本机条目", () => {
    const first = session(localCtx);
    first.retain(secretResult());
    first.retain(userText("别的", "e7"));
    const snapshot = first.snapshot();
    expect(snapshot).toEqual({
      version: 1,
      toolFingerprint: toolListFingerprint(localCtx.localOnlyToolNames),
      knownIds: ["e1", "e7"],
      localIds: ["e1"],
    });
    const second = session(localCtx, snapshot);
    expect(second.retain(edit("e2", "e1", secretContent)).line).toBe(editPlaceholder("e2", "e1"));
    expect(session(localCtx).retain(edit("e2", "e1", secretContent)).line).toBe(editPlaceholder("e2", "e1"));
  });

  it("名单里没有 mail_read 时，同样的编辑是普通编辑", () => {
    const retainer = session(ctx);
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
            entry(
              { role: pick(["user", "assistant"]), content: [{ type: "text", text: "你好" }], timestamp: i },
              { id },
            ),
          );
          ids.push({ id, local: false });
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
      const filter = session(randomCtx);
      const out = lines.map((line) => filter.retain(line));
      redacted += out.filter((o) => o.retention === "redacted").length;
      const checker = server(randomCtx);
      const again = session(randomCtx);
      out.forEach((o, i) => {
        wellFormed(o.line);
        expect(checker.check(o.line), `流 ${stream} 行 ${i} 复查`).toBe(true);
        expect(again.retain(o.line), `流 ${stream} 行 ${i} 幂等`).toEqual({ line: o.line, retention: "verbatim" });
        expect(o.line, `流 ${stream} 行 ${i} 原文`).not.toContain(MARK);
      });
    }
    expect(redacted).toBeGreaterThan(500);
    expect(editsToGuarded).toBeGreaterThan(100);
  });
});

const frozen = (snapshot: RetainSnapshot): RetainSnapshot => {
  Object.freeze(snapshot.knownIds);
  Object.freeze(snapshot.localIds);
  return Object.freeze(snapshot);
};
const plainUser = (id: string, parentId: string | null = null, text = "你好") =>
  entry({ role: "user", content: [{ type: "text", text }], timestamp: 1 }, { id, parentId });
const plainEdit = (id: string, targetId: string, content: unknown, parentId: string | null = null) =>
  JSON.stringify({ type: "context_edit", id, parentId, timestamp: ISO, targetId, replacement: { content } });
const filteredLocal = (id: string, parentId: string | null = null) =>
  retainEntry(secretResult({}, { id, parentId }), localCtx).line;

describe("第三轮 R2-1：同一条流里 id 只能定义一次", () => {
  const imageUser = (id: string) =>
    entry({ role: "user", content: [{ type: "image", data: "IMG", mimeType: "image/png" }], timestamp: 1 }, { id });

  it("复核报告的四行反例，帧内：第三行重定义 x，整帧拒收并指出行号", () => {
    const lines = [
      plainUser("x"),
      plainEdit("e", "x", [{ type: "text", text: SECRET }], "x"),
      filteredLocal("x"),
      plainUser("leaf", "e"),
    ];
    expect(checkFrame(localCtx, emptySnapshot(localCtx), lines)).toEqual({
      ok: false,
      reason: "duplicate_id",
      lineIndex: 2,
    });
  });

  it("跨帧：第一帧提交后，第二帧里的重定义被拒，已提交快照不变", () => {
    const checker = server(localCtx);
    expect(checker.frame([plainUser("x")]).ok).toBe(true);
    const before = JSON.stringify(checker.committed());
    expect(checker.frame([plainEdit("e", "x", [{ type: "text", text: "公开" }], "x"), filteredLocal("x")])).toEqual({
      ok: false,
      reason: "duplicate_id",
      lineIndex: 1,
    });
    expect(JSON.stringify(checker.committed())).toBe(before);
  });

  it("运行器侧：重定义的 id 拒收，这条和它之后的内容都不再产出，已接受的状态不受影响", () => {
    const retainer = createRetainer(localCtx);
    expect(retainer.retain(plainUser("x"))).toEqual({
      status: "retained",
      line: plainUser("x"),
      retention: "verbatim",
    });
    expect(retainer.retain(filteredLocal("x"))).toEqual({ status: "rejected", reason: "duplicate_id" });
    expect(retainer.retain(plainUser("fresh"))).toEqual({ status: "rejected", reason: "duplicate_id" });
    expect(retainer.snapshot().knownIds).toEqual(["x"]);
    expect(retainer.snapshot().localIds).toEqual([]);
  });

  it("不认识的条目类型、非消息条目重复 id 也算重复（Pi 的索引对所有条目一视同仁）", () => {
    const model = JSON.stringify({ type: "model_change", id: "m1", provider: "p", modelId: "q" });
    expect(checkFrame(ctx, emptySnapshot(ctx), [model, model])).toEqual({
      ok: false,
      reason: "duplicate_id",
      lineIndex: 1,
    });
  });

  it("没有 id 的行、非 JSON 的行不占 id，可以重复出现", () => {
    const noId = JSON.stringify({ type: "hologram" });
    expect(checkFrame(ctx, emptySnapshot(ctx), [noId, noId, "oops", "oops"]).ok).toBe(true);
  });

  it("重复检查先于过滤：带图片的重复行报 duplicate_id，不是 unfiltered", () => {
    expect(checkFrame(ctx, emptySnapshot(ctx), [plainUser("x"), imageUser("x")])).toMatchObject({
      reason: "duplicate_id",
      lineIndex: 1,
    });
  });
});

describe("第三轮 R2-2：服务器复查是纯函数，拒收的帧不产生状态", () => {
  const imageUser = entry({ role: "user", content: [{ type: "image", data: "IMG" }], timestamp: 1 }, { id: "x" });

  it("复核报告的四步反例：被拒的帧不留痕，用已提交快照时后一帧的编辑行被拒", () => {
    const committed = frozen(emptySnapshot(localCtx));
    const rejected = checkFrame(localCtx, committed, [imageUser]);
    expect(rejected).toEqual({ ok: false, reason: "unfiltered", lineIndex: 0 });
    expect("snapshot" in rejected).toBe(false);
    expect(committed).toEqual({
      version: 1,
      toolFingerprint: toolListFingerprint(localCtx.localOnlyToolNames),
      knownIds: [],
      localIds: [],
    });
    const suffix = [plainEdit("e", "x", [{ type: "text", text: SECRET }]), filteredLocal("x", "e")];
    expect(checkFrame(localCtx, committed, suffix)).toEqual({ ok: false, reason: "unfiltered", lineIndex: 0 });
  });

  it("帧里前面的行合规、后面的行不合规：整帧失败，同一份已提交快照还能接着收修正后的帧", () => {
    const committed = frozen(emptySnapshot(localCtx));
    const good = plainUser("a");
    expect(checkFrame(localCtx, committed, [good, imageUser])).toEqual({
      ok: false,
      reason: "unfiltered",
      lineIndex: 1,
    });
    const retry = checkFrame(localCtx, committed, [good, retainEntry(imageUser, localCtx).line]);
    expect(retry.ok).toBe(true);
  });

  it("成功时返回新快照，输入快照一个字节不动（数组冻结，任何写入都会抛）", () => {
    const first = checkFrame(localCtx, frozen(emptySnapshot(localCtx)), [plainUser("a"), filteredLocal("b", "a")]);
    if (!first.ok) throw new Error("应通过");
    expect(first.snapshot.knownIds).toEqual(["a", "b"]);
    expect(first.snapshot.localIds).toEqual(["b"]);
    const second = checkFrame(localCtx, frozen(first.snapshot), [
      plainEdit("e", "b", [{ type: "text", text: "p" }], "b"),
    ]);
    expect(second.ok).toBe(false);
    expect(first.snapshot.knownIds).toEqual(["a", "b"]);
  });

  it("快照是可 JSON 往返的纯数据：存进数据库再取出来继续复查", () => {
    const first = checkFrame(localCtx, emptySnapshot(localCtx), [filteredLocal("b")]);
    if (!first.ok) throw new Error("应通过");
    const stored = JSON.parse(JSON.stringify(first.snapshot)) as RetainSnapshot;
    expect(checkFrame(localCtx, stored, [plainEdit("e", "b", [{ type: "text", text: SECRET }], "b")])).toMatchObject({
      ok: false,
      reason: "unfiltered",
    });
  });

  it("运行器和服务器对同一批行得到同一份快照", () => {
    const runner = createRetainer(localCtx);
    const raw = [
      plainUser("a"),
      secretResult({}, { id: "b", parentId: "a" }),
      plainEdit("e", "b", [{ type: "text", text: SECRET }], "b"),
    ];
    const lines = raw.map((line) => retained(runner.retain(line)).line);
    const result = checkFrame(localCtx, emptySnapshot(localCtx), lines);
    expect(result).toEqual({ ok: true, snapshot: runner.snapshot() });
  });
});

const missingReplacement = (targetId: string) => JSON.stringify({ type: "context_edit", id: "e", targetId });

type Patch = Partial<Record<"rawJSON" | "isRawJSON" | "parse", unknown>>;
const withJson = <T>(patch: Patch, run: () => T): T => {
  const target = JSON as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, target[key]]));
  Object.assign(target, patch);
  try {
    return run();
  } finally {
    Object.assign(target, saved);
  }
};

describe("第三轮 R2-3：已知类型的畸形条目拒收，不抛异常", () => {
  it("复核报告的四个调用组合：缺 replacement 的编辑，目标不存在或是本机结果，retain 和复查都拒收", () => {
    const withLocal = () => {
      const retainer = createRetainer(localCtx);
      retained(retainer.retain(secretResult({}, { id: "l" })));
      return retainer;
    };
    const localSnapshot = withLocal().snapshot();
    expect(localSnapshot.localIds).toEqual(["l"]);
    for (const [name, line, retainer, snapshot] of [
      ["目标不存在", missingReplacement("missing"), createRetainer(localCtx), emptySnapshot(localCtx)],
      ["目标是本机结果", missingReplacement("l"), withLocal(), localSnapshot],
    ] as const) {
      expect(() => retainer.retain(line), `${name} retain`).not.toThrow();
      expect(retainer.retain(line), `${name} retain`).toEqual({ status: "rejected", reason: "malformed_entry" });
      expect(() => checkFrame(localCtx, snapshot, [line]), `${name} 复查`).not.toThrow();
      expect(checkFrame(localCtx, snapshot, [line]), `${name} 复查`).toEqual({
        ok: false,
        reason: "malformed_entry",
        lineIndex: 0,
      });
    }
  });

  it.each([
    ["replacement 是字符串", { type: "context_edit", id: "e", targetId: "t", replacement: SECRET }],
    ["replacement 是空对象", { type: "context_edit", id: "e", targetId: "t", replacement: {} }],
    ["replacement.content 是数字", { type: "context_edit", id: "e", targetId: "t", replacement: { content: 1 } }],
    ["replacement 是数组", { type: "context_edit", id: "e", targetId: "t", replacement: [SECRET] }],
    ["缺 targetId", { type: "context_edit", id: "e", replacement: null }],
    ["targetId 不是字符串", { type: "context_edit", id: "e", targetId: { x: 1 }, replacement: null }],
    ["message 不是对象", { type: "message", id: "m", message: SECRET }],
    ["缺 message", { type: "message", id: "m" }],
    ["custom_message 缺 content", { type: "custom_message", id: "c", customType: "x", display: true }],
    ["custom_message.content 是对象", { type: "custom_message", id: "c", content: { type: "image" } }],
  ])("%s：两边都拒收", (_name, entryObject) => {
    const line = JSON.stringify(entryObject);
    expect(createRetainer(localCtx).retain(line)).toEqual({ status: "rejected", reason: "malformed_entry" });
    expect(checkFrame(localCtx, emptySnapshot(localCtx), ["先放一行 JSON 之外的内容", line])).toEqual({
      ok: false,
      reason: "malformed_entry",
      lineIndex: 1,
    });
  });

  it("嵌套深到 JSON 遍历栈溢出的行：转成拒收，不抛", () => {
    const line = `{"type":"message","id":"deep","message":{"role":"user","content":${"[".repeat(200000)}${"]".repeat(200000)}}}`;
    expect(() => createRetainer(ctx).retain(line)).not.toThrow();
    expect(createRetainer(ctx).retain(line)).toEqual({ status: "rejected", reason: "malformed_entry" });
    expect(checkFrame(ctx, emptySnapshot(ctx), [line])).toMatchObject({ ok: false, reason: "malformed_entry" });
  });

  it("被拒绝的畸形行不推进状态：它的 id 不会变成已知条目", () => {
    const retainer = createRetainer(localCtx);
    retainer.retain(missingReplacement("x"));
    expect(retainer.snapshot().knownIds).toEqual([]);
  });
});

describe("第三轮 R2-4：缺原文保值能力时启动就抛，不退回丢精度或整行放行", () => {
  const nativeParse = JSON.parse.bind(JSON) as (
    text: string,
    reviver?: (this: unknown, key: string, value: unknown, ...rest: unknown[]) => unknown,
  ) => unknown;
  const reviverWith =
    (context: (real: unknown) => unknown[]) =>
    (text: string, reviver?: (this: unknown, key: string, value: unknown, ...rest: unknown[]) => unknown) =>
      nativeParse(
        text,
        reviver === undefined
          ? undefined
          : function (this: unknown, key, value, real) {
              return reviver.call(this, key, value, ...context(real));
            },
      );

  it.each([
    ["JSON.rawJSON 不存在", { rawJSON: undefined }, /JSON\.rawJSON/],
    ["JSON.isRawJSON 不存在", { isRawJSON: undefined }, /JSON\.isRawJSON/],
    ["reviver 的 context 里没有 source", { parse: reviverWith(() => [{}]) }, /context\.source/],
    ["reviver 不传第三个参数", { parse: reviverWith(() => []) }, /context\.source/],
  ] as const)("%s：留存和复查入口都抛说清楚的错", (_name, patch, message) => {
    const snapshot = emptySnapshot(localCtx);
    const imageLine = entry({ role: "user", content: [{ type: "image", data: "IMG" }], timestamp: 1 });
    withJson(patch, () => {
      expect(() => createRetainer(localCtx)).toThrow(message);
      expect(() => checkFrame(localCtx, snapshot, [imageLine])).toThrow(message);
      expect(() => assertRawJsonSupport()).toThrow(/不退回丢精度或整行放行/);
    });
  });

  it("原生环境探测通过，替换在用例结束后已恢复", () => {
    expect(() => assertRawJsonSupport()).not.toThrow();
    expect(
      retainEntry('{"type":"message","n":9007199254740993,"message":{"role":"user","content":[{"type":"image"}]}}', ctx)
        .line,
    ).toBe(
      '{"type":"message","n":9007199254740993,"message":{"role":"user","content":[{"type":"text","text":"（之前的截图已省略）"}]}}',
    );
  });
});

describe("第三轮 R2-5：本机工具名单的指纹随快照走，名单变了要显式重建", () => {
  const moreCtx = { localOnlyToolNames: new Set(["mail_read", "web_search"]) };

  it("指纹是排序后名单的 sha256（字面量）", () => {
    expect(toolListFingerprint(new Set(["mail_read"]))).toBe(
      "5036183fe3c1e16fed96530f3856fd49da555576b0bfc3722554cf82ac8ca8f2",
    );
    expect(toolListFingerprint(new Set())).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect(toolListFingerprint(new Set(["web_search", "mail_read"]))).toBe(
      "7a7d826e4f441b6c84dc3c84cc1c1090947ab1858dfcd067146d51abfcebc8d9",
    );
  });

  it("名单变了：checkFrame 给可区分的 tool_list_changed，不带行号，不做任何过滤判断", () => {
    const snapshot = emptySnapshot(localCtx);
    expect(checkFrame(moreCtx, snapshot, [plainUser("a")])).toEqual({ ok: false, reason: "tool_list_changed" });
    expect(checkFrame(ctx, snapshot, [])).toEqual({ ok: false, reason: "tool_list_changed" });
  });

  it("服务器按自己的名单验证：运行器名单更长时，多出的本机工具原样放行的结果不会被运行器的名单救下", () => {
    const runnerLine = retainEntry(secretResult({ toolName: "web_search" }, { id: "w" }), moreCtx).line;
    expect(runnerLine).toContain("本机工具结果，原文未上传 tool=web_search");
    expect(checkFrame(localCtx, emptySnapshot(localCtx), [runnerLine])).toEqual({
      ok: true,
      snapshot: expect.anything(),
    });
    const runnerMissed = secretResult({ toolName: "web_search" }, { id: "w" });
    expect(checkFrame(moreCtx, emptySnapshot(moreCtx), [runnerMissed])).toMatchObject({
      ok: false,
      reason: "unfiltered",
    });
    expect(checkFrame(localCtx, emptySnapshot(localCtx), [runnerMissed]).ok).toBe(true);
  });

  it("同一份名单换个顺序、重复写，指纹和复查结果不变", () => {
    const reordered = { localOnlyToolNames: new Set(["web_search", "mail_read"]) };
    expect(checkFrame(reordered, emptySnapshot(moreCtx), [plainUser("a")]).ok).toBe(true);
  });

  it("运行器用旧名单的快照恢复：第一次 retain 就是 tool_list_changed，之后一直是", () => {
    const snapshot = emptySnapshot(localCtx);
    const retainer = createRetainer(moreCtx, snapshot);
    expect(retainer.retain(plainUser("a"))).toEqual({ status: "rejected", reason: "tool_list_changed" });
    expect(retainer.retain(plainUser("b"))).toEqual({ status: "rejected", reason: "tool_list_changed" });
    expect(createRetainer(localCtx, snapshot).retain(plainUser("a")).status).toBe("retained");
  });
});

describe("第四轮：快照边界与名单变更后的重建", () => {
  it("F1：旧名单提交原文，停住后拿快照起新 Retainer，仍拒收指向旧结果的编辑", () => {
    const raw = secretResult({}, { id: "l" });
    expect(raw).toContain(SECRET);
    const committed = checkFrame(ctx, emptySnapshot(ctx), [raw]);
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error("旧名单的原文帧应能提交");
    const old = committed.snapshot;
    expect(old.knownIds).toEqual(["l"]);
    expect(old.localIds).toEqual([]);

    const stopped = createRetainer(localCtx, frozen(old));
    expect(stopped.retain(plainUser("u"))).toEqual({ status: "rejected", reason: "tool_list_changed" });
    const saved = stopped.snapshot();
    expect(saved).toEqual(old);
    expect(saved.toolFingerprint).not.toBe(toolListFingerprint(localCtx.localOnlyToolNames));
    const resumed = createRetainer(localCtx, saved);
    expect(resumed.retain(plainEdit("e", "l", [{ type: "text", text: SECRET }]))).toEqual({
      status: "rejected",
      reason: "tool_list_changed",
    });
    expect(resumed.retain(plainUser("next"))).toEqual({ status: "rejected", reason: "tool_list_changed" });
  });

  it("F1：起点和每次返回的旧快照都是深拷贝，调用方改数组或指纹不会改后续快照", () => {
    const source = { ...emptySnapshot(localCtx), knownIds: ["l"], localIds: ["l"] };
    const expected = structuredClone(source);
    const stopped = createRetainer(ctx, source);
    source.knownIds.push("caller-added");
    source.localIds.length = 0;
    source.toolFingerprint = toolListFingerprint(ctx.localOnlyToolNames);
    const first = stopped.snapshot();
    expect(first).toEqual(expected);
    expect(first.knownIds).not.toBe(source.knownIds);
    expect(first.localIds).not.toBe(source.localIds);
    Object.assign(first, { toolFingerprint: source.toolFingerprint });
    Object.defineProperty(first.knownIds, "0", { value: "changed" });
    Object.defineProperty(first.localIds, "0", { value: "changed" });
    const second = stopped.snapshot();
    expect(second).toEqual(expected);
    expect(second.knownIds).not.toBe(first.knownIds);
    expect(second.localIds).not.toBe(first.localIds);
    expect(createRetainer(ctx, second).retain(plainUser("u"))).toEqual({
      status: "rejected",
      reason: "tool_list_changed",
    });
  });

  it("F3：存库快照在边界 parse 后能恢复运行器和服务器", () => {
    const snapshot = RetainSnapshot.parse(JSON.parse(JSON.stringify(emptySnapshot(localCtx))));
    expect(snapshot).toEqual(emptySnapshot(localCtx));
    const result = createRetainer(localCtx, snapshot).retain(plainUser("u"));
    expect(result.status).toBe("retained");
    expect(checkFrame(localCtx, snapshot, [plainUser("u")]).ok).toBe(true);
  });

  it.each([
    ["version 是 2", { version: 2 }],
    ["knownIds 是 null", { knownIds: null }],
    ["knownIds 是数字", { knownIds: 42 }],
    ["knownIds 含数字", { knownIds: [42] }],
    ["localIds 含数字", { localIds: [42] }],
    ["指纹不是字符串", { toolFingerprint: 42 }],
  ])("F3：%s 在快照边界 parse 失败", (_name, patch) => {
    const value = { ...emptySnapshot(localCtx), ...patch };
    expect(() => RetainSnapshot.parse(value)).toThrow();
  });

  it("F4：新名单从头重放，旧原文行必须重新过滤后才能通过复查", () => {
    const raw = secretResult({}, { id: "l" });
    expect(checkFrame(ctx, emptySnapshot(ctx), [raw]).ok).toBe(true);
    expect(checkFrame(localCtx, emptySnapshot(localCtx), [raw])).toEqual({
      ok: false,
      reason: "unfiltered",
      lineIndex: 0,
    });
    const rebuilt = createRetainer(localCtx);
    const filtered = retained(rebuilt.retain(raw));
    expect(filtered.retention).toBe("redacted");
    expect(filtered.line).not.toContain(SECRET);
    expect(checkFrame(localCtx, emptySnapshot(localCtx), [filtered.line])).toEqual({
      ok: true,
      snapshot: rebuilt.snapshot(),
    });
  });
});

describe("第三轮：随机流按帧复查", () => {
  const MARK = "R3_PRIVATE_MARK";
  const names = ["mail_read", "tool with spaces", "tool[time=]"];
  const randomCtx: RetainContext = { localOnlyToolNames: new Set(names) };
  const times: unknown[] = [
    ISO,
    "2026-10-14T08:00:00+08:00",
    "2026-10-14 00:00:00",
    "",
    "time=sk-secret",
    "bad\ntime",
    1760000000000,
    null,
    { x: "时间对象" },
  ];
  const localTimes: unknown[] = [...times, { x: MARK }, [MARK]];

  it("400 条流、每条 16 行、帧长 1 到 5：接受的帧不含原文，重复 id 和畸形行两边同样拒收，快照一致", () => {
    let seed = 0x3a12b3;
    const rand = (n: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % n;
    };
    const pick = <T>(list: readonly T[]): T => list[rand(list.length)] as T;
    const counts = {
      lines: 0,
      local: 0,
      edits: 0,
      forward: 0,
      extra: 0,
      nonIso: 0,
      redacted: 0,
      dup: 0,
      malformed: 0,
      rawAccepted: 0,
    };
    for (let stream = 0; stream < 400; stream += 1) {
      const known: Array<{ id: string; local: boolean }> = [];
      const raw: Array<{ line: string; fault?: "duplicate_id" | "malformed_entry" }> = [];
      for (let i = 0; i < 16; i += 1) {
        const id = `s${stream}-${i}`;
        const kind = rand(8);
        const time = pick(kind <= 1 ? localTimes : times);
        counts.nonIso += Number(time !== ISO);
        let line: string;
        let fault: "duplicate_id" | "malformed_entry" | undefined;
        if (kind <= 1) {
          const extra: Record<string, unknown> = {};
          for (let k = rand(3); k > 0; k -= 1)
            extra[pick(["rawResult", "output", "error", "extra", "usage", "details"])] = { content: MARK };
          counts.extra += Object.keys(extra).length;
          line = JSON.stringify({
            type: "message",
            id,
            parentId: null,
            timestamp: time,
            message: {
              role: "toolResult",
              toolCallId: "c",
              toolName: pick(names),
              content: [{ type: "text", text: MARK }],
              isError: false,
              timestamp: i,
              ...extra,
            },
          });
          known.push({ id, local: true });
          counts.local += 1;
        } else if (kind <= 3) {
          const content: unknown[] = [{ type: "text", text: rand(6) === 0 ? "😀".repeat(9000) : "公开" }];
          if (rand(3) === 0) content.push({ type: "image", data: "IMG" });
          line = JSON.stringify({
            type: "message",
            id,
            parentId: null,
            timestamp: time,
            message: { role: "user", content, timestamp: i },
          });
          known.push({ id, local: false });
        } else if (kind <= 5) {
          const target = known.length > 0 && rand(4) > 0 ? pick(known) : { id: `future-${stream}-${i}`, local: true };
          counts.forward += Number(target.id.startsWith("future"));
          counts.edits += 1;
          const replacement =
            rand(8) === 0
              ? null
              : {
                  content: [{ type: "text", text: target.local ? MARK : "改写" }],
                  note: target.local ? MARK : "元数据",
                };
          line = JSON.stringify({
            type: "context_edit",
            id,
            parentId: null,
            timestamp: time,
            targetId: target.id,
            replacement,
          });
          known.push({ id, local: false });
        } else if (kind === 6 && known.length > 0) {
          line = JSON.stringify({
            type: "message",
            id: pick(known).id,
            parentId: null,
            timestamp: time,
            message: { role: "user", content: [{ type: "text", text: "重复" }], timestamp: i },
          });
          fault = "duplicate_id";
          counts.dup += 1;
        } else {
          line = JSON.stringify(
            pick([
              { type: "context_edit", id, targetId: "x" },
              { type: "message", id, message: MARK },
              { type: "custom_message", id },
            ]),
          );
          fault = "malformed_entry";
          counts.malformed += 1;
        }
        raw.push(fault === undefined ? { line } : { line, fault });
        counts.lines += 1;
      }

      const runner = createRetainer(randomCtx);
      const uploaded: string[] = [];
      let stopped: string | undefined;
      for (const [index, item] of raw.entries()) {
        const result = runner.retain(item.line);
        if (result.status === "rejected") {
          stopped = result.reason;
          expect(result.reason, `流 ${stream} 行 ${index} 拒收原因`).toBe(item.fault ?? result.reason);
          expect(runner.retain(raw[0]?.line ?? ""), `流 ${stream} 拒收后停住`).toEqual({
            status: "rejected",
            reason: result.reason,
          });
          break;
        }
        expect(item.fault, `流 ${stream} 行 ${index} 本该被拒收`).toBeUndefined();
        counts.redacted += Number(result.retention === "redacted");
        expect(result.line, `流 ${stream} 行 ${index} 原文`).not.toContain(MARK);
        uploaded.push(result.line);
      }
      if (raw.some((item) => item.fault !== undefined))
        expect(stopped, `流 ${stream} 有故障行，运行器必须停`).toBeDefined();

      const checker = server(randomCtx);
      let cursor = 0;
      while (cursor < uploaded.length) {
        const frame = uploaded.slice(cursor, cursor + 1 + rand(5));
        const before = JSON.stringify(checker.committed());
        const result = checker.frame(frame);
        expect(result.ok, `流 ${stream} 帧 ${cursor}`).toBe(true);
        expect(before).not.toBe(JSON.stringify(checker.committed()));
        cursor += frame.length;
      }
      expect(new Set(checker.committed().knownIds)).toEqual(new Set(runner.snapshot().knownIds));
      expect(new Set(checker.committed().localIds)).toEqual(new Set(runner.snapshot().localIds));

      const rawChecker = server(randomCtx);
      cursor = 0;
      while (cursor < raw.length) {
        const frame = raw.slice(cursor, cursor + 1 + rand(5)).map((item) => item.line);
        const before = JSON.stringify(rawChecker.committed());
        const result = rawChecker.frame(frame);
        if (!result.ok) {
          expect(JSON.stringify(rawChecker.committed()), `流 ${stream} 拒收帧不留痕`).toBe(before);
          break;
        }
        counts.rawAccepted += 1;
        expect(frame.join("\n"), `流 ${stream} 接受的原始帧不含原文`).not.toContain(MARK);
        cursor += frame.length;
      }
    }
    expect(counts.local).toBeGreaterThan(300);
    expect(counts.edits).toBeGreaterThan(400);
    expect(counts.forward).toBeGreaterThan(100);
    expect(counts.extra).toBeGreaterThan(300);
    expect(counts.nonIso).toBeGreaterThan(2000);
    expect(counts.dup).toBeGreaterThan(100);
    expect(counts.malformed).toBeGreaterThan(100);
    expect(counts.redacted).toBeGreaterThan(300);
  });
});
