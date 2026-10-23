import type { JsonValue, ToolConnection, ToolView } from "@baize/shared";

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

type McpView = Extract<ToolView, { kind: "mcp" }>;

// 参数名是 schema 里的英文标识符的，是给机器看的原样参数，审批卡上折进详情。运行器自己起的中文标签
// （助理浏览器的域名、元素、文字）本来就是写给人点头用的，留在外面。
const isRawKey = (key: string): boolean => /^[A-Za-z_][\w.-]*$/.test(key);

export const ApprovalDetails = ({ view }: { view: ToolView }) => {
  if (view.kind !== "mcp") return null;
  const raw = view.params.filter(({ key }) => isRawKey(key));
  return (
    <details className="approval-details" data-testid="approval-details">
      <summary>详情</summary>
      <code className="tool-view-code">{view.tool}</code>
      <McpParams params={raw} />
    </details>
  );
};

// 操作说明取工具连接里登记的那句，连接的名字就是 view.server。对不上（助理浏览器这类运行器自带的）只写连接名。
const operationText = (view: McpView, tools: ToolConnection[]): string =>
  tools.find((tool) => tool.name === view.server)?.operations.find((operation) => operation.name === view.tool)
    ?.description ?? "";

export const ToolViewContent = ({
  view,
  approval = false,
  tools = [],
}: {
  view: ToolView;
  approval?: boolean;
  tools?: ToolConnection[];
}) => {
  switch (view.kind) {
    case "bash":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>{approval ? "要执行" : "执行"}</span>
          <code className="tool-view-code">{view.command}</code>
          {view.note === undefined ? null : <span className="tool-view-detail">{view.note}</span>}
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
    case "mcp": {
      const server = view.server.length === 0 ? "工具服务" : view.server;
      if (approval) {
        return (
          <span className="tool-view-content" data-view-kind={view.kind}>
            <span>
              要用{server}
              {operationText(view, tools)}
            </span>
            <McpParams params={view.params.filter(({ key }) => !isRawKey(key))} />
          </span>
        );
      }
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>
            调用 {server} · {view.tool}
          </span>
          <McpParams params={view.params} />
        </span>
      );
    }
    case "helper":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>
            {approval ? "要拉临时帮手" : "拉临时帮手"}：{view.name}
          </span>
          <span className="tool-view-detail">{view.task}</span>
        </span>
      );
    case "takeover":
      return (
        <span className="tool-view-content" data-view-kind={view.kind}>
          <span>请你接手这一页</span>
          <span className="tool-view-detail">{view.reason}</span>
        </span>
      );
  }
};
