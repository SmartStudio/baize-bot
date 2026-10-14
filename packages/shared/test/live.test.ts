import { describe, expect, it } from "vitest";
import {
  LIVE_HEADER_MAX,
  LiveDown,
  LiveFromViewer,
  LiveInput,
  LiveSession,
  LiveToViewer,
  LiveUp,
  ServerPush,
  ToolView,
  decodeLive,
  encodeLive,
  latestWins,
  liveEndActions,
  toolViewText,
  type LiveHeader,
  type LivePurpose,
} from "../src/index.js";

const LIVE_ID = "3f2b8c1e-5a47-4d0e-9b6a-1c2d3e4f5a6b";
const ACCOUNT_ID = "account-1";
const ATTEMPT = "attempt-1";

const loginPurpose = { kind: "login", accountId: ACCOUNT_ID, platform: "xiaohongshu", attempt: ATTEMPT } as const;
const takeoverPurpose = { kind: "takeover", botId: "bot-1", groupId: "group-1", reason: "页面要验证码" } as const;
const announce = { liveId: LIVE_ID, purpose: loginPurpose, origin: "https://www.xiaohongshu.com" };
const mouse = {
  kind: "mouse",
  phase: "down",
  x: 0.25,
  y: 0.75,
  button: "left",
  clicks: 1,
  modifiers: 0,
} as const;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const lengthPrefix = (length: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
};
const rawFrame = (headerBytes: Uint8Array, payload: Uint8Array = new Uint8Array(0)): Uint8Array =>
  concat(lengthPrefix(headerBytes.length), headerBytes, payload);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const oneByte = (n: number) => new Uint8Array([n]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9]);

describe("画面帧的编码", () => {
  const cases: { name: string; schema: Parameters<typeof decodeLive>[0]; header: LiveHeader }[] = [
    { name: "LiveUp session", schema: LiveUp, header: { t: "session", session: announce } as LiveHeader },
    { name: "LiveUp frame", schema: LiveUp, header: { t: "frame", liveId: LIVE_ID } as LiveHeader },
    { name: "LiveUp closed", schema: LiveUp, header: { t: "closed", liveId: LIVE_ID } as LiveHeader },
    {
      name: "LiveDown viewer",
      schema: LiveDown,
      header: { t: "viewer", liveId: LIVE_ID, state: "attached" } as LiveHeader,
    },
    { name: "LiveDown input", schema: LiveDown, header: { t: "input", liveId: LIVE_ID, input: mouse } as LiveHeader },
    { name: "LiveDown end", schema: LiveDown, header: { t: "end", liveId: LIVE_ID, action: "finish" } as LiveHeader },
    { name: "LiveDown reveal", schema: LiveDown, header: { t: "reveal", liveId: LIVE_ID } as LiveHeader },
    {
      name: "LiveToViewer session",
      schema: LiveToViewer,
      header: { t: "session", session: { ...announce, computerId: "computer-1" } } as LiveHeader,
    },
    { name: "LiveToViewer frame", schema: LiveToViewer, header: { t: "frame", liveId: LIVE_ID } as LiveHeader },
    {
      name: "LiveFromViewer input",
      schema: LiveFromViewer,
      header: { t: "input", input: { kind: "text", text: "验证码 482913" } } as LiveHeader,
    },
    { name: "LiveFromViewer end", schema: LiveFromViewer, header: { t: "end", action: "abandon" } as LiveHeader },
    { name: "LiveFromViewer reveal", schema: LiveFromViewer, header: { t: "reveal" } as LiveHeader },
  ];

  it.each(cases)("$name 编码再解码原样回来", ({ schema, header }) => {
    const decoded = decodeLive(schema, encodeLive(header));
    expect(decoded).not.toBeNull();
    expect(decoded?.header).toEqual(header);
    expect(Array.from(decoded?.payload ?? [1])).toEqual([]);
  });

  it("负载字节逐个相等，头长按大端写在前 4 字节", () => {
    const header = { t: "frame", liveId: LIVE_ID } as LiveHeader;
    const bytes = encodeLive(header, jpeg);
    const headerText = JSON.stringify({ t: "frame", liveId: LIVE_ID });
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0, 0, headerText.length]);
    const decoded = decodeLive(LiveUp, bytes);
    expect(decoded?.header).toEqual({ t: "frame", liveId: LIVE_ID });
    expect(Array.from(decoded?.payload ?? [])).toEqual([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 0xff, 0xd9]);
  });

  it("头里的中文按 UTF-8 字节计长，不是按字符", () => {
    const header = { t: "input", input: { kind: "text", text: "密码" } } as LiveHeader;
    const bytes = encodeLive(header);
    const headerBytes = utf8(JSON.stringify(header));
    expect(JSON.stringify(header).length).toBe(49);
    expect(headerBytes.length).toBe(53);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0, 0, 53]);
    expect(decodeLive(LiveFromViewer, bytes)?.header).toEqual(header);
  });

  it("subarray 视图（带偏移的缓冲）同样解得开", () => {
    const framed = encodeLive({ t: "frame", liveId: LIVE_ID } as LiveHeader, jpeg);
    const shifted = new Uint8Array(framed.length + 3);
    shifted.set(framed, 3);
    const decoded = decodeLive(LiveUp, shifted.subarray(3));
    expect(decoded?.header).toEqual({ t: "frame", liveId: LIVE_ID });
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(jpeg));
  });

  it("头长恰好 LIVE_HEADER_MAX 通得过，超过一字节就是 null", () => {
    const base = '{"t":"frame","liveId":"' + LIVE_ID + '"}';
    const pad = (total: number) => utf8(base + " ".repeat(total - base.length));
    const exact = decodeLive(LiveUp, rawFrame(pad(LIVE_HEADER_MAX)));
    expect(exact?.header).toEqual({ t: "frame", liveId: LIVE_ID });
    expect(decodeLive(LiveUp, rawFrame(pad(LIVE_HEADER_MAX + 1)))).toBeNull();
  });

  it("编码一个超过上限的头直接抛，错误里没有头的内容", () => {
    const header = { t: "session", session: { ...announce, origin: "x" } } as LiveHeader;
    expect(() => encodeLive({ ...header, padding: "SENTINEL".repeat(5000) } as unknown as LiveHeader)).toThrow(
      "画面帧头超过上限",
    );
  });
});

