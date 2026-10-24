import { afterEach, expect, it, vi } from "vitest";
import { CredentialCrypto } from "../src/credentials.js";
import { DEFAULT_GATEWAY_LIMITS } from "../src/http/gateway-limits.js";
import {
  DEFAULT_GATEWAY_MODEL,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_BASE_URL,
  DEFAULT_UPSTREAM_BASE_URL,
  DEFAULT_X_API_BASE_URL,
  DEFAULT_X_OAUTH_BASE_URL,
  credentialsKey,
  runtimeConfig,
  trustedProxyHops,
} from "../src/env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("启动时拒绝含中文的 UPSTREAM_API_KEY，接受可打印 ASCII", () => {
  vi.stubEnv("UPSTREAM_API_KEY", "sk-中文");
  expect(runtimeConfig).toThrowError(
    "UPSTREAM_API_KEY 只能包含可打印 ASCII 字符，因为它会写入 HTTP Authorization 请求头",
  );

  vi.stubEnv("UPSTREAM_API_KEY", "sk-printable_123-~");
  expect(runtimeConfig().upstreamApiKey).toBe("sk-printable_123-~");
});

it("按用途解析 GATEWAY_MODELS", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=gpt-plan,fast=gpt-fast");

  expect(runtimeConfig().gatewayModels).toEqual({ plan: "gpt-plan", fast: "gpt-fast" });
});

it("GATEWAY_MODELS 缺用途时启动失败", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=gpt-plan");

  expect(runtimeConfig).toThrowError("GATEWAY_MODELS 缺少 fast 用途配置");
});

it("GATEWAY_MODELS 和旧变量同时设置时告警并优先使用新变量", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=gpt-plan,fast=gpt-fast");
  vi.stubEnv("GATEWAY_MODEL", "legacy-model");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(runtimeConfig().gatewayModels).toEqual({ plan: "gpt-plan", fast: "gpt-fast" });
  expect(warning).toHaveBeenCalledWith("GATEWAY_MODELS 和 GATEWAY_MODEL 同时设置，优先使用 GATEWAY_MODELS");
});

it("GATEWAY_MODELS 只有空白时回退到 trim 后的旧变量", () => {
  vi.stubEnv("GATEWAY_MODELS", " \t\n");
  vi.stubEnv("GATEWAY_MODEL", "  legacy-model  ");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

  expect(runtimeConfig().gatewayModels).toEqual({ plan: "legacy-model", fast: "legacy-model" });
  expect(warning).not.toHaveBeenCalled();
});

it("GATEWAY_MODELS 的未知用途使用中文全角冒号", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=gpt-plan,other=gpt-other,fast=gpt-fast");

  expect(runtimeConfig).toThrowError("GATEWAY_MODELS 包含未知用途：other");
});

it("GATEWAY_MODELS 拒绝重复用途", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=gpt-plan,plan=gpt-plan-2,fast=gpt-fast");

  expect(runtimeConfig).toThrowError("GATEWAY_MODELS 重复配置 plan 用途");
});

it("GATEWAY_MODELS 拒绝空模型", () => {
  vi.stubEnv("GATEWAY_MODELS", "plan=,fast=gpt-fast");

  expect(runtimeConfig).toThrowError("GATEWAY_MODELS 的 plan 模型不能为空");
});

it("只有旧的 GATEWAY_MODEL 时两个用途都回退到旧值", () => {
  vi.stubEnv("GATEWAY_MODEL", "legacy-model");

  expect(runtimeConfig().gatewayModels).toEqual({ plan: "legacy-model", fast: "legacy-model" });
});

it("两个网关变量都为空时保留开发默认值", () => {
  vi.stubEnv("GATEWAY_MODELS", "");
  vi.stubEnv("GATEWAY_MODEL", "");

  expect(runtimeConfig().gatewayModels).toEqual({ plan: DEFAULT_GATEWAY_MODEL, fast: DEFAULT_GATEWAY_MODEL });
});

