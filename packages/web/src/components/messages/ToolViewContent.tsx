import type { JsonValue, ToolView } from "@baize/shared";

const valueText = (value: JsonValue): string => {
  if (value === null) return "空";
  if (Array.isArray(value)) return value.map(valueText).join("、");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}=${valueText(item)}`)
      .join("、");
  }
  return String(value);
};

const McpParams = ({ params }: { params: Extract<ToolView, { kind: "mcp" }>["params"] }) =>
  params.length === 0 ? null : (
    <span className="tool-view-detail">{params.map(({ key, value }) => `${key}=${valueText(value)}`).join("、")}</span>
  );

export const ToolViewContent = ({ view, approval = false }: { view: ToolView; approval?: boolean }) => {
  switch (view.kind) {
    case "bash":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>{approval ? "要执行" : "执行"}</span>
          <code className="tool-view-code">{view.command}</code>
        </span>
      );
    case "write":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>{approval ? "要写" : "写入"}</span>
          <code className="tool-view-code">{view.path}</code>
          {view.preview.length === 0 ? null : <span className="tool-view-detail">{view.preview.join(" / ")}</span>}
        </span>
      );
    case "edit":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>{approval ? "要改" : "编辑"}</span>
          <code className="tool-view-code">{view.path}</code>
          <span className="tool-view-detail">
            {approval ? `${view.changedLines} 行` : `改 ${view.changedLines} 行`}
          </span>
        </span>
      );
    case "mcp":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>
            {approval ? "要用" : "调用"} {view.server.length === 0 ? "工具服务" : view.server} · {view.tool}
          </span>
          <McpParams params={view.params} />
        </span>
      );
    case "helper":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>
            {approval ? "要拉临时帮手" : "拉临时帮手"}：{view.name}
          </span>
          <span className="tool-view-detail">{view.task}</span>
        </span>
      );
  }
};
