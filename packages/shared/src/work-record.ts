// 工作记录上服务器之前的纯函数，只认 Pi 会话 JSONL 的一行字符串。
// 单开子路径 @baize/shared/work-record 导出：用了 node:crypto，不能进被 Web 引用的根导出。
import { createHash } from "node:crypto";
import { z } from "zod";
import { KEPT_EDGE_BYTES, RETAIN_TEXT_LIMIT_BYTES } from "./retention.js";

// 运行时裁旧截图和留存过滤共用这一句，重建之后模型看到的才和今天看旧截图时一样。
export const PRUNED_IMAGE_TEXT = "（之前的截图已省略）";

export interface RetainContext {
  readonly localOnlyToolNames: ReadonlySet<string>;
}

export type Retention = "verbatim" | "redacted";

type Json = Record<string, unknown>;

// V8 的 JSON.parse 带原文（context.source）和 JSON.rawJSON，Node 22 起有，lib 里还没有类型。
interface JsonWithSource {
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown,
  ): unknown;
  rawJSON(text: string): object;
  isRawJSON(value: unknown): boolean;
}
const JSON_WITH_SOURCE = JSON as unknown as JsonWithSource;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !JSON_WITH_SOURCE.isRawJSON(value);

const isString = (value: unknown): value is string => typeof value === "string";

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

/**
 * 数字原文保值靠 JSON.rawJSON、JSON.isRawJSON 和 reviver 的 context.source。缺任何一个都不能退回丢精度或整行放行，
 * 所以创建 Retainer 和复查一帧时先探一次，缺了就抛，让环境问题和「这行不是 JSON」分开。
 */
export function assertRawJsonSupport(): void {
  const api = JSON as unknown as Partial<JsonWithSource>;
  const missing: string[] = [];
  if (typeof api.rawJSON !== "function") missing.push("JSON.rawJSON");
  if (typeof api.isRawJSON !== "function") missing.push("JSON.isRawJSON");
  if (typeof api.parse === "function") {
    let source: string | undefined;
    try {
      JSON_WITH_SOURCE.parse("[9007199254740993]", (_key, value, context) => {
        if (typeof value === "number") source = context?.source;
        return value;
      });
    } catch {
      source = undefined;
    }
    if (source !== "9007199254740993") missing.push("JSON.parse 的 reviver context.source");
  }
  if (missing.length > 0) {
    throw new Error(`工作记录留存需要 ${missing.join("、")}（Node 22+），当前运行时没有，不退回丢精度或整行放行`);
  }
}

/** 数字原文和 JS 数值写回来不一致的（超精度、1e400、1.0），留成原文，改写别处时 JSON.stringify 原样写回。 */
function parseObject(line: string): Json | undefined {
  let parsed: unknown;
  try {
    parsed = JSON_WITH_SOURCE.parse(line, (_key, value, context) =>
      typeof value === "number" && context?.source !== undefined && context.source !== String(value)
        ? JSON_WITH_SOURCE.rawJSON(context.source)
        : value,
    );
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** 值没变就返回原对象，调用方靠引用相等判断这一行动没动。 */
function withField(obj: Json, key: string, update: (value: unknown) => unknown): Json {
  const next = update(obj[key]);
  return next === obj[key] ? obj : { ...obj, [key]: next };
}

const isContinuationByte = (bytes: Buffer, index: number): boolean => ((bytes[index] ?? 0) & 0xc0) === 0x80;

function shrinkText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= RETAIN_TEXT_LIMIT_BYTES) return text;
  const bytes = Buffer.from(text, "utf8");
  let headEnd = KEPT_EDGE_BYTES;
  while (isContinuationByte(bytes, headEnd)) headEnd -= 1;
  let tailStart = bytes.length - KEPT_EDGE_BYTES;
  while (isContinuationByte(bytes, tailStart)) tailStart += 1;
  const omitted = tailStart - headEnd;
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return `${head}\n[中间省略 ${omitted} 字节，整段 sha256=${sha256(text)}]\n${tail}`;
}

