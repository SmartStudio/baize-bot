import { useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";
import { shortcutSections } from "./shortcuts.js";
import { trapTab } from "./trapTab.js";

type Props = { onClose: () => void };

export const ShortcutSheet = ({ onClose }: Props) => {
  const sheetRef = useRef<HTMLElement>(null);
  useEffect(() => sheetRef.current?.focus(), []);

  return (
    <div
      className="scrim quick-switch-scrim"
      data-testid="shortcut-sheet-scrim"
      // 按下的默认动作会在遮罩卸掉之后把焦点清到 body，盖过 RestoreFocus 还回去的那个。
      onMouseDown={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section
        ref={sheetRef}
        className="dialog shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        data-testid="shortcut-sheet"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          trapTab(event);
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <header className="dialog-head">
          <Keyboard size={20} aria-hidden="true" />
          <span>
            <b>快捷键</b>
          </span>
          <button
            type="button"
            className="icon-button shortcut-sheet-close"
            data-testid="shortcut-sheet-close"
            aria-label="关闭快捷键"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="shortcut-grid">
          {shortcutSections().map((section) => (
            <section key={section.title} className="shortcut-section" aria-label={section.title}>
              <h3>{section.title}</h3>
              <dl>
                {section.rows.map((row) => (
                  <div key={row.what} className="shortcut-row" data-testid="shortcut-row">
                    <dt>
                      {row.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{row.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
};
