import { List, RotateCcw } from "lucide-react";
import type { PokerTableView } from "@baize/shared";
import { handResult } from "./table-side.js";
import { useTableRun } from "./use-table-run.js";
import "./table-side.css";

const HandEndView = ({ table }: { table: PokerTableView }) => {
  const { busy, failure, run } = useTableRun(table.groupId);
  const result = handResult(table);
  if (result === null) return null;

  return (
    <section className="table-end" data-testid="hand-end" data-tone={result.tone}>
      <p className="table-end-result" data-testid="hand-result">
        {result.headline}
      </p>
      <p className="table-end-detail" data-testid="hand-detail">
        {result.detail}
      </p>
      <div className="table-end-actions">
        {/* 接着打是最常走的路，结束卡一出来焦点就在它上面，回车就开下一手。 */}
        <button
          type="button"
          className="primary-button table-end-button"
          data-testid="hand-again"
          disabled={busy !== null}
          autoFocus
          onClick={() => void run("start")}
        >
          <RotateCcw size={16} aria-hidden="true" />
          再来一手
        </button>
        <button
          type="button"
          className="ghost-button table-end-button"
          data-testid="hand-leave"
          disabled={busy !== null}
          onClick={() => void run("leave")}
        >
          <List size={16} aria-hidden="true" />
          散场看复盘
        </button>
      </div>
      {failure === null ? null : (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
};

export const HandEnd = ({ table }: { table: PokerTableView | null }) =>
  table === null ? null : <HandEndView table={table} />;
