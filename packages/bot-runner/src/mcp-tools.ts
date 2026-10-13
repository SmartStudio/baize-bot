import {
  ApiError,
  describeMcpFailure,
  McpProxyCallResponse,
  redactCredential,
  type BotId,
  type ControlToAgent,
  type McpProxyCallRequest,
  type ToolConnectionConfig,
  type ToolOperation,
} from "@baize/shared";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import type { RunnerTool } from "./bot-session.js";

// 只在本机的连接才建 MCP Client，第一次调用它的工具时才连。连不上不抛：工具结果里放一句中文，
// Bot 转述给用户，比整次 run 崩掉强。连接、协议这类错误只给固定的中文分类，不带对端的原文：对端能把收到的凭据
// 以任意编码写进报错。工具的正文（成功的和 isError 的）是对端的业务输出，原样进模型，只换掉凭据的原文、
// 百分号编码和 JSON 转义三种写法，别的编码不保证。

/**
 * 会话里注册的 MCP 工具按最新下发的 config 能不能用。工具表在会话建好时就定了，config 中途换了，
 * 旧会话里的工具还在，闸门和执行都要以最新的连接和操作表为准。
 */
export type McpCallable =
  | { readonly kind: "ready"; readonly connection: ToolConnectionConfig; readonly operation: ToolOperation }
  | { readonly kind: "awaiting_authorization"; readonly connection: ToolConnectionConfig }
  | { readonly kind: "withdrawn"; readonly connectionName: string };

export interface McpToolSet {
  readonly tools: readonly RunnerTool[];
  serverFor(toolName: string): string;
  /** 不是这一组注册的 MCP 工具回 null。 */
  resolve(toolName: string): McpCallable | null;
  close(): Promise<void>;
}

/** 用不了的时候给模型的那句话。闸门在审批之前拒，执行时再拒一次。 */
export function unusableReason(callable: Exclude<McpCallable, { kind: "ready" }>): string {
  switch (callable.kind) {
    case "awaiting_authorization":
      return `工具连接「${callable.connection.name}」还没补授权，这个操作现在用不了。请到插件页给它补上授权，取回真实的操作表之后再用。`;
    case "withdrawn":
      return `工具连接「${callable.connectionName}」已经不再提供这个操作，或者不再分配给这个 Bot，这次没有执行。`;
  }
}

/** 一次共享的连接：几条工具调用一起等同一个 initialize，谁的 signal 先响就把它整个撤掉。 */
interface Pending {
  readonly client: Promise<Client>;
  readonly control: AbortController;
  settled: boolean;
}

interface Link {
  /** 换了凭据就换成最新的一份，旧的 client 随之作废。 */
  connection: Extract<ToolConnectionConfig, { localOnly: true }>;
  /** 正在连或已经连上的 client。连失败或被撤就清回 null，下一次调用再连。 */
  pending: Pending | null;
}

type ConfigMessage = Extract<ControlToAgent, { type: "config" }>;

/** 网关 key 和代理地址随 config 更新，每次调用现取。 */
export interface McpProxyLive {
  readonly proxy: ConfigMessage["mcpProxy"];
  readonly gateway: ConfigMessage["modelGateway"];
}

/** 控制面等上游最多 60 秒，这边留出回包余量。 */
const PROXY_TIMEOUT_MS = 65_000;

