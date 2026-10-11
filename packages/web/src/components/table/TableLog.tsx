import { useEffect, useRef } from "react";
import type { PokerTableView } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";
import { publicLines } from "./table-side.js";
import { useTableMessages } from "./use-table-messages.js";
import "./table-side.css";

export const VirtualChipsNote = () => (
  <p className="table-chips-note" data-testid="table-chips-note">
    虚拟筹码，不涉及真钱
  </p>
);

const TableLogView = ({ table }: { table: PokerTableView }) => {
  const { messages, history, retry } = useTableMessages(table.groupId);
  const lines = publicLines(messages, table);
  const scroller = useRef<HTMLElement>(null);

  // 新话接在末尾，滚到底让它进视野；右栏高度是定的，话多了只在里面滚，不会把下面的按钮顶走。
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lines.length]);

  return (
    <aside className="table-log" data-testid="table-log" aria-label="牌桌上">
      <h4>牌桌上</h4>
      <section
        ref={scroller}
        className="table-log-lines"
        data-testid="table-log-lines"
        tabIndex={0}
        aria-label="牌桌上的话"
      >
        {lines.map((line) => (
          <div key={line.id} className="table-log-line" data-testid="table-log-line">
            <BotAvatar name={line.name} hue={line.hue} size="sm" />
            <span>
              <b className="table-log-name">{line.name}</b>
              <span className="table-log-text">{line.text}</span>
            </span>
          </div>
        ))}
        {history === "loading" && lines.length === 0 ? <p className="table-log-hint">正在取牌桌上的话……</p> : null}
        {history === "ready" && lines.length === 0 ? <p className="table-log-hint">还没人说话。</p> : null}
      </section>
      {history === "failed" ? (
        <p className="error" role="alert">
          牌桌上的话没拉回来。
          <button type="button" className="link-button" onClick={retry}>
            重试
          </button>
        </p>
      ) : null}
      <p className="table-log-note" data-testid="table-log-note">
        你的手牌只有你和发牌引擎看得见。
      </p>
    </aside>
  );
};

export const TableLog = ({ table }: { table: PokerTableView | null }) =>
  table === null ? null : <TableLogView table={table} />;
