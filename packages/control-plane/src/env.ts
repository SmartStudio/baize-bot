import type { GatewayModels } from "@baize/shared";
import { DEFAULT_GATEWAY_LIMITS, type GatewayLimits } from "./http/gateway-limits.js";
import { log, type LogFormat } from "./log.js";

const DEFAULT_DATABASE_URL = "postgres://baize:baize@localhost:5434/baize";
const DEFAULT_PORT = 3001;

export function databaseUrl(): string {
  return nonEmpty("DATABASE_URL") ?? DEFAULT_DATABASE_URL;
}

export function secureCookie(): boolean {
  return (process.env["COOKIE_SECURE"] ?? "") === "1";
}

/** 控制面前面有几层自己的反向代理。0 只认 socket 地址，见 http/auth-limits.ts 的 clientIp。 */
export function trustedProxyHops(): number {
  const raw = nonEmpty("TRUSTED_PROXY_HOPS");
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`TRUSTED_PROXY_HOPS 不是非负整数: ${raw}`);
  return parsed;
}

export function toolSecretKey(): string {
  const key = nonEmpty("TOOL_SECRET_KEY");
  if (key === null) throw new Error("TOOL_SECRET_KEY 没设，用 openssl rand -hex 32 生成一个");
  return key;
}

/** 账号凭据的钥匙没有开发默认值：令牌是真平台的，用一把人人知道的钥匙加密等于没加密。 */
export function credentialsKey(): string {
  const key = process.env["CREDENTIALS_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new Error("CREDENTIALS_KEY 没设，用 openssl rand -base64 32 生成一个");
  }
  return key;
}

export function logFormat(): LogFormat {
  const raw = nonEmpty("LOG_FORMAT");
  if (raw === null) return "json";
  if (raw !== "json" && raw !== "pretty") throw new Error(`LOG_FORMAT 只能是 json 或 pretty: ${raw}`);
  return raw;
}

