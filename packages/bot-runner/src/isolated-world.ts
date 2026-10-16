/** 发到某一个标签页 session 上的 CDP 命令。 */
export type SessionSend = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

const WORLD_NAME = "baize";

/**
 * 在主框架的隔离世界里跑 Runtime.evaluate，回 Chrome 的原样应答。隔离世界和页面共用 DOM，全局和原型各是一份：
 * 页面脚本钩了 querySelector 之类的，看不到这次调用。
 * 每次现建，不缓存 contextId：同一 session、同一份文档、同一个名字 Chrome 回同一个世界，不会越建越多，页跳走了
 * 拿到的就是新文档上的；缓存的 id 在跨进程导航后会撞上新进程从头排的编号，可能落进别的上下文。
 * 页面正跳转时会报 Cannot find context，调用方当这一轮没查到。
 */
export async function evaluateIsolated(
  send: SessionSend,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tree = (await send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: unknown } } };
  const frameId = tree.frameTree?.frame?.id;
  if (typeof frameId !== "string") throw new Error("助理 Chrome 没有回主框架");
  const created = await send("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME });
  const contextId = created.executionContextId;
  if (typeof contextId !== "number") throw new Error("助理 Chrome 没有建出隔离世界");
  return send("Runtime.evaluate", { ...params, contextId });
}