describe("decodeLive 解不开一律回 null", () => {
  const good = encodeLive({ t: "frame", liveId: LIVE_ID } as LiveHeader, jpeg);

  it("不足 4 字节、截断的头、空输入", () => {
    expect(decodeLive(LiveUp, new Uint8Array(0))).toBeNull();
    expect(decodeLive(LiveUp, new Uint8Array([0, 0, 0]))).toBeNull();
    expect(decodeLive(LiveUp, good.subarray(0, 4))).toBeNull();
    expect(decodeLive(LiveUp, good.subarray(0, 4 + 10))).toBeNull();
  });

  it("头长声明超过 16KB，哪怕后面字节够长", () => {
    const declared = LIVE_HEADER_MAX + 1;
    const bytes = concat(lengthPrefix(declared), new Uint8Array(declared));
    expect(decodeLive(LiveUp, bytes)).toBeNull();
    expect(decodeLive(LiveUp, concat(lengthPrefix(0xffffffff), good))).toBeNull();
  });

  it("头长为 0、JSON 坏、不是对象、不是合法 UTF-8", () => {
    expect(decodeLive(LiveUp, rawFrame(new Uint8Array(0)))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8('{"t":"frame",')))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8("null")))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8("[]")))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])))).toBeNull();
  });

  it("schema 不过：未知的 t、缺字段、多余字段、liveId 不是 uuid、用错方向的 schema", () => {
    expect(decodeLive(LiveUp, rawFrame(utf8('{"t":"nope"}')))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8('{"t":"frame"}')))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8(`{"t":"frame","liveId":"${LIVE_ID}","extra":1}`)))).toBeNull();
    expect(decodeLive(LiveUp, rawFrame(utf8('{"t":"frame","liveId":"not-a-uuid"}')))).toBeNull();
    expect(decodeLive(LiveDown, good)).toBeNull();
    expect(decodeLive(LiveFromViewer, good)).toBeNull();
  });

  it("越界坐标和超长 text 被拒", () => {
    const withInput = (input: unknown) => rawFrame(utf8(JSON.stringify({ t: "input", input })));
    expect(decodeLive(LiveFromViewer, withInput({ ...mouse, x: 1 }))?.header).toEqual({
      t: "input",
      input: { ...mouse, x: 1 },
    });
    expect(decodeLive(LiveFromViewer, withInput({ ...mouse, x: 1.01 }))).toBeNull();
    expect(decodeLive(LiveFromViewer, withInput({ ...mouse, y: -0.01 }))).toBeNull();
    expect(decodeLive(LiveFromViewer, withInput({ kind: "text", text: "a".repeat(2000) }))).not.toBeNull();
    expect(decodeLive(LiveFromViewer, withInput({ kind: "text", text: "a".repeat(2001) }))).toBeNull();
    expect(decodeLive(LiveFromViewer, withInput({ kind: "text", text: "" }))).toBeNull();
  });

  it("坏的输入帧不泄露用户打的字：不抛，结果是 null，序列化后也找不到哨兵", () => {
    const sentinel = "SENTINEL-p4ssw0rd-密码";
    const badKey = {
      t: "input",
      input: { kind: "key", phase: "down", key: sentinel, code: "KeyA", keyCode: 65, text: sentinel, modifiers: 0 },
    };
    const badText = { t: "input", input: { kind: "text", text: sentinel.repeat(200) } };
    const badTyped = { t: "input", input: { kind: "mouse", phase: sentinel, x: 0, y: 0, button: "left" } };
    for (const header of [badKey, badText, badTyped]) {
      const bytes = rawFrame(utf8(JSON.stringify(header)), utf8(sentinel));
      let result: unknown = "unset";
      expect(() => {
        result = decodeLive(LiveFromViewer, bytes);
      }).not.toThrow();
      expect(result).toBeNull();
      expect(String(result)).toBe("null");
      expect(JSON.stringify(result)).toBe("null");
    }
    const brokenJson = rawFrame(utf8(`{"t":"input","input":{"kind":"text","text":"${sentinel}`));
    expect(decodeLive(LiveFromViewer, brokenJson)).toBeNull();
  });
});

