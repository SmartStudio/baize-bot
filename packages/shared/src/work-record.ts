// 工作记录上服务器之前的纯函数，只认 Pi 会话 JSONL 的一行字符串。
// 单开子路径 @baize/shared/work-record 导出：用了 node:crypto，不能进被 Web 引用的根导出。
import { createHash } from "node:crypto";

// 运行时裁旧截图和留存过滤共用这一句，重建之后模型看到的才和今天看旧截图时一样。
export const PRUNED_IMAGE_TEXT = "（之前的截图已省略）";

export const RETAIN_TEXT_LIMIT_BYTES = 16 * 1024;
const KEPT_EDGE_BYTES = 2 * 1024;

// 单位是 UTF-16 单元，不是字节：8192 个汉字是 24 KiB，最坏 UTF-8 体积 24576 字节（8192 个 3 字节字符）。
// 实测全部文字块 p99 约 4.2 KB，过滤后的长块约 4.3 KB，都整段装得下；更长的只留开头，给 trigram 索引的行体积封顶。
export const SEARCH_TEXT_LIMIT = 8192;

// 64 个 0 和 sha256 十六进制同长，拼接时前后两段边界固定。
export const CHAIN_GENESIS = "0".repeat(64);

export interface RetainContext {
  readonly localOnlyToolNames: ReadonlySet<string>;
}

export type Retention = "verbatim" | "redacted";

type Json = Record<string, unknown>;

// V8 的 JSON.parse 带原文（context.source）和 JSON.rawJSON，Node 22 起有，lib 里还没有类型。
interface JsonWithSource {
  parse(
    text: string,
    reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown;
  rawJSON(text: string): object;
  isRawJSON(value: unknown): boolean;
}
const JSON_WITH_SOURCE = JSON as unknown as JsonWithSource;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !JSON_WITH_SOURCE.isRawJSON(value);

const isString = (value: unknown): value is string => typeof value === "string";

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

/** 数字原文和 JS 数值写回来不一致的（超精度、1e400、1.0），留成原文，改写别处时 JSON.stringify 原样写回。 */
function parseObject(line: string): Json | undefined {
  try {
    const parsed = JSON_WITH_SOURCE.parse(line, (_key, value, context) =>
      typeof value === "number" && context.source !== undefined && context.source !== String(value)
        ? JSON_WITH_SOURCE.rawJSON(context.source)
        : value,
    );
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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

/** 指向本机工具结果、或指向还没见过的条目的编辑，替换内容原文不留：Pi 投影时会拿它盖住目标的 content。 */
function redactGuardedEdit(replacement: unknown): unknown {
  if (replacement === null) return replacement;
  if (isRecord(replacement) && isEditPlaceholder(replacement)) return replacement;
  const serialized = JSON.stringify(
    isRecord(replacement) && "content" in replacement ? replacement.content : replacement,
  );
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

function redactEntry(entry: Json, ctx: RetainContext, seen: SeenIds): Json {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (!isRecord(message)) return entry;
      const toolName = localToolName(message, ctx);
      if (toolName !== undefined) return redactLocalOnlyEntry(entry, message, toolName);
      return withField(entry, "message", () => redactMessage(message));
    }
    case "custom_message":
      return withField(entry, "content", redactContent);
    case "context_edit": {
      const guarded = !isString(entry.targetId) || !seen.known.has(entry.targetId) || seen.local.has(entry.targetId);
      return withField(entry, "replacement", (replacement) => {
        if (guarded) return redactGuardedEdit(replacement);
        return isRecord(replacement) ? withField(replacement, "content", redactContent) : replacement;
      });
    }
    default:
      return entry;
  }
}

function trackIds(entry: Json, ctx: RetainContext, seen: SeenIds): void {
  if (!isString(entry.id)) return;
  seen.known.add(entry.id);
  if (entry.type === "message" && isRecord(entry.message) && localToolName(entry.message, ctx) !== undefined) {
    seen.local.add(entry.id);
  }
}

export interface RetainerSnapshot {
  readonly knownIds: readonly string[];
  readonly localIds: readonly string[];
}

export interface Retainer {
  /** 上传前的留存过滤。没动的行原样返回同一个字符串，哈希链和逐字等价测试都靠这一点。 */
  retain(line: string): { line: string; retention: Retention };
  /** 服务器复查：这一行是不是已经过滤干净了，就是 retain 对它没有可改之处。 */
  check(line: string): boolean;
  /** 到目前为止见过的条目 id，服务器跨帧复查时存下来，下一帧用它起一个新的 Retainer。 */
  snapshot(): RetainerSnapshot;
}

/**
 * 按条目顺序吃一条流的行。context_edit 要知道目标是不是本机工具结果，所以必须按会话顺序、每一行都喂进来，
 * 包括不用改的行；retain 和 check 记 id 的方式相同，同一条流在两边得到同样的判断。
 * 不是 JSON、不认识的条目类型原样返回：Pi 升级加了新类型，上传不能因此断。
 */
export function createRetainer(ctx: RetainContext, resume?: RetainerSnapshot): Retainer {
  const seen: SeenIds = { known: new Set(resume?.knownIds), local: new Set(resume?.localIds) };
  const process = (line: string): { line: string; retention: Retention } => {
    const entry = parseObject(line);
    if (entry === undefined) return { line, retention: "verbatim" };
    const next = redactEntry(entry, ctx, seen);
    trackIds(entry, ctx, seen);
    return next === entry ? { line, retention: "verbatim" } : { line: JSON.stringify(next), retention: "redacted" };
  };
  return {
    retain: process,
    check: (line) => process(line).retention === "verbatim",
    snapshot: () => ({ knownIds: [...seen.known], localIds: [...seen.local] }),
  };
}

const SEARCHABLE_ROLES = new Set(["user", "assistant", "toolResult"]);

function capSearchText(text: string): string {
  if (text.length <= SEARCH_TEXT_LIMIT) return text;
  const cut = text.slice(0, SEARCH_TEXT_LIMIT);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 给 trigram 检索的文字：用户和助手的文字块、工具结果的文字。图片、思考、工具参数、usage 都不进。 */
export function searchTextOf(line: string): string {
  const entry = parseObject(line);
  if (entry === undefined || entry.type !== "message" || !isRecord(entry.message)) return "";
  const { role, content } = entry.message;
  if (typeof role !== "string" || !SEARCHABLE_ROLES.has(role)) return "";
  if (typeof content === "string") return capSearchText(content);
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content as unknown[]) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return capSearchText(texts.join("\n"));
}

/** head_n = sha256(head_{n-1} ‖ sha256(line_n))，‖ 是两段十六进制文字直接相连。 */
export function chainHead(prev: string, line: string): string {
  return sha256(prev + sha256(line));
}
