// 工作记录上服务器之前的四个纯函数，只认 Pi 会话 JSONL 的一行字符串。
// 单开子路径 @baize/shared/work-record 导出：用了 node:crypto，不能进被 Web 引用的根导出。
import { createHash } from "node:crypto";

// 运行时裁旧截图和留存过滤共用这一句，重建之后模型看到的才和今天看旧截图时一样。
export const PRUNED_IMAGE_TEXT = "（之前的截图已省略）";

export const RETAIN_TEXT_LIMIT_BYTES = 16 * 1024;
const KEPT_EDGE_BYTES = 2 * 1024;

// 按 UTF-16 单元计。实测全部文字块 p99 约 4.2 KB，过滤后的长块约 4.3 KB，都整段装得下；更长的只留开头，给 trigram 索引的行体积封顶。
export const SEARCH_TEXT_LIMIT = 8192;

// 64 个 0 和 sha256 十六进制同长，拼接时前后两段边界固定。
export const CHAIN_GENESIS = "0".repeat(64);

export interface RetainContext {
  readonly localOnlyToolNames: ReadonlySet<string>;
}

export type Retention = "verbatim" | "redacted";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

function parseObject(line: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
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

const LOCAL_ONLY_PREFIX = "[本机工具结果，原文未上传 tool=";
const LOCAL_ONLY_TAIL = /^[0-9A-Za-z:.+-]+ bytes=\d+ sha256=[0-9a-f]{64}\]$/;
const LOCAL_ONLY_DROPPED_KEYS = new Set(["details", "nestedCalls"]);

function isLocalOnlyPlaceholder(message: Json, toolName: string): boolean {
  if (Object.keys(message).some((key) => LOCAL_ONLY_DROPPED_KEYS.has(key))) return false;
  const { content } = message;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block: unknown = content[0];
  if (!isRecord(block) || Object.keys(block).length !== 2 || block.type !== "text" || typeof block.text !== "string") {
    return false;
  }
  const head = `${LOCAL_ONLY_PREFIX}${toolName} time=`;
  return block.text.startsWith(head) && LOCAL_ONLY_TAIL.test(block.text.slice(head.length));
}

function redactLocalOnlyResult(message: Json, toolName: string, entryTime: unknown): Json {
  if (isLocalOnlyPlaceholder(message, toolName)) return message;
  const serialized = JSON.stringify(message.content ?? null);
  const time = typeof entryTime === "string" ? entryTime : "unknown";
  const placeholder = {
    type: "text",
    text: `${LOCAL_ONLY_PREFIX}${toolName} time=${time} bytes=${Buffer.byteLength(serialized, "utf8")} sha256=${sha256(serialized)}]`,
  };
  const next: Json = {};
  for (const [key, value] of Object.entries(message)) {
    if (LOCAL_ONLY_DROPPED_KEYS.has(key)) continue;
    next[key] = key === "content" ? [placeholder] : value;
  }
  if (!("content" in next)) next.content = [placeholder];
  return next;
}

function redactMessage(message: Json, ctx: RetainContext, entryTime: unknown): Json {
  switch (message.role) {
    case "system":
      return message;
    case "bashExecution":
      return withField(message, "output", (output) => (typeof output === "string" ? shrinkText(output) : output));
    case "toolResult":
      if (typeof message.toolName === "string" && ctx.localOnlyToolNames.has(message.toolName)) {
        return redactLocalOnlyResult(message, message.toolName, entryTime);
      }
      return withField(message, "content", redactContent);
    default:
      return withField(message, "content", redactContent);
  }
}

function redactEntry(entry: Json, ctx: RetainContext): Json {
  switch (entry.type) {
    case "message":
      return withField(entry, "message", (message) =>
        isRecord(message) ? redactMessage(message, ctx, entry.timestamp) : message,
      );
    case "custom_message":
      return withField(entry, "content", redactContent);
    case "context_edit":
      return withField(entry, "replacement", (replacement) =>
        isRecord(replacement) ? withField(replacement, "content", redactContent) : replacement,
      );
    default:
      return entry;
  }
}

/**
 * 上传前的留存过滤。没动的行原样返回同一个字符串，哈希链和逐字等价测试都靠这一点。
 * 不是 JSON、不认识的条目类型也原样返回：Pi 升级加了新类型，上传不能因此断。
 */
export function retainEntry(line: string, ctx: RetainContext): { line: string; retention: Retention } {
  const entry = parseObject(line);
  if (entry === undefined) return { line, retention: "verbatim" };
  const next = redactEntry(entry, ctx);
  return next === entry ? { line, retention: "verbatim" } : { line: JSON.stringify(next), retention: "redacted" };
}

/** 服务器复查：这一行是不是已经过滤干净了，就是 retainEntry 对它没有可改之处。 */
export function isRetained(line: string, ctx: RetainContext): boolean {
  return retainEntry(line, ctx).retention === "verbatim";
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
