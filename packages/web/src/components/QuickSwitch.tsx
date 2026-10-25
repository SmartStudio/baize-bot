import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, MessagesSquare, Search } from "lucide-react";
import { BotAvatar } from "./BotAvatar.js";
import { matchItems, SWITCH_KIND_LABEL, SWITCH_KINDS, type SwitchItem } from "./switchItems.js";
import { trapTab } from "./trapTab.js";

type Props = {
  items: readonly SwitchItem[];
  onPick: (item: SwitchItem) => void;
  onClose: () => void;
};

const iconOf = (item: SwitchItem) =>
  item.kind === "bot" && item.bot !== null ? (
    <BotAvatar shape={item.bot.shape} hue={item.bot.hue} size="xs" />
  ) : item.kind === "project" ? (
    <FolderOpen size={16} aria-hidden="true" />
  ) : (
    <MessagesSquare size={16} aria-hidden="true" />
  );

export const QuickSwitch = ({ items, onPick, onClose }: Props) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const found = matchItems(items, query);
  const at = Math.min(selected, Math.max(found.length - 1, 0));
  const current = found[at];
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, query]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    trapTab(event);
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (found.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((at + step + found.length) % found.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (current !== undefined) onPick(current);
    }
  };

  return (
    <div
      className="scrim quick-switch-scrim"
      data-testid="quick-switch-scrim"
      // 按下的默认动作会在遮罩卸掉之后把焦点清到 body，盖过 RestoreFocus 还回去的那个。
      onMouseDown={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <section
        className="quick-switch"
        role="dialog"
        aria-modal="true"
        aria-label="快速切换"
        data-testid="quick-switch"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          event.stopPropagation();
          if (event.target !== inputRef.current) event.preventDefault();
        }}
      >
        <label className="quick-switch-field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            data-testid="quick-switch-input"
            role="combobox"
            aria-label="按名字找 Bot、群、项目"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current === undefined ? undefined : optionId(at)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="找 Bot、群、项目"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
          />
        </label>
        <div ref={listRef} id={listId} className="quick-switch-list" role="listbox" aria-label="找到的">
          {found.length === 0 ? (
            <p className="quick-switch-empty" data-testid="quick-switch-empty">
              没有叫这个名字的 Bot、群或项目
            </p>
          ) : (
            SWITCH_KINDS.map((kind) => {
              const rows = found.flatMap((item, index) => (item.kind === kind ? [{ item, index }] : []));
              if (rows.length === 0) return null;
              return (
                <div
                  key={kind}
                  className="quick-switch-group"
                  role="group"
                  aria-label={SWITCH_KIND_LABEL[kind]}
                  data-testid="quick-switch-group"
                  data-kind={kind}
                >
                  <div className="quick-switch-label" aria-hidden="true">
                    {SWITCH_KIND_LABEL[kind]}
                  </div>
                  {rows.map(({ item, index }) => (
                    <div
                      key={item.key}
                      id={optionId(index)}
                      className={`menu-row quick-switch-option${index === at ? " is-selected" : ""}`}
                      role="option"
                      aria-selected={index === at}
                      data-testid="quick-switch-option"
                      data-kind={item.kind}
                      data-name={item.name}
                      onMouseMove={() => {
                        if (index !== at) setSelected(index);
                      }}
                      onClick={() => onPick(item)}
                    >
                      {iconOf(item)}
                      <span className="quick-switch-name">{item.name}</span>
                      <span className="menu-trail">{SWITCH_KIND_LABEL[item.kind]}</span>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
};