function redactContent(content: unknown): unknown {
  if (typeof content === "string") return shrinkText(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((block: unknown) => {
    if (!isRecord(block)) return block;
    if (block.type === "image") {
      changed = true;
      return { type: "text", text: PRUNED_IMAGE_TEXT };
    }
    if (block.type === "text" && typeof block.text === "string") {
      const text = shrinkText(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    }
    return block;
  });
  return changed ? next : content;
}

/** 占位里的时间只取合法的 ISO 8601，别的一律写 unknown：生成器和识别器共用，任何输入都是不动点，也塞不进别的文字。 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const timeLabel = (timestamp: unknown): string =>
  isString(timestamp) && ISO_TIME.test(timestamp) ? timestamp : "unknown";

const SIZE_AND_HASH = "(?:0|[1-9][0-9]*) sha256=[0-9a-f]{64}\\]$";
const LOCAL_ONLY_PREFIX = "[本机工具结果，原文未上传 tool=";
const LOCAL_ONLY_TAIL = new RegExp(`^${SIZE_AND_HASH}`);
const EDIT_PREFIX = "[上下文编辑，原文未上传 bytes=";
const EDIT_PLACEHOLDER = new RegExp(`^\\[上下文编辑，原文未上传 bytes=${SIZE_AND_HASH}`);

type Validators = Readonly<Record<string, (value: unknown) => boolean>>;

// 本机工具结果条目只留这些元字段，别的键一律丢，包括今天还不认识的。
// Pi 的 ToolResultMessage 里 details、usage、nestedCalls 都可能带原文或衍生内容。
const LOCAL_ENTRY_FIELDS: Validators = {
  type: (v) => v === "message",
  id: isString,
  parentId: (v) => v === null || isString(v),
  timestamp: isString,
  message: () => true,
};
const LOCAL_MESSAGE_FIELDS: Validators = {
  role: (v) => v === "toolResult",
  toolCallId: isString,
  toolName: isString,
  content: () => true,
  isError: (v) => typeof v === "boolean",
  timestamp: (v) => typeof v === "number" || JSON_WITH_SOURCE.isRawJSON(v),
};

function pickFields(source: Json, fields: Validators): Json {
  const picked: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(fields, key) && fields[key]?.(value) === true) picked[key] = value;
  }
  return picked;
}

const hasOnlyFields = (source: Json, fields: Validators): boolean =>
  Object.keys(pickFields(source, fields)).length === Object.keys(source).length;

const placeholderBlock = (text: string) => ({ type: "text", text });

function hasPlaceholderContent(entry: Json, message: Json, toolName: string): boolean {
  const { content } = message;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block: unknown = content[0];
  if (!isRecord(block) || Object.keys(block).length !== 2 || block.type !== "text" || !isString(block.text)) {
    return false;
  }
  const head = `${LOCAL_ONLY_PREFIX}${toolName} time=${timeLabel(entry.timestamp)} bytes=`;
  return block.text.startsWith(head) && LOCAL_ONLY_TAIL.test(block.text.slice(head.length));
}

function isLocalOnlyEntry(entry: Json, message: Json, toolName: string): boolean {
  return (
    hasOnlyFields(entry, LOCAL_ENTRY_FIELDS) &&
    hasOnlyFields(message, LOCAL_MESSAGE_FIELDS) &&
    hasPlaceholderContent(entry, message, toolName)
  );
}

function redactLocalOnlyEntry(entry: Json, message: Json, toolName: string): Json {
  if (isLocalOnlyEntry(entry, message, toolName)) return entry;
  const keptMessage = pickFields(message, LOCAL_MESSAGE_FIELDS);
  if (!hasPlaceholderContent(entry, message, toolName)) {
    const serialized = JSON.stringify(message.content ?? null);
    const text = `${LOCAL_ONLY_PREFIX}${toolName} time=${timeLabel(entry.timestamp)} bytes=${Buffer.byteLength(serialized, "utf8")} sha256=${sha256(serialized)}]`;
    keptMessage.content = [placeholderBlock(text)];
  }
  const keptEntry = pickFields(entry, LOCAL_ENTRY_FIELDS);
  keptEntry.message = keptMessage;
  return keptEntry;
}

function isEditPlaceholder(replacement: Json): boolean {
  const { content } = replacement;
  if (Object.keys(replacement).length !== 1 || !Array.isArray(content) || content.length !== 1) return false;
  const block: unknown = content[0];
  return (
    isRecord(block) &&
    Object.keys(block).length === 2 &&
    block.type === "text" &&
    isString(block.text) &&
    EDIT_PLACEHOLDER.test(block.text)
  );
}

/** Pi 的 appendContextEdit 要求 replacement 是 null，或带字符串/数组 content 的对象。 */
const isEditReplacement = (value: unknown): value is Json | null =>
  value === null || (isRecord(value) && (isString(value.content) || Array.isArray(value.content)));

/** 指向本机工具结果、或指向还没见过的条目的编辑，替换内容原文不留：Pi 投影时会拿它盖住目标的 content。 */
function redactGuardedEdit(replacement: Json | null): Json | null {
  if (replacement === null || isEditPlaceholder(replacement)) return replacement;
  const serialized = JSON.stringify(replacement.content);
  const text = `${EDIT_PREFIX}${Buffer.byteLength(serialized, "utf8")} sha256=${sha256(serialized)}]`;
  return { content: [placeholderBlock(text)] };
}

/** 迄今见过的条目 id，以及其中属于本机工具结果的。context_edit 要靠它知道目标是谁。 */
interface SeenIds {
  readonly known: Set<string>;
  readonly local: Set<string>;
}

function localToolName(message: Json, ctx: RetainContext): string | undefined {
  return message.role === "toolResult" && isString(message.toolName) && ctx.localOnlyToolNames.has(message.toolName)
    ? message.toolName
    : undefined;
}

function redactMessage(message: Json): Json {
  switch (message.role) {
    case "system":
      return message;
    case "bashExecution":
      return withField(message, "output", (output) => (isString(output) ? shrinkText(output) : output));
    default:
      return withField(message, "content", redactContent);
  }
}

/** 返回 undefined 表示已知类型的条目形状不对（Pi 自己写不出来的），由调用方拒收，不猜着放行。 */
function redactEntry(entry: Json, ctx: RetainContext, seen: SeenIds): Json | undefined {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!isRecord(message)) return undefined;
      const toolName = localToolName(message, ctx);
      if (toolName !== undefined) return redactLocalOnlyEntry(entry, message, toolName);
      return withField(entry, "message", () => redactMessage(message));
    }
    case "custom_message":
      if (!isString(entry.content) && !Array.isArray(entry.content)) return undefined;
      return withField(entry, "content", redactContent);
    case "context_edit": {
      const { targetId, replacement } = entry;
      if (!isString(targetId) || !isEditReplacement(replacement)) return undefined;
      const guarded = !seen.known.has(targetId) || seen.local.has(targetId);
      return withField(entry, "replacement", () => {
        if (guarded) return redactGuardedEdit(replacement);
        return replacement === null ? null : withField(replacement, "content", redactContent);
      });
    }
    default:
      return entry;
  }
}
/**
 * 一条流的留存状态：见过的条目 id，和其中属于本机工具结果的。
 * 数据形状：
 * - 运行器 Retainer 在内存里持有一份，一行行 retain，只有被接受的行才推进它。
 * - 服务器在数据库里存 RetainSnapshot（已提交部分的状态），每帧用 checkFrame 纯函数复查，不持有可变状态。
 * 名单变了须按新名单从头重放已提交的行；得到 unfiltered 的行须从服务器删除再重传，不能只拒收新帧。
 * 带 reviver 的解析约两千层嵌套会失败（受调用栈影响），这种行按 malformed_entry 拒收。
 */
