import type { ControlOrigin } from "@baize/shared";
import { ACCOUNTS_PROXY_PATH } from "../http/accounts-proxy.js";
import { GATEWAY_PATH } from "../http/gateway.js";
import { HUB_PATH } from "../http/hub.js";
import { MCP_PROXY_PATH } from "../http/mcp-proxy.js";

export interface DataPlaneUrls {
  readonly mcpProxy: string;
  readonly hub: string;
  readonly modelGateway: string;
  readonly accountsProxy: string;
}

/**
 * config 下发的四个数据面地址只从这里拼。四个必须同源：运行器的 recall 取 modelGateway 的源去访问 /hub/v1。
 * 源取代理在 hello 里自报的、它已经连通的那个，不读 Host 头，反代会改写它。
 */
export function dataPlaneUrls(origin: ControlOrigin): DataPlaneUrls {
  return {
    mcpProxy: `${origin}${MCP_PROXY_PATH}`,
    hub: `${origin}${HUB_PATH}`,
    modelGateway: `${origin}${GATEWAY_PATH}`,
    accountsProxy: `${origin}${ACCOUNTS_PROXY_PATH}`,
  };
}
