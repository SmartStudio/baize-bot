import { z } from "zod";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValue), z.record(JsonValue)]),
);

export const ToolView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bash"), command: z.string(), raw: JsonValue.optional() }).strict(),
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
      return `要执行 \`${view.command}\``;
    case "write":
      return `要写 \`${view.path}\``;
    case "edit":
      return `要改 \`${view.path}\` 的 ${view.changedLines} 行`;
    case "mcp": {
      const action = `要用${view.server.length === 0 ? "工具服务" : view.server}的 ${view.tool}`;
      if (view.params.length === 0) return action;
      return `${action}，参数：${view.params.map(({ key, value }) => `${key}=${valueText(value)}`).join("、")}`;
    }
  }
}
