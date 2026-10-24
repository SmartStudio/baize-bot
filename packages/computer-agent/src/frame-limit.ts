import { AGENT_FRAME_MAX_BYTES, type AgentToControl, type JsonValue, type ToolView } from "@baize/shared";

const CLIPPED = "…（内容过长，后面的已截掉）";
const VIEW_TEXT_MAX_BYTES = 4096;

export class OversizedUplink extends Error {}

export type FittedUplink =
  | { readonly kind: "fit"; readonly body: AgentToControl }
  | { readonly kind: "dropped"; readonly notice: Extract<AgentToControl, { type: "agent_error" }> };

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const mib = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MiB`;

function utf8Prefix(text: string, limit: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= limit) return text;
  let end = Math.max(limit, 0);
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

const short = (text: string): string =>
  utf8Bytes(text) <= VIEW_TEXT_MAX_BYTES
    ? text
    : `${utf8Prefix(text, VIEW_TEXT_MAX_BYTES - utf8Bytes(CLIPPED))}${CLIPPED}`;

function shortJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return short(value);
  const text = JSON.stringify(value);
  return utf8Bytes(text) <= VIEW_TEXT_MAX_BYTES ? value : short(text);
}

/** 审批卡和工具卡用的是同一份视图，哪个字段都可能装着模型给的大参数，所以整份收短。 */
function compactView(view: ToolView): ToolView {
  const raw =
    view.raw === undefined ? {} : { raw: `原始参数有 ${utf8Bytes(JSON.stringify(view.raw))} 字节，太大没有上传` };
  switch (view.kind) {
    case "bash":
      return {
        kind: "bash",
        command: short(view.command),
        ...(view.note === undefined ? {} : { note: short(view.note) }),
        ...raw,
      };
    case "write":
      return { kind: "write", path: short(view.path), preview: view.preview.map(short), ...raw };
    case "edit":
      return { kind: "edit", path: short(view.path), changedLines: view.changedLines, ...raw };
    case "mcp":
      return {
        kind: "mcp",
        server: short(view.server),
        tool: short(view.tool),
        params: view.params.map(({ key, value }) => ({ key: short(key), value: shortJson(value) })),
        ...raw,
      };
    case "helper":
      return { kind: "helper", name: view.name, task: view.task, status: view.status, ...raw };
    case "takeover":
      return { kind: "takeover", liveId: view.liveId, reason: short(view.reason), ...raw };
  }
}

function shrink(body: AgentToControl, over: number): AgentToControl | null {
  // JSON 转义只会让字节变多，按原文字节砍掉 over 就一定够。
  const clip = (text: string): string => `${utf8Prefix(text, utf8Bytes(text) - over - utf8Bytes(CLIPPED))}${CLIPPED}`;
  switch (body.type) {
    case "bot_text_done":
      return { ...body, text: clip(body.text) };
    case "agent_error":
      return { ...body, detail: clip(body.detail) };
    case "bot_tool_call":
    case "approval_request":
      return { ...body, view: compactView(body.view) };
    default:
      return null;
  }
}

/** 带 runId 的 agent_error 让控制面替这个 run 收尾，群里能看到它为什么停了。 */
function droppedNotice(body: AgentToControl, bytes: number): FittedUplink {
  const runId = "runId" in body && body.runId !== undefined && body.runId !== null ? body.runId : undefined;
  const groupId = "groupId" in body ? body.groupId : body.type === "work_append" ? body.lane.groupId : undefined;
  return {
    kind: "dropped",
    notice: {
      type: "agent_error",
      code: "runner_failed",
      detail: `${body.type} 报文过长被丢弃：有 ${mib(bytes)}，截短后仍超过单帧上限 ${mib(AGENT_FRAME_MAX_BYTES)}`,
      ...(runId !== undefined ? { runId } : groupId !== undefined ? { groupId } : {}),
    },
  };
}

/** 超限的可靠帧会被控制面以 1009 关掉，重连重发又被关，整台电脑的发件箱就卡死了，所以入队和重放前都要收。 */
export function fitUplink(body: AgentToControl, frameOf: (body: AgentToControl) => unknown): FittedUplink {
  const frameBytes = (candidate: AgentToControl): number => utf8Bytes(JSON.stringify(frameOf(candidate)));
  const bytes = frameBytes(body);
  if (bytes <= AGENT_FRAME_MAX_BYTES) return { kind: "fit", body };
  const fitted = shrink(body, bytes - AGENT_FRAME_MAX_BYTES);
  if (fitted !== null && frameBytes(fitted) <= AGENT_FRAME_MAX_BYTES) return { kind: "fit", body: fitted };
  return droppedNotice(body, bytes);
}