async function callProxy(
  connection: ToolConnectionConfig,
  request: McpProxyCallRequest,
  live: McpProxyLive,
  signal: AbortSignal | undefined,
): Promise<McpProxyCallResponse> {
  const url = `${live.proxy.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(connection.id)}/call`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${live.gateway.apiKey}` },
      body: JSON.stringify(request),
      redirect: "manual",
      signal:
        signal === undefined
          ? AbortSignal.timeout(PROXY_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(PROXY_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new Error(`工具连接「${connection.name}」连不上白泽工具代理：${describeMcpFailure(error)}`, {
      cause: error,
    });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiError.safeParse(body);
    const reason = parsed.success ? parsed.data.error : "没有返回错误说明";
    throw new Error(
      `工具「${request.tool}」调用失败，白泽工具代理回 ${response.status}：${redactCredential(reason, `Bearer ${live.gateway.apiKey}`)}`,
    );
  }
  const parsed = McpProxyCallResponse.safeParse(body);
  if (!parsed.success) throw new Error(`工具「${request.tool}」调用失败：白泽工具代理返回的内容格式不正确`);
  return parsed.data;
}

/**
 * Pi 自带工具的名字整组保留，不管这个 Bot 的会话实际装了哪几个：闸门按这些名字认运行器自己的工具，
 * 一个 MCP 操作叫 `write` 一旦注册成功，模型调 `write` 就走到了插件而闸门还按工作目录放行。
 * 名字从 Pi 导出的工厂拿，Pi 加工具这里跟着变；runner.test.ts 有一条用例拿它和 Pi 的 allToolNames 对账。
 */
export const PI_BUILT_IN_TOOLS: ReadonlySet<string> = new Set(
  [
    createReadToolDefinition,
    createBashToolDefinition,
    createPowerShellToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ].map((factory) => factory(process.cwd()).name),
);

/** config.tools 里分配给这个 Bot 的连接，保持 config 里的先后。 */
export function connectionsFor(botId: BotId, tools: readonly ToolConnectionConfig[]): readonly ToolConnectionConfig[] {
  return tools.filter((tool) => tool.assignedBotIds.includes(botId));
}

type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 上游模型认的图片格式，别的格式送过去整次请求会被拒。 */
const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 单张图的上限，按解码后的字节算。 */
const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const imageBlock = (data: string, mimeType: string): ResultBlock => {
  if (!MODEL_IMAGE_TYPES.has(mimeType)) {
    return {
      type: "text",
      text: `工具连接回了一张 ${mimeType} 的图模型看不了（只收 png、jpeg、gif、webp），没放进来。`,
    };
  }
  if (Buffer.byteLength(data, "base64") > MODEL_IMAGE_MAX_BYTES) {
    return {
      type: "text",
      text: `工具连接回了一张超过 ${MODEL_IMAGE_MAX_BYTES / 1024 / 1024} MiB 的图，太大没放进来。`,
    };
  }
  return { type: "image", data, mimeType };
};

/** MCP 结果里的 text 块原样进模型，image 块过一道格式和大小，资源这类块不进。SDK 已按协议校验过形状，这里只挑类型。 */
const blocksOf = (content: unknown): ResultBlock[] =>
  (Array.isArray(content) ? content : []).flatMap((block): ResultBlock[] => {
    if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return [imageBlock(block.data, block.mimeType)];
    }
    return [];
  });

const textOf = (blocks: readonly ResultBlock[]): string =>
  blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

async function connect(connection: Link["connection"], signal: AbortSignal): Promise<Client> {
  const client = new Client({ name: "baize-bot-runner", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(connection.url),
    connection.authorization === null ? {} : { requestInit: { headers: { Authorization: connection.authorization } } },
  );
  // SDK 1.30 的 StreamableHTTPClientTransport 把 sessionId 声明成 `string | undefined`，Transport 要的是可省属性，
  // exactOptionalPropertyTypes 下两者不相容，只能在这里转一次。
  // signal 只管 initialize 这一问：一响 SDK 就拒掉并自己关掉 transport，不等它 60 秒的请求超时。
  await client.connect(transport as unknown as Transport, { signal });
  return client;
}

const startConnect = (link: Link): Pending => {
  const control = new AbortController();
  const pending: Pending = { control, settled: false, client: connect(link.connection, control.signal) };
  pending.client.then(
    () => (pending.settled = true),
    () => {
      pending.settled = true;
      if (link.pending === pending) link.pending = null;
    },
  );
  link.pending = pending;
  return pending;
};

// initialize 回了之后再 abort，SDK 还会照发一条 cancelled 通知，所以只撤还没回的。
const cancelConnect = (pending: Pending): void => {
  if (!pending.settled) pending.control.abort();
};

const dropPending = async (pending: Pending | null): Promise<void> => {
  if (pending === null) return;
  cancelConnect(pending);
  const client = await pending.client.catch(() => null);
  await client?.close();
};

/** 拿连好的 client，没连就连。等 initialize 的时候 signal 一响，这次连接整个撤掉，本次调用当场结束。 */
const clientOf = (link: Link, signal: AbortSignal | undefined): Promise<Client> => {
  const pending = link.pending ?? startConnect(link);
  if (signal === undefined) return pending.client;
  const onAbort = (): void => cancelConnect(pending);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return pending.client.finally(() => signal.removeEventListener("abort", onAbort));
};

/**
 * 把分配给 Bot 的连接里的每个 operation 变成一个 Pi 工具。
 * 撞名先到先得：Pi 自带的名字、`reserved` 里已有的名字和前面连接已注册的名字都跳过，每个跳过 console.warn 一次。
 */
export function createMcpTools(options: {
  readonly botId: BotId;
  readonly connections: readonly ToolConnectionConfig[];
  readonly reserved: ReadonlySet<string>;
  /** 最新下发的 config 里分配给这个 Bot 的连接。 */
  readonly latest: () => readonly ToolConnectionConfig[];
  readonly liveProxy: () => McpProxyLive;
}): McpToolSet {
  const taken = new Set([...PI_BUILT_IN_TOOLS, ...options.reserved]);
  const links: Link[] = [];
  const tools: RunnerTool[] = [];
  const servers = new Map<string, string>();
  const registered = new Map<string, ToolConnectionConfig>();

  const resolveOn = (registeredOn: ToolConnectionConfig, toolName: string): McpCallable => {
    const connection = options.latest().find((one) => one.id === registeredOn.id);
    if (connection === undefined) return { kind: "withdrawn", connectionName: registeredOn.name };
    if (connection.status === "awaiting_authorization") return { kind: "awaiting_authorization", connection };
    const operation = connection.operations.find((one) => one.name === toolName);
    if (operation === undefined) return { kind: "withdrawn", connectionName: connection.name };
    return { kind: "ready", connection, operation };
  };
  const resolve = (toolName: string): McpCallable | null => {
    const registeredOn = registered.get(toolName);
    return registeredOn === undefined ? null : resolveOn(registeredOn, toolName);
  };

  for (const connection of options.connections) {
    let link: Link | null = null;
    for (const op of connection.operations) {
      if (taken.has(op.name)) {
        console.warn(`Bot ${options.botId}：连接「${connection.name}」的操作「${op.name}」和已注册的工具重名，跳过`);
        continue;
      }
      taken.add(op.name);
      servers.set(op.name, connection.name);
      registered.set(op.name, connection);
      tools.push({
        name: op.name,
        label: op.name,
        description: op.description,
        // 控制面已经按 ToolOperation 收过这份 JSON Schema，这里原样交给 Pi 校验参数，不再翻译一遍。
        parameters: Type.Unsafe<Record<string, unknown>>(op.inputSchema),
        execute: async (_callId, params, signal) => {
          const callable = resolveOn(connection, op.name);
          if (callable.kind !== "ready") throw new Error(unusableReason(callable));
          let result: Awaited<ReturnType<Client["callTool"]>> | McpProxyCallResponse;
          if (!callable.connection.localOnly) {
            result = await callProxy(
              callable.connection,
              { botId: options.botId, tool: op.name, arguments: params as Record<string, unknown> },
              options.liveProxy(),
              signal,
            );
          } else {
            if (link === null) {
              link = { connection: callable.connection, pending: null };
              links.push(link);
            } else if (
              callable.connection.authorization !== link.connection.authorization ||
              callable.connection.url !== link.connection.url
            ) {
              const stale = link.pending;
              link.pending = null;
              link.connection = callable.connection;
              await dropPending(stale);
            }
            let client: Client;
            try {
              client = await clientOf(link, signal);
            } catch (error) {
              return {
                content: [{ type: "text", text: `工具连接「${connection.name}」连不上：${describeMcpFailure(error)}` }],
                details: {},
              };
            }
            try {
              // 停机和暂停的 abort 顺着 signal 传给 MCP，服务端收到 cancelled 通知，这边不等它回。
              result = await client.callTool(
                { name: op.name, arguments: params as Record<string, unknown> },
                undefined,
                signal === undefined ? {} : { signal },
              );
            } catch (error) {
              throw new Error(`工具「${op.name}」调用失败：${describeMcpFailure(error)}`, { cause: error });
            }
          }
          const blocks = blocksOf(result.content).map((block) =>
            block.type === "text" && callable.connection.localOnly
              ? { type: "text" as const, text: redactCredential(block.text, callable.connection.authorization) }
              : block,
          );
          const text = textOf(blocks);
          if (result.isError === true) throw new Error(text === "" ? `工具「${op.name}」报错，没有说明` : text);
          return {
            content: blocks.length === 0 ? [{ type: "text", text: "（工具没有返回文字）" }] : blocks,
            details: {},
          };
        },
      });
    }
  }

  return {
    tools,
    serverFor: (toolName) => servers.get(toolName) ?? "",
    resolve,
    close: async () => {
      await Promise.all(
        links.map(async (link) => {
          const pending = link.pending;
          link.pending = null;
          await dropPending(pending);
        }),
      );
    },
  };
}
