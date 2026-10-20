import { z } from "zod";
import { AccountId, BotId, BrowserPlatform, ComputerId, GroupId, LoginAttemptId } from "./domain.js";
import { LiveId } from "./live-id.js";

// 远程画面接管的契约。画面和键入走 /agent 上的二进制帧，帧头在这里，不是 AgentToServer / ControlToAgent 的成员，
// 所以 enqueueDownlink、电脑的磁盘发件箱和 parseFrame 在类型上就收不了它们。

/** 为什么要人。登录由人点出来，接手由 Bot 发起，按钮和本机窗口的规矩都按它分。 */
export const LivePurpose = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("login"),
      accountId: AccountId,
      platform: BrowserPlatform,
      attempt: LoginAttemptId,
    })
    .strict(),
  z
    .object({ kind: z.literal("takeover"), botId: BotId, groupId: GroupId, reason: z.string().min(1).max(200) })
    .strict(),
  // 云电脑上的网页终端，由人在电脑页上点开，给 grok login、codex login 这类要人操作一次的命令用。
  z.object({ kind: z.literal("terminal") }).strict(),
]);
export type LivePurpose = z.infer<typeof LivePurpose>;

/** 电脑报的样子，不带 computerId：它是哪台电脑由连接定，不由报文定。 */
export const LiveAnnounce = z
  .object({
    liveId: LiveId,
    purpose: LivePurpose,
    /** 当前主 frame 的 origin，取自 Page.frameNavigated，不取自 Bot。还没导航完是 null。 */
    origin: z.string().max(300).nullable(),
  })
  .strict();
export type LiveAnnounce = z.infer<typeof LiveAnnounce>;

export const LiveSession = LiveAnnounce.extend({ computerId: ComputerId }).strict();
export type LiveSession = z.infer<typeof LiveSession>;

export const LiveUserEnd = z.enum(["finish", "abandon"]);
export type LiveUserEnd = z.infer<typeof LiveUserEnd>;

/** 人能怎么结束：登录只能放弃（登上由电脑轮询判定），接手可以交还或放弃，终端只有关掉。Web 按它摆按钮，电脑按它收。 */
export function liveEndActions(purpose: LivePurpose): readonly LiveUserEnd[] {
  switch (purpose.kind) {
    case "login":
      return ["abandon"];
    case "takeover":
      return ["finish", "abandon"];
    case "terminal":
      return ["finish"];
  }
}

// 坐标用比例，换算成 CSS 像素是电脑的事：只有它手里有最新一帧的 deviceWidth / deviceHeight。
const Ratio = z.number().min(0).max(1);
/** CDP 的位掩码：Alt 1、Ctrl 2、Meta 4、Shift 8。 */
const Modifiers = z.number().int().min(0).max(15);

export const LiveInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mouse"),
      phase: z.enum(["move", "down", "up"]),
      x: Ratio,
      y: Ratio,
      button: z.enum(["none", "left", "middle", "right"]),
      clicks: z.number().int().min(0).max(3),
      modifiers: Modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal("wheel"),
      x: Ratio,
      y: Ratio,
      dx: z.number().min(-5000).max(5000),
      dy: z.number().min(-5000).max(5000),
      modifiers: Modifiers,
    })
    .strict(),
  /** 逐键：功能键、快捷键、逐字打密码。text 是这个键上屏的字，功能键为 null。 */
  z
    .object({
      kind: z.literal("key"),
      phase: z.enum(["down", "up"]),
      key: z.string().min(1).max(32),
      code: z.string().max(32),
      keyCode: z.number().int().min(0).max(255),
      text: z.string().min(1).max(4).nullable(),
      modifiers: Modifiers,
    })
    .strict(),
  /** 整段上屏：输入法 compositionend 和粘贴，对应 Input.insertText。 */
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }).strict(),
  /** 终端：xterm 的 onData 原样送进伪终端，控制键就是它们的转义序列。 */
  z.object({ kind: z.literal("term"), data: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      kind: z.literal("resize"),
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(200),
    })
    .strict(),
]);
export type LiveInput = z.infer<typeof LiveInput>;

/**
 * 电脑 → 控制面。session 是整份 upsert，重发同一份结果不变；closed 也幂等。frame 的负载是 JPEG，新帧可以顶掉旧帧。
 * term 的负载是终端输出的原始字节，一个字节都不能丢，中继按到达顺序原样转发。
 */
export const LiveUp = z.discriminatedUnion("t", [
  z.object({ t: z.literal("session"), session: LiveAnnounce }).strict(),
  z.object({ t: z.literal("frame"), liveId: LiveId }).strict(),
  /** replay 标记这一帧是整份回滚缓冲，每次有人 attached 都补发一份，空的也发。网页在这一帧上清屏，不在 session 头上清。 */
  z.object({ t: z.literal("term"), liveId: LiveId, replay: z.literal(true).optional() }).strict(),
  z.object({ t: z.literal("closed"), liveId: LiveId }).strict(),
]);
export type LiveUp = z.infer<typeof LiveUp>;

