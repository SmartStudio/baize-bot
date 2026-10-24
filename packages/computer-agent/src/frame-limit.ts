import { AGENT_FRAME_MAX_BYTES, type AgentToControl } from "@baize/shared";

const CLIPPED = "…（内容过长，后面的已截掉）";

export class OversizedUplink extends Error {}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function utf8Prefix(text: string, limit: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= limit) return text;
  let end = Math.max(limit, 0);
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

/** 超限的可靠帧会被控制面以 1009 关掉，重连重发又被关，整台电脑的发件箱就卡死了，所以只能在入队前收。 */
export function fitUplink(body: AgentToControl, frameOf: (body: AgentToControl) => unknown): AgentToControl | null {
  const frameBytes = (candidate: AgentToControl): number => utf8Bytes(JSON.stringify(frameOf(candidate)));
  const over = frameBytes(body) - AGENT_FRAME_MAX_BYTES;
  if (over <= 0) return body;
  // JSON 转义只会让字节变多，按原文字节砍掉 over 就一定够。
  const clip = (text: string): string => `${utf8Prefix(text, utf8Bytes(text) - over - utf8Bytes(CLIPPED))}${CLIPPED}`;
  let fitted: AgentToControl = body;
  switch (body.type) {
    case "bot_text_done":
      fitted = { ...body, text: clip(body.text) };
      break;
    case "agent_error":
      fitted = { ...body, detail: clip(body.detail) };
      break;
    case "bot_tool_call":
      if (body.view.raw !== undefined)
        fitted = {
          ...body,
          view: { ...body.view, raw: `原始参数有 ${utf8Bytes(JSON.stringify(body.view.raw))} 字节，太大没有上传` },
        };
      break;
  }
  return frameBytes(fitted) <= AGENT_FRAME_MAX_BYTES ? fitted : null;
}
