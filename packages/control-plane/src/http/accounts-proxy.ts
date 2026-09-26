import { AccountId, OAuthPlatform } from "@baize/shared";
import { Hono } from "hono";
import { expireLogin } from "../account-expiry.js";
import type { AccessToken, AccountTokens } from "../credentials.js";
import { apiBaseUrl, apiHeaders, type OAuthEndpoints } from "../oauth-providers.js";
import type { SettleDeps } from "../publish/settle.js";
import { findAccount } from "../repo/accounts.js";
import { findComputerByGatewayKey } from "../repo/computers.js";
import { bearerToken } from "./gateway.js";

export const ACCOUNTS_PROXY_PATH = "/accounts-proxy";

export type AccountsProxyDeps = SettleDeps & { readonly tokens: AccountTokens; readonly endpoints: OAuthEndpoints };

// 和网关一样用白名单：平台的 set-cookie、会话标识这类头不该漏给电脑。
const FORWARDED_HEADERS = new Set(["content-type", "etag", "last-modified", "link", "cache-control"]);
const TIMEOUT_MS = 30_000;
/**
 * 代理替换令牌要把正文整个读进内存，所以设个上限。运行器只给模型看前 50KB，1MB 留足了分页接口的余量，
 * 又不会让一个超大回包把控制面的内存吃满。
 */
export const ACCOUNTS_PROXY_MAX_BYTES = 1024 * 1024;
/** 正文超过上限被截断时带这个头，值是 true。 */
export const TRUNCATED_HEADER = "x-baize-truncated";
const REDACTED = "[已隐藏]";
const NO_ACCOUNT = { error: "没有这个账号" } as const;
const LOGIN_EXPIRED = { error: "这个账号登录过期了，到账号页重新连一下" } as const;

/**
 * Bot 读 GitHub、X 走这里：电脑拿网关 key 认身份，控制面换上平台令牌转出去。令牌只在控制面解密，
 * 电脑上跑的是 Bot 写的命令，令牌落到那边就等于交给了模型。只放读，写一律走草稿和审批。
 */
export function createAccountsProxy(deps: AccountsProxyDeps): Hono {
  const app = new Hono();

  app.all("/:accountId/*", async (c) => {
    const key = bearerToken(c.req.header("authorization"));
    const computer = key === null ? null : await findComputerByGatewayKey(deps.db, key);
    if (computer === null) return c.json({ error: "网关 key 不对，换一把再来" }, 401);
    if (c.req.method !== "GET") return c.json({ error: "代理只读，发东西走草稿" }, 405);

    const accountId = AccountId.safeParse(c.req.param("accountId"));
    const account = accountId.success ? await findAccount(deps.db, computer.ownerId, accountId.data) : null;
    const platform = OAuthPlatform.safeParse(account?.platform);
    if (account === null || !platform.success) return c.json(NO_ACCOUNT, 404);
    if (account.login !== "valid") return c.json(LOGIN_EXPIRED, 409);

    // 拼完再核对 origin 和根路径前缀，Bot 用 .. 跳不出平台根地址。路径用原样的，%2F 留在一段里原样交给平台。
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`${ACCOUNTS_PROXY_PATH}/${c.req.param("accountId")}`.length);
    const base = new URL(apiBaseUrl(platform.data, deps.endpoints));
    const root = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    const target = new URL(`${base.origin}${root}${rest.replace(/^\//, "")}${url.search}`);
    if (target.origin !== base.origin || !target.pathname.startsWith(root)) {
      return c.json({ error: "路径不对" }, 400);
    }
    const accept = c.req.header("accept");

    // 这次请求用过的每一把令牌。平台可能把收到的 Authorization 回显在正文里，交给电脑之前都要换掉。
    const used: string[] = [];
    let rejected: string | null = null;
    for (;;) {
      let token: AccessToken;
      try {
        token = await deps.tokens.accessToken(account.id, rejected);
      } catch (error) {
        console.error(`账号 ${account.id} 取令牌出错`, error);
        return c.json({ error: "连不上平台换令牌，稍后再试" }, 502);
      }
      if (token.kind === "login_expired") {
        await expireLogin(deps, computer.ownerId, account.id, { generation: token.generation });
        return c.json(LOGIN_EXPIRED, 409);
      }

      used.push(token.token);
      const headers: Record<string, string> = { ...apiHeaders(platform.data), authorization: `Bearer ${token.token}` };
      if (accept !== undefined) headers["accept"] = accept;
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          headers,
          signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) throw error;
        return c.json({ error: `连不上平台，${String(error)}` }, 502);
      }

      // 401 是平台不认这个令牌：强制刷新一次再试，还不认才记过期。403 多半是这个号没权限读那个资源，原样交给 Bot。
      if (upstream.status === 401) {
        await upstream.body?.cancel();
        if (rejected !== null) {
          await expireLogin(deps, computer.ownerId, account.id, { generation: token.generation });
          return c.json(LOGIN_EXPIRED, 409);
        }
        rejected = token.token;
        continue;
      }
      return forward(upstream, used);
    }
  });

  return app;
}