export function port(): number {
  return parsePort(process.env["PORT"]);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT 不是合法端口: ${raw}`);
  }
  return parsed;
}

/**
 * 运行期配置。全部由 main.ts 从环境变量读出来交给 startServer，
 * 测试直接构造一份指向假上游，所以 src 里除了这个文件没有第二处读 process.env。
 */
export type RuntimeConfig = {
  /**
   * 只给 webBaseUrl 当回退。null 表示用实际监听的端口拼。
   * 电脑代理拿到的数据面地址不看它，拼在代理 hello 里自报的 controlOrigin 上。
   */
  readonly publicBaseUrl: string | null;
  /** 网关两个用途对应的真实上游模型名。 */
  readonly gatewayModels: GatewayModels;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly gatewayLimits: GatewayLimits;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
  /**
   * 浏览器打开 Web 的那个地址，`/api` 在它下面转给控制面。OAuth 回调和授权完跳回的页面都拼在它上面。
   * null 就用 publicBaseUrl，两个都没设就退到实际监听的 localhost 端口，只在本机开发时对。
   */
  readonly webBaseUrl: string | null;
  /** 发布器、账号代理和「我是谁」打的平台接口根地址。测试和实机验证指到假平台。X 的令牌端点也在 xApiBaseUrl 下。 */
  readonly githubApiBaseUrl: string;
  readonly xApiBaseUrl: string;
  readonly oauth: OAuthConfig;
  /** 设了才开 GET /metrics，抓取要带 Bearer 这个值。null 时那条路由回 404。 */
  readonly metricsToken: string | null;
};

/** GitHub App 换令牌必须带 secret。X 的公共客户端只靠 PKCE，没有 secret 也能跑。 */
export type OAuthConfig = {
  readonly github: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly x: { readonly clientId: string; readonly clientSecret: string | null } | null;
  /** GitHub 的授权页和令牌端点都在这下面。 */
  readonly githubOauthBaseUrl: string;
  /** X 的授权页在这下面，令牌端点在 xApiBaseUrl 下。 */
  readonly xOauthBaseUrl: string;
};

export const DEFAULT_GATEWAY_MODEL = "baize-default";
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_X_API_BASE_URL = "https://api.x.com";
export const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";
export const DEFAULT_X_OAUTH_BASE_URL = "https://x.com";

export function runtimeConfig(): RuntimeConfig {
  const gatewayModels = configuredGatewayModels();
  return {
    publicBaseUrl: nonEmpty("PUBLIC_BASE_URL"),
    gatewayModels,
    upstreamBaseUrl: nonEmpty("UPSTREAM_BASE_URL") ?? DEFAULT_UPSTREAM_BASE_URL,
    upstreamApiKey: upstreamApiKey(),
    gatewayLimits: {
      firstByteTimeoutMs: timeoutMs("GATEWAY_FIRST_BYTE_TIMEOUT_MS", DEFAULT_GATEWAY_LIMITS.firstByteTimeoutMs),
      totalTimeoutMs: timeoutMs("GATEWAY_TOTAL_TIMEOUT_MS", DEFAULT_GATEWAY_LIMITS.totalTimeoutMs),
      requestsPerMinute: positiveInteger("GATEWAY_REQUESTS_PER_MINUTE", DEFAULT_GATEWAY_LIMITS.requestsPerMinute),
      burst: positiveInteger("GATEWAY_BURST", DEFAULT_GATEWAY_LIMITS.burst),
    },
    priceInputPerM: price("PRICE_INPUT_PER_M"),
    priceOutputPerM: price("PRICE_OUTPUT_PER_M"),
    githubApiBaseUrl: nonEmpty("GITHUB_API_BASE_URL") ?? DEFAULT_GITHUB_API_BASE_URL,
    xApiBaseUrl: nonEmpty("X_API_BASE_URL") ?? DEFAULT_X_API_BASE_URL,
    webBaseUrl: nonEmpty("WEB_BASE_URL"),
    oauth: oauthConfig(),
    metricsToken: nonEmpty("METRICS_TOKEN"),
  };
}

function nonEmpty(name: string): string | null {
  const value = process.env[name]?.trim() ?? "";
  return value === "" ? null : value;
}

function oauthConfig(): OAuthConfig {
  const githubId = nonEmpty("GITHUB_APP_CLIENT_ID");
  const githubSecret = nonEmpty("GITHUB_APP_CLIENT_SECRET");
  if ((githubId === null) !== (githubSecret === null)) {
    throw new Error("GITHUB_APP_CLIENT_ID 和 GITHUB_APP_CLIENT_SECRET 要一起设");
  }
  const xId = nonEmpty("X_CLIENT_ID");
  const xSecret = nonEmpty("X_CLIENT_SECRET");
  if (xId === null && xSecret !== null) throw new Error("设了 X_CLIENT_SECRET 就要设 X_CLIENT_ID");
  return {
    github: githubId === null || githubSecret === null ? null : { clientId: githubId, clientSecret: githubSecret },
    x: xId === null ? null : { clientId: xId, clientSecret: xSecret },
    githubOauthBaseUrl: nonEmpty("GITHUB_OAUTH_BASE_URL") ?? DEFAULT_GITHUB_OAUTH_BASE_URL,
    xOauthBaseUrl: nonEmpty("X_OAUTH_BASE_URL") ?? DEFAULT_X_OAUTH_BASE_URL,
  };
}

function configuredGatewayModels(): GatewayModels {
  const configured = process.env["GATEWAY_MODELS"];
  const configuredLegacy = process.env["GATEWAY_MODEL"];
  if (
    configured !== undefined &&
    configured.trim() !== "" &&
    configuredLegacy !== undefined &&
    configuredLegacy.trim() !== ""
  ) {
    log.warn("GATEWAY_MODELS 和 GATEWAY_MODEL 同时设置，优先使用 GATEWAY_MODELS");
  }
  if (configured === undefined || configured.trim() === "") {
    const legacy =
      configuredLegacy === undefined || configuredLegacy.trim() === ""
        ? DEFAULT_GATEWAY_MODEL
        : configuredLegacy.trim();
    return { plan: legacy, fast: legacy };
  }

  let plan: string | undefined;
  let fast: string | undefined;
  for (const rawEntry of configured.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("GATEWAY_MODELS 格式不正确，应为 plan=模型,fast=模型");
    const purpose = entry.slice(0, separator).trim();
    const model = entry.slice(separator + 1).trim();
    if (purpose !== "plan" && purpose !== "fast") throw new Error(`GATEWAY_MODELS 包含未知用途：${purpose}`);
    if (model === "") throw new Error(`GATEWAY_MODELS 的 ${purpose} 模型不能为空`);
    if (purpose === "plan") {
      if (plan !== undefined) throw new Error("GATEWAY_MODELS 重复配置 plan 用途");
      plan = model;
    } else {
      if (fast !== undefined) throw new Error("GATEWAY_MODELS 重复配置 fast 用途");
      fast = model;
    }
  }
  if (plan === undefined) throw new Error("GATEWAY_MODELS 缺少 plan 用途配置");
  if (fast === undefined) throw new Error("GATEWAY_MODELS 缺少 fast 用途配置");
  return { plan, fast };
}

function upstreamApiKey(): string {
  const value = process.env["UPSTREAM_API_KEY"] ?? "";
  if (/[^\x20-\x7e]/u.test(value)) {
    throw new Error("UPSTREAM_API_KEY 只能包含可打印 ASCII 字符，因为它会写入 HTTP Authorization 请求头");
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = nonEmpty(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 不是正整数: ${raw}`);
  return parsed;
}

// setTimeout 放不下超过 2^31-1 毫秒的值，Node 会把它当成 1 毫秒，每个请求立刻 504
const MAX_TIMEOUT_MS = 2_147_483_647;

function timeoutMs(name: string, fallback: number): number {
  const value = positiveInteger(name, fallback);
  if (value > MAX_TIMEOUT_MS) throw new Error(`${name} 超过 ${MAX_TIMEOUT_MS} 毫秒（约 24.8 天）: ${value}`);
  return value;
}

function price(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} 不是非负数: ${raw}`);
  return parsed;
}