describe("LiveInput", () => {
  it("四种输入各接受一份合法样本", () => {
    expect(LiveInput.parse(mouse)).toEqual(mouse);
    const wheel = { kind: "wheel", x: 0, y: 1, dx: -120, dy: 5000, modifiers: 15 };
    expect(LiveInput.parse(wheel)).toEqual(wheel);
    const key = { kind: "key", phase: "up", key: "Enter", code: "Enter", keyCode: 13, text: null, modifiers: 8 };
    expect(LiveInput.parse(key)).toEqual(key);
    const text = { kind: "text", text: "你好" };
    expect(LiveInput.parse(text)).toEqual(text);
  });

  it("越界的位掩码、点击数、滚动量、键码被拒", () => {
    expect(LiveInput.safeParse({ ...mouse, modifiers: 16 }).success).toBe(false);
    expect(LiveInput.safeParse({ ...mouse, clicks: 4 }).success).toBe(false);
    expect(LiveInput.safeParse({ kind: "wheel", x: 0, y: 0, dx: 5001, dy: 0, modifiers: 0 }).success).toBe(false);
    expect(
      LiveInput.safeParse({
        kind: "key",
        phase: "down",
        key: "a",
        code: "KeyA",
        keyCode: 256,
        text: "a",
        modifiers: 0,
      }).success,
    ).toBe(false);
    expect(LiveInput.safeParse({ kind: "text", text: "a", extra: true }).success).toBe(false);
  });
});

describe("liveEndActions", () => {
  it("登录只能放弃，接手可以交还或放弃", () => {
    expect(liveEndActions(loginPurpose as LivePurpose)).toEqual(["abandon"]);
    expect(liveEndActions(takeoverPurpose as LivePurpose)).toEqual(["finish", "abandon"]);
  });
});

