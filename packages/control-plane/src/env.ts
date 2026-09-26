import type { GatewayModels } from "@baize/shared";

const DEFAULT_DATABASE_URL = "postgres://baize:baize@localhost:5434/baize";
const DEFAULT_PORT = 3001;
const DEV_TOOL_SECRET_KEY = "8f8d7b86df250e27ea4f1bb66c7f4dc57b75ad623154f343890a258d68d03c90";
let warnedToolSecret = false;

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

export function secureCookie(): boolean {
  return (process.env["COOKIE_SECURE"] ?? "") === "1";
}

export function toolSecretKey(): string {
  const key = process.env["TOOL_SECRET_KEY"];
  if (key !== undefined) return key;
  if (!warnedToolSecret) {
    console.warn("TOOL_SECRET_KEY 没设，工具认证信息用开发密钥加密");
    warnedToolSecret = true;
  }
  return DEV_TOOL_SECRET_KEY;
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
  /** 下发给电脑代理的模型网关地址前缀。null 表示用实际监听的端口拼。 */
  readonly publicBaseUrl: string | null;
  /** 网关两个用途对应的真实上游模型名。 */
  readonly gatewayModels: GatewayModels;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly priceInputPerM: number;
  readonly priceOutputPerM: number;
};

export const DEFAULT_GATEWAY_MODEL = "baize-default";
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.openai.com/v1";

export function runtimeConfig(): RuntimeConfig {
  const gatewayModels = configuredGatewayModels();
  return {
    publicBaseUrl: process.env["PUBLIC_BASE_URL"] ?? null,
    gatewayModels,
    upstreamBaseUrl: process.env["UPSTREAM_BASE_URL"] ?? DEFAULT_UPSTREAM_BASE_URL,
    upstreamApiKey: upstreamApiKey(),
    priceInputPerM: price("PRICE_INPUT_PER_M"),
    priceOutputPerM: price("PRICE_OUTPUT_PER_M"),
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
    console.warn("GATEWAY_MODELS 和 GATEWAY_MODEL 同时设置，优先使用 GATEWAY_MODELS");
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

function price(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} 不是非负数: ${raw}`);
  return parsed;
}
