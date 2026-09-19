import { afterEach, expect, it, vi } from "vitest";
import { runtimeConfig } from "../src/env.js";

afterEach(() => vi.unstubAllEnvs());

it("启动时拒绝含中文的 UPSTREAM_API_KEY，接受可打印 ASCII", () => {
  vi.stubEnv("UPSTREAM_API_KEY", "sk-中文");
  expect(runtimeConfig).toThrowError(
    "UPSTREAM_API_KEY 只能包含可打印 ASCII 字符，因为它会写入 HTTP Authorization 请求头",
  );

  vi.stubEnv("UPSTREAM_API_KEY", "sk-printable_123-~");
  expect(runtimeConfig().upstreamApiKey).toBe("sk-printable_123-~");
});
