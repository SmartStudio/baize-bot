export const REDACTED = "[已隐藏]";

/**
 * 对端可以把收到的 Authorization 写进报错或结果里，回给前端、进模型之前都要换掉。
 * 整个头和去掉方案名的那段都换，各带百分号编码和 JSON 转义两种写法；长的先换，免得短的切碎长的。
 */
export function redactCredential(text: string, authorization: string | null): string {
  if (authorization === null) return text;
  const space = authorization.indexOf(" ");
  const raw = [authorization, space === -1 ? "" : authorization.slice(space + 1).trim()];
  const variants = [...new Set(raw.flatMap((one) => [one, encodeURIComponent(one), JSON.stringify(one).slice(1, -1)]))]
    .filter((one) => one !== "")
    .toSorted((a, b) => b.length - a.length);
  return variants.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

/** 文本里有没有这把凭据，认的写法和 redactCredential 一样。 */
export function mentionsCredential(text: string, authorization: string | null): boolean {
  return redactCredential(text, authorization) !== text;
}

const fieldOf = (error: object, key: string): unknown =>
  key in error ? (error as Record<string, unknown>)[key] : undefined;

/**
 * MCP 连接、探测、调用失败的原因只给固定分类，不带对端写的任何文字：对端可以把收到的凭据按任意编码写进报错，
 * 逐种编码去认认不完。按 SDK 错误的 name 和 code 认，这个包不依赖 SDK。
 */
export function describeMcpFailure(error: unknown): string {
  if (!(error instanceof Error)) return "原因不明";
  const name = error.name;
  const code = fieldOf(error, "code");
  if (name === "AbortError" || name === "TimeoutError") return "请求被取消或超时";
  if (name === "McpError" && typeof code === "number") return `MCP 服务回了错误（代码 ${code}）`;
  if (name === "ZodError") return "MCP 服务回的内容格式不对";
  if (typeof code === "number" && code >= 400 && code < 600) {
    return code === 401 || code === 403 ? `MCP 服务拒绝了凭据（HTTP ${code}）` : `MCP 服务回了 HTTP ${code}`;
  }
  if (error.constructor.name === "UnauthorizedError") return "MCP 服务要求授权";
  if (error instanceof TypeError) return "这个地址连不上";
  return "原因不明";
}