export const RetainSnapshot = z
  .object({
    version: z.literal(1),
    toolFingerprint: z.string(),
    knownIds: z.array(z.string()).readonly(),
    localIds: z.array(z.string()).readonly(),
  })
  .readonly();
export type RetainSnapshot = z.infer<typeof RetainSnapshot>;

/** 这一行本身的毛病。 */
export type LineRejectReason =
  /** 条目 id 在这条流里第二次被定义：Pi 的 id 索引后写覆盖，已放行的 context_edit 会盖到后来的条目上。 */
  | "duplicate_id"
  /** 已知类型的条目形状不对（context_edit 缺 replacement、message 不是对象……），或处理时抛了异常。 */
  | "malformed_entry"
  /** 只有 checkFrame 会给：这行还有没过滤的内容（图片、超长文字、本机工具结果原文……）。 */
  | "unfiltered";

export type StreamRejectReason = Exclude<LineRejectReason, "unfiltered"> | "tool_list_changed";

export type RetainResult =
  | { readonly status: "retained"; readonly line: string; readonly retention: Retention }
  | { readonly status: "rejected"; readonly reason: StreamRejectReason };

export type FrameCheck =
  | { readonly ok: true; readonly snapshot: RetainSnapshot }
  | { readonly ok: false; readonly reason: "tool_list_changed" }
  | { readonly ok: false; readonly reason: LineRejectReason; readonly lineIndex: number };

/** 名单排序去重后取哈希：顺序不同的同一份名单指纹相同。 */
export function toolListFingerprint(names: ReadonlySet<string>): string {
  return sha256(JSON.stringify([...names].toSorted()));
}

export function emptySnapshot(ctx: RetainContext): RetainSnapshot {
  return { version: 1, toolFingerprint: toolListFingerprint(ctx.localOnlyToolNames), knownIds: [], localIds: [] };
}

const idsOf = (snapshot: RetainSnapshot): SeenIds => ({
  known: new Set(snapshot.knownIds),
  local: new Set(snapshot.localIds),
});

