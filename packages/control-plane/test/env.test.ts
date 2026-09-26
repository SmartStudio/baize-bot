import { afterEach, expect, it, vi } from "vitest";
import { CredentialCrypto } from "../src/credentials.js";
import { DEFAULT_GATEWAY_MODEL, credentialsKey, runtimeConfig } from "../src/env.js";

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