it("CREDENTIALS_KEY 没设或不是 32 字节的 base64 时启动失败", () => {
  vi.stubEnv("CREDENTIALS_KEY", undefined);
  expect(credentialsKey).toThrowError("CREDENTIALS_KEY 没设，用 openssl rand -base64 32 生成一个");

  const wrong = "CREDENTIALS_KEY 必须是 32 字节的 base64，用 openssl rand -base64 32 生成";
  expect(() => new CredentialCrypto(Buffer.alloc(16, 1).toString("base64"))).toThrowError(wrong);
  expect(() => new CredentialCrypto(`${Buffer.alloc(32, 1).toString("base64")}!`)).toThrowError(wrong);

  const key = Buffer.alloc(32, 1).toString("base64");
  vi.stubEnv("CREDENTIALS_KEY", key);
  const crypto = new CredentialCrypto(credentialsKey());
  const sealed = crypto.encrypt("ghp_secret");
  expect(sealed).not.toContain("ghp_secret");
  expect(crypto.decrypt(sealed)).toBe("ghp_secret");
  expect(() => new CredentialCrypto(Buffer.alloc(32, 2).toString("base64")).decrypt(sealed)).toThrowError();
});

it("GitHub 和 X 的接口根地址取环境变量，没设用官方地址", () => {
  vi.stubEnv("GITHUB_API_BASE_URL", undefined);
  vi.stubEnv("X_API_BASE_URL", undefined);
  expect(runtimeConfig()).toMatchObject({
    githubApiBaseUrl: "https://api.github.com",
    xApiBaseUrl: "https://api.x.com",
  });

  vi.stubEnv("GITHUB_API_BASE_URL", "http://127.0.0.1:9/github");
  vi.stubEnv("X_API_BASE_URL", "http://127.0.0.1:9/x");
  expect(runtimeConfig()).toMatchObject({
    githubApiBaseUrl: "http://127.0.0.1:9/github",
    xApiBaseUrl: "http://127.0.0.1:9/x",
  });
});

it("OAuth 变量：GitHub 两个要一起设，X 可以只设 client id，WEB_BASE_URL 单独读", () => {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "gh-id");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
  expect(runtimeConfig).toThrowError("GITHUB_APP_CLIENT_ID 和 GITHUB_APP_CLIENT_SECRET 要一起设");

  vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "gh-secret");
  expect(runtimeConfig).toThrowError("GITHUB_APP_CLIENT_ID 和 GITHUB_APP_CLIENT_SECRET 要一起设");

  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
  vi.stubEnv("X_CLIENT_SECRET", "x-secret");
  expect(runtimeConfig).toThrowError("设了 X_CLIENT_SECRET 就要设 X_CLIENT_ID");

  vi.stubEnv("GITHUB_APP_CLIENT_ID", "gh-id");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "gh-secret");
  vi.stubEnv("X_CLIENT_ID", "x-id");
  vi.stubEnv("X_CLIENT_SECRET", "  ");
  vi.stubEnv("WEB_BASE_URL", "https://bot.example.com");
  vi.stubEnv("GITHUB_OAUTH_BASE_URL", "http://127.0.0.1:9/github-oauth");
  const config = runtimeConfig();
  expect(config.webBaseUrl).toBe("https://bot.example.com");
  expect(config.oauth).toEqual({
    github: { clientId: "gh-id", clientSecret: "gh-secret" },
    x: { clientId: "x-id", clientSecret: null },
    githubOauthBaseUrl: "http://127.0.0.1:9/github-oauth",
    xOauthBaseUrl: "https://x.com",
  });
});

it("没配 OAuth 变量时两个平台都是 null，WEB_BASE_URL 留空就是 null", () => {
  for (const name of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "X_CLIENT_ID",
    "X_CLIENT_SECRET",
    "WEB_BASE_URL",
  ]) {
    vi.stubEnv(name, "");
  }
  const config = runtimeConfig();
  expect(config.webBaseUrl).toBeNull();
  expect([config.oauth.github, config.oauth.x]).toEqual([null, null]);
});

