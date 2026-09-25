import { useEffect } from "react";
import { X } from "lucide-react";
import type { ToolView } from "@baize/shared";

const rawText = (view: ToolView): string =>
  view.raw === undefined ? "没有原始参数" : JSON.stringify(view.raw, null, 2);

export const ToolInspector = ({ view, onClose }: { view: ToolView; onClose: () => void }) => {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <aside className="tool-inspector" data-testid="tool-inspector" aria-label="工具检查器">
      <header className="tool-inspector-head">
        <h2>工具详情</h2>
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
      <details className="tool-inspector-advanced">
        <summary data-testid="tool-inspector-advanced">高级</summary>
        <pre data-testid="tool-inspector-raw">{rawText(view)}</pre>
      </details>
    </aside>
  );
};