async function forward(upstream: Response, tokens: readonly string[]): Promise<Response> {
  const secrets = secretMatcher(tokens);
  const forwarded = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    // 头值只能是 ASCII，中文的替换值塞不进去；命中令牌的头整个不给。
    if ((FORWARDED_HEADERS.has(lower) || lower.startsWith("x-ratelimit-")) && !secrets.occursIn(value)) {
      forwarded.set(name, value);
    }
  }
  const read = await readCapped(upstream, ACCOUNTS_PROXY_MAX_BYTES);
  let body = secrets.redact(read.bytes);
  if (read.truncated) {
    // 上限可能正好落在一把令牌（或它的某种写法）中间，截下来的前半截没法整把匹配，只能连它一起去掉。
    body = body.subarray(0, body.length - secrets.partialTail(body, read.beyond));
    forwarded.set(TRUNCATED_HEADER, "true");
  }
  return new Response(upstream.body === null ? null : new Uint8Array(body), {
    status: upstream.status,
    headers: forwarded,
  });
}

/** truncated 时 beyond 是上限之后已经读到的那一截，只用来看截断处是不是真有令牌接着往下写。 */
export type CappedBody =
  | { readonly truncated: false; readonly bytes: Buffer }
  | { readonly truncated: true; readonly bytes: Buffer; readonly beyond: Buffer };

/** 读到超过上限就停。 */
export async function readCapped(response: Response, max: number): Promise<CappedBody> {
  if (response.body === null) return { truncated: false, bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > max) {
        await reader.cancel();
        const all = Buffer.concat(chunks);
        return { truncated: true, bytes: all.subarray(0, max), beyond: all.subarray(max) };
      }
    }
    return { truncated: false, bytes: Buffer.concat(chunks) };
  } finally {
    reader.releaseLock();
  }
}

/** 一个位置上允许出现的字节。 */
type Atom = readonly number[];
/** 令牌里一个字符的一种写法。 */
type Form = readonly Atom[];
/** 一把令牌：每个字符的全部等价写法。 */
type Spelling = readonly (readonly Form[])[];

const PERCENT = 0x25;
const BACKSLASH = 0x5c;
const JSON_SHORT_ESCAPES = new Set(["/", '"', "\\"]);

/** 十六进制一位，字母大小写都算。 */
const hexDigit = (value: number): Atom => {
  const upper = value.toString(16).toUpperCase().charCodeAt(0);
  const lower = value.toString(16).charCodeAt(0);
  return upper === lower ? [upper] : [upper, lower];
};

/**
 * 一个字符在正文里可能的样子：原样；URL 百分号编码（按 UTF-8 逐字节，十六进制不分大小写）；
 * JSON 的 \/、\"、\\ 短转义；JSON 的 \uXXXX（码元逐个，十六进制不分大小写）。
 */
