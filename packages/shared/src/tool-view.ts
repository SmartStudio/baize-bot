import { z } from "zod";
import { LiveId } from "./live-id.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue)]),
);

export const ToolView = z.discriminatedUnion("kind", [
  // note 是闸门给审批卡的补充说明（比如云电脑上 pip 装进工具箱），只在要问的时候带。
  z
    .object({ kind: z.literal("bash"), command: z.string(), note: z.string().optional(), raw: JsonValue.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("write"),
      path: z.string(),
      preview: z.array(z.string()).max(5),
      raw: JsonValue.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("edit"),
      path: z.string(),
      changedLines: z.number().int().nonnegative(),
      raw: JsonValue.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp"),
      server: z.string(),
      tool: z.string(),
      params: z.array(z.object({ key: z.string(), value: JsonValue }).strict()).max(3),
      raw: JsonValue.optional(),
    })
    .strict(),
  // 主助理拉的临时帮手（D6）。name 是帮手的称呼（资料员、翻译），task 是交给它的那句话；
  // status 是帮手会话本身的进度，和这条工具调用的 ToolCallStatus 分开，帮手跑完了工具调用才有结果。
  z
    .object({
      kind: z.literal("helper"),
      name: z.string().min(1).max(20),
      task: z.string().max(200),
      status: z.enum(["running", "done", "failed"]),
      raw: JsonValue.optional(),
    })
    .strict(),
  // Bot 请用户接手浏览器里的一页（登录墙、验证码）。liveId 对得上 live_session 推送里的那块画面。
  z.object({ kind: z.literal("takeover"), liveId: LiveId, reason: z.string(), raw: JsonValue.optional() }).strict(),
]);
export type ToolView = z.infer<typeof ToolView>;

function valueText(value: JsonValue): string {
  if (value === null) return "空";
  if (Array.isArray(value)) return value.map(valueText).join("、");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}=${valueText(item)}`)
      .join("、");
  }
  return String(value);
}

export function toolViewText(view: ToolView): string {
  switch (view.kind) {
    case "bash":
      return view.note === undefined ? `要执行 \`${view.command}\`` : `要执行 \`${view.command}\`，${view.note}`;
    case "write":
      return `要写 \`${view.path}\``;
    case "edit":
      return `要改 \`${view.path}\` 的 ${view.changedLines} 行`;
    case "mcp": {
      const action = `要用${view.server.length === 0 ? "工具服务" : view.server}的 ${view.tool}`;
      if (view.params.length === 0) return action;
      return `${action}，参数：${view.params.map(({ key, value }) => `${key}=${valueText(value)}`).join("、")}`;
    }
    case "helper":
      return view.task.length === 0 ? `拉临时帮手：${view.name}` : `拉临时帮手：${view.name}，${view.task}`;
    case "takeover":
      return `请你接手这一页：${view.reason}`;
  }
}