/** 控制面 → 电脑。viewer attached 也是幂等的：每次都重开 screencast，好让新来的人马上拿到一帧。 */
export const LiveDown = z.discriminatedUnion("t", [
  z.object({ t: z.literal("viewer"), liveId: LiveId, state: z.enum(["attached", "detached"]) }).strict(),
  z.object({ t: z.literal("input"), liveId: LiveId, input: LiveInput }).strict(),
  z.object({ t: z.literal("end"), liveId: LiveId, action: LiveUserEnd }).strict(),
  z.object({ t: z.literal("reveal"), liveId: LiveId }).strict(),
  /** 开一个终端，号由控制面给，电脑起好了照常报 session。只有云电脑认它。 */
  z.object({ t: z.literal("terminal_open"), liveId: LiveId }).strict(),
]);
export type LiveDown = z.infer<typeof LiveDown>;

/** 控制面 → 网页。frame 头和 LiveUp 的 frame 头同形，中继只解头、原样转发字节，不碰负载。 */
export const LiveToViewer = z.discriminatedUnion("t", [
  z.object({ t: z.literal("session"), session: LiveSession }).strict(),
  z.object({ t: z.literal("frame"), liveId: LiveId }).strict(),
  z.object({ t: z.literal("term"), liveId: LiveId, replay: z.literal(true).optional() }).strict(),
]);
export type LiveToViewer = z.infer<typeof LiveToViewer>;

/** 网页 → 控制面。liveId 由 socket 的路径定，帧里不带。 */
export const LiveFromViewer = z.discriminatedUnion("t", [
  z.object({ t: z.literal("input"), input: LiveInput }).strict(),
  z.object({ t: z.literal("end"), action: LiveUserEnd }).strict(),
  z.object({ t: z.literal("reveal") }).strict(),
]);
export type LiveFromViewer = z.infer<typeof LiveFromViewer>;

/** 看画面的 socket 的关闭码。网页按它说「结束了」「在别的窗口打开了」「没有这个画面」。 */
export const LiveViewerClose = { gone: 4100, replaced: 4101, notFound: 4104 } as const;

export const LIVE_HEADER_MAX = 16 * 1024;

export type LiveHeader = LiveUp | LiveDown | LiveToViewer | LiveFromViewer;

const LENGTH_BYTES = 4;
const textEncoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** 一帧 = 4 字节大端头长 + UTF-8 JSON 头 + 可选负载。只用 Uint8Array 和 DataView，shared 也跑在浏览器里。 */
export function encodeLive(header: LiveHeader, payload?: Uint8Array): Uint8Array {
  const head = textEncoder.encode(JSON.stringify(header));
  if (head.length > LIVE_HEADER_MAX) throw new Error("画面帧头超过上限");
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(LENGTH_BYTES + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, LENGTH_BYTES);
  out.set(body, LENGTH_BYTES + head.length);
  return out;
}

/**
 * 解不开一律回 null，不带原因、不抛：zod 的错误会把字段原值带出来，输入帧里的原值就是用户打的字。
 * 头长超过 LIVE_HEADER_MAX、截断、不是合法 UTF-8、JSON 坏、schema 不过，都是 null。
 */
export function decodeLive<S extends z.ZodTypeAny>(
  schema: S,
  bytes: Uint8Array,
): { header: z.infer<S>; payload: Uint8Array } | null {
  try {
    if (bytes.length < LENGTH_BYTES) return null;
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    if (headerLength > LIVE_HEADER_MAX || LENGTH_BYTES + headerLength > bytes.length) return null;
    const json = strictDecoder.decode(bytes.subarray(LENGTH_BYTES, LENGTH_BYTES + headerLength));
    const parsed = schema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    return { header: parsed.data, payload: bytes.subarray(LENGTH_BYTES + headerLength) };
  } catch {
    return null;
  }
}

/**
 * 最新的赢：同一时刻最多一份在路上、一份候补，新来的顶掉候补。只给帧用，session 和 closed 直接发。
 * send 回 false 表示连接不在了，这时清空、什么也不留；sent 只认当前这一次发送，重复调用和 reset 之后的调用都无效。
 */
export interface LatestWins {
  offer(bytes: Uint8Array): void;
  reset(): void;
}

export function latestWins(send: (bytes: Uint8Array, sent: () => void) => boolean): LatestWins {
  let ticket = 0;
  let inFlight: number | null = null;
  let pending: Uint8Array | null = null;

  const dispatch = (bytes: Uint8Array): void => {
    const mine = ++ticket;
    inFlight = mine;
    const sent = (): void => {
      if (inFlight !== mine) return;
      inFlight = null;
      const next = pending;
      pending = null;
      if (next !== null) dispatch(next);
    };
    if (!send(bytes, sent) && inFlight === mine) {
      inFlight = null;
      pending = null;
    }
  };

  return {
    offer(bytes) {
      if (inFlight === null) dispatch(bytes);
      else pending = bytes;
    },
    reset() {
      inFlight = null;
      pending = null;
    },
  };
}
