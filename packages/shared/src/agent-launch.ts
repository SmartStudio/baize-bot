import { z } from "zod";
import { ComputerId } from "./domain.js";
import { ControlOrigin } from "./protocol.js";

export const AgentLaunch = z
  .object({
    url: z.string().min(1),
    computerId: ComputerId,
    token: z.string().min(1),
    dataDir: z.string().min(1),
  })
  .strict();
export type AgentLaunch = z.infer<typeof AgentLaunch>;

const HTTP_OF_WS: Readonly<Record<string, string>> = { "ws:": "http:", "wss:": "https:" };

/**
 * ws://主机:端口/agent 推出 http://主机:端口，wss 推出 https。代理没有另外的地址配置项，
 * 控制面的数据面地址就拼在代理已经连通的这个源上，所以反代改写 Host 头也不影响。
 */
export function controlOriginFromAgentUrl(url: string): ControlOrigin {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`连控制面的地址 ${url} 不是合法 URL`);
  }
  const protocol = HTTP_OF_WS[parsed.protocol];
  if (protocol === undefined) throw new Error(`连控制面的地址 ${url} 只能是 ws:// 或 wss://`);
  const origin = ControlOrigin.safeParse(`${protocol}//${parsed.host}`);
  if (!origin.success || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`连控制面的地址 ${url} 推不出控制面的源：不能带凭据，主机名不能超过 256 字`);
  }
  return origin.data;
}