describe("latestWins", () => {
  it("连续 offer 1 到 5，发送器没回 sent 时只发出 1，sent 之后补发 5", () => {
    const sentLog: number[] = [];
    const acks: (() => void)[] = [];
    const wins = latestWins((frame, sent) => {
      sentLog.push(frame[0] ?? -1);
      acks.push(sent);
      return true;
    });
    for (const n of [1, 2, 3, 4, 5]) wins.offer(oneByte(n));
    expect(sentLog).toEqual([1]);
    acks[0]?.();
    expect(sentLog).toEqual([1, 5]);
    acks[1]?.();
    expect(sentLog).toEqual([1, 5]);
    wins.offer(oneByte(6));
    expect(sentLog).toEqual([1, 5, 6]);
  });

  it("同一个 sent 调两次不会多发", () => {
    const sentLog: number[] = [];
    const acks: (() => void)[] = [];
    const wins = latestWins((frame, sent) => {
      sentLog.push(frame[0] ?? -1);
      acks.push(sent);
      return true;
    });
    wins.offer(oneByte(1));
    wins.offer(oneByte(2));
    acks[0]?.();
    acks[0]?.();
    expect(sentLog).toEqual([1, 2]);
  });

  it("补发的那次 send 回 false 时清空：不卡住、不留旧帧，连接回来后下一帧立刻发", () => {
    const sentLog: number[] = [];
    const acks: (() => void)[] = [];
    let alive = true;
    const wins = latestWins((frame, sent) => {
      sentLog.push(frame[0] ?? -1);
      acks.push(sent);
      return alive;
    });
    wins.offer(oneByte(1));
    wins.offer(oneByte(2));
    alive = false;
    acks[0]?.();
    expect(sentLog).toEqual([1, 2]);
    acks[1]?.();
    expect(sentLog).toEqual([1, 2]);
    alive = true;
    wins.offer(oneByte(3));
    expect(sentLog).toEqual([1, 2, 3]);
  });

  it("首次 send 就回 false：什么也不留，下一次 offer 重新发", () => {
    const sentLog: number[] = [];
    let alive = false;
    const wins = latestWins((frame) => {
      sentLog.push(frame[0] ?? -1);
      return alive;
    });
    wins.offer(oneByte(1));
    wins.offer(oneByte(2));
    expect(sentLog).toEqual([1, 2]);
    alive = true;
    wins.offer(oneByte(3));
    expect(sentLog).toEqual([1, 2, 3]);
  });

  it("reset 清掉候补，也让 reset 之前那次发送的 sent 失效", () => {
    const sentLog: number[] = [];
    const acks: (() => void)[] = [];
    const wins = latestWins((frame, sent) => {
      sentLog.push(frame[0] ?? -1);
      acks.push(sent);
      return true;
    });
    wins.offer(oneByte(1));
    wins.offer(oneByte(2));
    wins.reset();
    acks[0]?.();
    expect(sentLog).toEqual([1]);
    wins.offer(oneByte(3));
    expect(sentLog).toEqual([1, 3]);
    acks[0]?.();
    wins.offer(oneByte(4));
    expect(sentLog).toEqual([1, 3]);
    acks[1]?.();
    expect(sentLog).toEqual([1, 3, 4]);
  });

  it("send 同步回 sent 时每帧都发，不重入出错", () => {
    const sentLog: number[] = [];
    const wins = latestWins((frame, sent) => {
      sentLog.push(frame[0] ?? -1);
      sent();
      return true;
    });
    for (const n of [1, 2, 3]) wins.offer(oneByte(n));
    expect(sentLog).toEqual([1, 2, 3]);
  });
});

describe("shared 其他改动", () => {
  it("takeover 卡：校验、文字、带 raw", () => {
    const view = { kind: "takeover", liveId: LIVE_ID, reason: "页面要验证码" };
    expect(ToolView.parse(view)).toEqual(view);
    expect(ToolView.parse({ ...view, raw: { a: [1, "b"] } })).toEqual({ ...view, raw: { a: [1, "b"] } });
    expect(ToolView.safeParse({ ...view, liveId: "x" }).success).toBe(false);
    expect(toolViewText(ToolView.parse(view))).toBe("请你接手这一页：页面要验证码");
  });

  it("live_session 与 live_closed 推送", () => {
    const session = { ...announce, computerId: "computer-1" };
    expect(ServerPush.parse({ type: "live_session", session })).toEqual({ type: "live_session", session });
    expect(ServerPush.parse({ type: "live_closed", liveId: LIVE_ID })).toEqual({
      type: "live_closed",
      liveId: LIVE_ID,
    });
    expect(ServerPush.safeParse({ type: "live_session", session: announce }).success).toBe(false);
    expect(LiveSession.safeParse({ ...session, stage: "queued" }).success).toBe(false);
  });
});