function formsOf(char: string): Form[] {
  const utf8 = [...Buffer.from(char, "utf8")];
  const forms: Form[] = [
    utf8.map((byte) => [byte]),
    utf8.flatMap((byte) => [[PERCENT], hexDigit(byte >> 4), hexDigit(byte & 0xf)]),
  ];
  if (JSON_SHORT_ESCAPES.has(char)) forms.push([[BACKSLASH], [char.charCodeAt(0)]]);
  const unicode: Atom[] = [];
  for (let i = 0; i < char.length; i++) {
    const unit = char.charCodeAt(i);
    unicode.push([BACKSLASH], [0x75], ...[12, 8, 4, 0].map((shift) => hexDigit((unit >> shift) & 0xf)));
  }
  forms.push(unicode);
  return forms;
}

const atomSource = (atom: Atom): string => {
  const bytes = atom.map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
  return atom.length === 1 ? bytes : `[${bytes}]`;
};

const spellingSource = (spelling: Spelling): string =>
  spelling.map((forms) => `(?:${forms.map((form) => form.map(atomSource).join("")).join("|")})`).join("");

/** text 从头起能不能是这把令牌的某种写法：整把写完了，或者写到一半 text 就到头了。 */
function startsSpelling(text: string, spelling: Spelling, at = 0, char = 0): boolean {
  if (at === text.length) return true;
  const forms = spelling[char];
  if (forms === undefined) return true;
  return forms.some((form) => {
    let pos = at;
    for (const atom of form) {
      if (pos === text.length) return true;
      if (!atom.includes(text.charCodeAt(pos))) return false;
      pos += 1;
    }
    return startsSpelling(text, spelling, pos, char + 1);
  });
}

/**
 * 这次用过的令牌在正文和头里的所有写法。不枚举整串的写法，而是逐字符允许等价形态，
 * 所以大小写混写、一半编码一半原样这类组合一次都覆盖。按字节匹配：正文先当 latin1 看，一个字节一个字符。
 */
function secretMatcher(tokens: readonly string[]) {
  const spellings = [...new Set(tokens)]
    .filter((token) => token !== "")
    // 一把是另一把开头时先试长的，免得短的先匹配上、把长的剩一截露出去。
    .toSorted((a, b) => b.length - a.length)
    .map((token): Spelling => [...token].map(formsOf));
  const longest = Math.max(
    0,
    ...spellings.map((spelling) =>
      spelling.reduce((sum, forms) => sum + Math.max(...forms.map((form) => form.length)), 0),
    ),
  );
  const source = spellings.map(spellingSource).join("|");
  const pattern = source === "" ? null : new RegExp(source, "g");
  const replacement = Buffer.from(REDACTED, "utf8").toString("latin1");
  return {
    redact(bytes: Buffer): Buffer {
      if (pattern === null) return bytes;
      return Buffer.from(bytes.toString("latin1").replace(pattern, replacement), "latin1");
    },
    /** 头值是按字节解出来的 ByteString，和正文同一种看法。 */
    occursIn(value: string): boolean {
      return pattern !== null && value.search(pattern) !== -1;
    },
    /**
     * 结尾有多长是某把令牌某种写法被截断的前半截。接上上限之后读到的 beyond 一起看，接不成令牌的就不算；
     * beyond 不够长、看不出接不接得成的，按接得成算。
     */
    partialTail(body: Buffer, beyond: Buffer): number {
      const text = body.toString("latin1");
      const next = beyond.subarray(0, longest).toString("latin1");
      for (let length = Math.min(longest - 1, text.length); length > 0; length--) {
        const tail = text.slice(text.length - length) + next;
        if (spellings.some((spelling) => startsSpelling(tail, spelling))) return length;
      }
      return 0;
    },
  };
}