it(".env 里留空的地址按没设处理，不把空串下发成网关地址", () => {
  for (const name of [
    "PUBLIC_BASE_URL",
    "UPSTREAM_BASE_URL",
    "GITHUB_API_BASE_URL",
    "X_API_BASE_URL",
    "GITHUB_OAUTH_BASE_URL",
    "X_OAUTH_BASE_URL",
  ]) {
    vi.stubEnv(name, "");
  }

  const config = runtimeConfig();
  expect(config.publicBaseUrl).toBeNull();
  expect(config.upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
  expect(config.githubApiBaseUrl).toBe(DEFAULT_GITHUB_API_BASE_URL);
  expect(config.xApiBaseUrl).toBe(DEFAULT_X_API_BASE_URL);
  expect(config.oauth.githubOauthBaseUrl).toBe(DEFAULT_GITHUB_OAUTH_BASE_URL);
  expect(config.oauth.xOauthBaseUrl).toBe(DEFAULT_X_OAUTH_BASE_URL);
});

it("TRUSTED_PROXY_HOPS 留空是 0，只收非负整数", () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "");
  expect(trustedProxyHops()).toBe(0);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  expect(trustedProxyHops()).toBe(1);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "-1");
  expect(trustedProxyHops).toThrowError("TRUSTED_PROXY_HOPS 不是非负整数: -1");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "yes");
  expect(trustedProxyHops).toThrowError("TRUSTED_PROXY_HOPS 不是非负整数: yes");
});

it("网关超时和限速取环境变量，没设用默认值，只收正整数，超时不超过 setTimeout 的上限", () => {
  for (const name of [
    "GATEWAY_FIRST_BYTE_TIMEOUT_MS",
    "GATEWAY_TOTAL_TIMEOUT_MS",
    "GATEWAY_REQUESTS_PER_MINUTE",
    "GATEWAY_BURST",
  ])
    vi.stubEnv(name, "");
  expect(runtimeConfig().gatewayLimits).toEqual(DEFAULT_GATEWAY_LIMITS);

  vi.stubEnv("GATEWAY_FIRST_BYTE_TIMEOUT_MS", "30000");
  vi.stubEnv("GATEWAY_TOTAL_TIMEOUT_MS", "900000");
  vi.stubEnv("GATEWAY_REQUESTS_PER_MINUTE", "60");
  vi.stubEnv("GATEWAY_BURST", "10");
  expect(runtimeConfig().gatewayLimits).toEqual({
    firstByteTimeoutMs: 30_000,
    totalTimeoutMs: 900_000,
    requestsPerMinute: 60,
    burst: 10,
  });

  vi.stubEnv("GATEWAY_BURST", "0");
  expect(runtimeConfig).toThrowError("GATEWAY_BURST 不是正整数: 0");
  vi.stubEnv("GATEWAY_BURST", "10");
  vi.stubEnv("GATEWAY_TOTAL_TIMEOUT_MS", "10m");
  expect(runtimeConfig).toThrowError("GATEWAY_TOTAL_TIMEOUT_MS 不是正整数: 10m");
  vi.stubEnv("GATEWAY_TOTAL_TIMEOUT_MS", "2147483647");
  expect(runtimeConfig().gatewayLimits.totalTimeoutMs).toBe(2_147_483_647);
  vi.stubEnv("GATEWAY_TOTAL_TIMEOUT_MS", "3000000000");
  expect(runtimeConfig).toThrowError("GATEWAY_TOTAL_TIMEOUT_MS 超过 2147483647 毫秒（约 24.8 天）: 3000000000");
  vi.stubEnv("GATEWAY_TOTAL_TIMEOUT_MS", "900000");
  vi.stubEnv("GATEWAY_FIRST_BYTE_TIMEOUT_MS", "2147483648");
  expect(runtimeConfig).toThrowError("GATEWAY_FIRST_BYTE_TIMEOUT_MS 超过 2147483647 毫秒（约 24.8 天）: 2147483648");
});