const snapshotOf = (ctx: RetainContext, seen: SeenIds): RetainSnapshot => ({
  version: 1,
  toolFingerprint: toolListFingerprint(ctx.localOnlyToolNames),
  knownIds: [...seen.known],
  localIds: [...seen.local],
});

type Step =
  | { readonly kind: "ok"; readonly line: string; readonly retention: Retention }
  | { readonly kind: "reject"; readonly reason: Exclude<LineRejectReason, "unfiltered"> };

/**
 * 单行的唯一实现，retain 和 checkFrame 都走它，两边不会漂开。只有返回 ok 时才推进 seen；
 * 过滤阶段的任何异常都转成拒收，不让它穿出整帧复查。
 * 不是 JSON、不认识的条目类型原样返回：Pi 升级加了新类型，上传不能因此断。
 */
function step(ctx: RetainContext, seen: SeenIds, line: string): Step {
  try {
    const entry = parseObject(line);
    if (entry === undefined) return { kind: "ok", line, retention: "verbatim" };
    const id = entry.id;
    if (isString(id) && seen.known.has(id)) return { kind: "reject", reason: "duplicate_id" };
    const next = redactEntry(entry, ctx, seen);
    if (next === undefined) return { kind: "reject", reason: "malformed_entry" };
    if (isString(id)) {
      seen.known.add(id);
      if (entry.type === "message" && isRecord(entry.message) && localToolName(entry.message, ctx) !== undefined) {
        seen.local.add(id);
      }
    }
    return next === entry
      ? { kind: "ok", line, retention: "verbatim" }
      : { kind: "ok", line: JSON.stringify(next), retention: "redacted" };
  } catch {
    return { kind: "reject", reason: "malformed_entry" };
  }
}

/**
 * 服务器复查一帧，纯函数：不改 committed，不留任何状态。输入是已提交的 snapshot 和这一帧的行，
 * 每一行都要原样合规（verbatim），有一行不行整帧失败，不产出新 snapshot。
 * 调用方只在追加事务提交成功之后，才把返回的 snapshot 和条目一起存下来；事务回滚就丢掉它。
 * ctx 里的名单必须是服务器自己工具连接表里的，不信帧里带的。
 */
export function checkFrame(ctx: RetainContext, committed: RetainSnapshot, lines: readonly string[]): FrameCheck {
  assertRawJsonSupport();
  if (committed.toolFingerprint !== toolListFingerprint(ctx.localOnlyToolNames)) {
    return { ok: false, reason: "tool_list_changed" };
  }
  const seen = idsOf(committed);
  for (const [lineIndex, line] of lines.entries()) {
    const result = step(ctx, seen, line);
    if (result.kind === "reject") return { ok: false, reason: result.reason, lineIndex };
    if (result.retention === "redacted") return { ok: false, reason: "unfiltered", lineIndex };
  }
  return { ok: true, snapshot: snapshotOf(ctx, seen) };
}

export interface Retainer {
  /**
   * 上传前的留存过滤。没动的行原样返回同一个字符串，哈希链和逐字等价测试都靠这一点。
   * 拒收之后这个 Retainer 停住，之后每次都返回同一个拒收原因：运行器不传这一条也不传它后面的内容。
   */
  retain(line: string): RetainResult;
  /** 已接受行的状态；因 tool_list_changed 停住时返回起点的深拷贝，保留旧指纹，仍须从头重放。 */
  snapshot(): RetainSnapshot;
}

/**
 * 运行器侧：按会话顺序把每一条条目行都喂进来，包括不用改的行和未知类型的行（不含首行 SessionHeader）。
 * context_edit 要知道目标是不是本机工具结果，所以必须有序、有状态；同一个 id 第二次出现算拒收。
 * resume 的名单指纹和 ctx 对不上，等同第一行就拒收 tool_list_changed。
 */
export function createRetainer(ctx: RetainContext, resume?: RetainSnapshot): Retainer {
  assertRawJsonSupport();
  const initial = structuredClone(resume ?? emptySnapshot(ctx));
  const seen = idsOf(initial);
  let halted: StreamRejectReason | undefined =
    initial.toolFingerprint !== toolListFingerprint(ctx.localOnlyToolNames) ? "tool_list_changed" : undefined;
  return {
    retain(line) {
      if (halted !== undefined) return { status: "rejected", reason: halted };
      const result = step(ctx, seen, line);
      if (result.kind === "reject") {
        halted = result.reason;
        return { status: "rejected", reason: result.reason };
      }
      return { status: "retained", line: result.line, retention: result.retention };
    },
    snapshot: () => (halted === "tool_list_changed" ? structuredClone(initial) : snapshotOf(ctx, seen)),
  };
}
