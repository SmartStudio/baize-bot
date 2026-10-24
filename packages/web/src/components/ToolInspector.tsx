import { X } from "lucide-react";
import { useEscapeToClose } from "./useEscapeToClose.js";
import type { InspectedTool } from "./messages/MessageView.js";
import { ToolViewContent } from "./messages/ToolViewContent.js";

const rawText = (tool: InspectedTool): string =>
  tool.body.view.raw === undefined ? "没有原始参数" : JSON.stringify(tool.body.view.raw, null, 2);

type Props = { tool: InspectedTool; onClose: () => void; onEscape: (() => void) | null };

export const ToolInspector = ({ tool, onClose, onEscape }: Props) => {
  useEscapeToClose(onEscape);

  return (
    <aside className="tool-inspector" data-testid="tool-inspector" aria-label="工具检查器">
      <header className="tool-inspector-head">
        <h2>过程</h2>
        <button
          type="button"
          className="icon-button"
          data-testid="tool-inspector-close"
          aria-label="关闭工具检查器"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <section className="tool-inspector-summary" data-testid="tool-inspector-summary">
        <span>这一步</span>
        <strong>
          <ToolViewContent view={tool.body.view} />
        </strong>
      </section>
      <details className="tool-inspector-advanced">
        <summary data-testid="tool-inspector-advanced">高级</summary>
        <dl className="tool-inspector-meta">
          <div>
            <dt>runId</dt>
            <dd>{tool.body.runId}</dd>
          </div>
          <div>
            <dt>工具</dt>
            <dd>{tool.body.tool}</dd>
          </div>
        </dl>
        <pre data-testid="tool-inspector-raw">{rawText(tool)}</pre>
      </details>
    </aside>
  );
};
