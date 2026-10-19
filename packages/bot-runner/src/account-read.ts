import { type AccountConfig, type ControlToAgent } from "@baize/shared";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { resultText } from "./assistant.js";
import type { RunnerTool } from "./bot-session.js";
import { accountLabel } from "./drafts.js";

// Bot 读 GitHub、X 只走控制面的账号代理：这边只有网关 key，平台令牌留在控制面，进不了电脑也进不了模型。
// 只发 GET，闸门归 read、不问；写一律走起草。

export const ACCOUNT_READ_TOOL = "account_read";

type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;

/** 每次调用现取。网关 key 会换，账号会过期或被删，建会话时那份快照只用来写工具描述。 */
export interface AccountReadLive {
  readonly accounts: readonly AccountConfig[];
  readonly proxy: ConfigMessage["accountsProxy"];
  readonly gateway: ConfigMessage["modelGateway"];
}

/** 代理的平台根地址 30 秒超时，令牌端点再 10 秒，这边留出余量。 */
const TIMEOUT_MS = 60_000;
/** 和 Pi 自带的 read、bash 同一个上限。 */
export const ACCOUNT_READ_MAX_BYTES = DEFAULT_MAX_BYTES;
const REASON_MAX = 300;
/** 出错时只用正文拼一句原因，读这么多足够。 */
const ERROR_BODY_MAX = 16 * 1024;
/** UTF-8 一个码点最多 4 个字节。上限之外多读这么多，才知道回包是不是真的超了。 */
const UTF8_TAIL = 4;

export const readableAccounts = (accounts: readonly AccountConfig[]): readonly AccountConfig[] =>
  accounts.filter((account) => account.via === "api");

const PARAMS = Type.Object({
  accountId: Type.String({ description: "用哪个号的身份读，照工具描述里的 accountId 抄" }),
  path: Type.String({
    description:
      "平台接口的相对路径，可以带查询串。GitHub 如 repos/<owner>/<repo>/issues?state=open，X 如 2/tweets/search/recent?query=白泽",
  }),
});

const describe = (accounts: readonly AccountConfig[]): string => {
  const head =
    "以用户连上的 GitHub 或 X 账号的身份读平台接口，只读不写，经白泽控制面转发，回平台的原始回包（多半是 JSON）。" +
    "查 issue、看仓库、搜推文用它；发帖、评论、回复一律走 create_draft。" +
    "在电脑浏览器里登录的号读不了接口，但能起草，批了由电脑上的浏览器发。";
  if (accounts.length === 0) return `${head}\n现在没有接口授权的 GitHub 或 X 账号，要读就请用户去账号页连一个。`;
  return [
    `${head}\n能用的号：`,
    ...accounts.map((account) => `- ${accountLabel(account)}，accountId：${account.id}`),
  ].join("\n");
};

const listOf = (accounts: readonly AccountConfig[]): string =>
  accounts.length === 0
    ? "现在没有能读的接口授权 GitHub 或 X 账号"
    : `能读的号：${accounts.map((account) => `${accountLabel(account)}（${account.id}）`).join("、")}`;

/** 拼完再核对前缀：`..`、`%2e%2e`、反斜杠都由 URL 解析折掉，折完跳出这个账号的那一段就拒。 */
function proxyUrl(baseUrl: string, accountId: string, path: string): URL {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, "")}/${encodeURIComponent(accountId)}/`;
  const relative = path.trim().replace(/^\/+/, "");
  if (relative === "") throw new Error("path 是空的，写上平台接口的相对路径，比如 repos/<owner>/<repo>/issues");
  const target = new URL(`${base.origin}${prefix}${relative}`);
  if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) {
    throw new Error(`path「${path}」跳出了这个账号的接口范围，只写平台接口的相对路径`);
  }
  return target;
}

/** 代理自己的错误体是 `{ error }`，平台原样透过来的 403、404 是平台的形状：GitHub 带 message，X 带 detail 或 title。 */
function reasonOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      for (const key of ["error", "message", "detail", "title"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" && value !== "") return value;
      }
    }
  } catch {
    // 不是 JSON，下面原样截一段。
  }
  const text = body.trim();
  if (text === "") return "没有说明";
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

/** 从流里读到 max 加尾部余量就 cancel，平台回多大都不整个进内存。 */
async function readHead(
  response: Response,
  max: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= max + UTF8_TAIL) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length <= max) return { text: bytes.toString("utf8"), truncated: false };
  return { text: bytes.subarray(0, completeUtf8End(bytes, max)).toString("utf8"), truncated: true };
}

/** 不超过 end 的最后一个完整码点的结尾。从 end 往回跳过续字节找到起始字节，看它领的字节数装不装得下。 */
function completeUtf8End(bytes: Uint8Array, end: number): number {
  let start = end - 1;
  while (start > 0 && end - start < 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
  const lead = bytes[start] ?? 0;
  const length =
    lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return start + length <= end ? end : start;
}

export function createAccountReadTool(options: {
  /** 写进工具描述的那份。描述只在建会话时读一次，所以这份账号清单进了 Bot 的定义指纹。 */
  readonly described: readonly AccountConfig[];
  readonly live: () => AccountReadLive;
}): RunnerTool {
  return {
    name: ACCOUNT_READ_TOOL,
    label: "读 GitHub、X",
    description: describe(readableAccounts(options.described)),
    parameters: PARAMS,
    execute: async (_callId, raw, signal) => {
      const params = raw as Static<typeof PARAMS>;
      const live = options.live();
      const readable = readableAccounts(live.accounts);
      const account = readable.find((candidate) => candidate.id === params.accountId);
      if (account === undefined) {
        const other = live.accounts.find((candidate) => candidate.id === params.accountId);
        const why =
          other === undefined
            ? `没有 accountId 是「${params.accountId}」的账号`
            : `${accountLabel(other)} 不是接口授权的 GitHub 或 X 的号，这个工具读不了`;
        throw new Error(`${why}。${listOf(readable)}。`);
      }
      const url = proxyUrl(live.proxy.baseUrl, account.id, params.path);
      const label = `${accountLabel(account)}（accountId：${account.id}）`;

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${live.gateway.apiKey}` },
          redirect: "manual",
          signal:
            signal === undefined
              ? AbortSignal.timeout(TIMEOUT_MS)
              : AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        throw new Error(`连不上白泽的账号代理，没读成：${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
      if (response.status === 409) {
        await response.body?.cancel();
        throw new Error(`${label} 这个号登录过期了，去账号页重新授权。`);
      }
      if (!response.ok) {
        const { text } = await readHead(response, ERROR_BODY_MAX);
        throw new Error(`用 ${label} 读 ${params.path} 没成，账号代理回 ${response.status}：${reasonOf(text)}`);
      }
      const { text, truncated } = await readHead(response, ACCOUNT_READ_MAX_BYTES);
      if (text === "") return resultText("（平台回了空内容）");
      if (!truncated) return resultText(text);
      const limit = formatSize(ACCOUNT_READ_MAX_BYTES);
      return resultText(
        `${text}\n\n（已截断：回包超过 ${limit}，只给了前 ${limit}。要看后面的，用分页或更窄的查询再读。）`,
      );
    },
  };
}
