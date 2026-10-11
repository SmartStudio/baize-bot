import { useState } from "react";
import { List, RotateCcw } from "lucide-react";
import type { PokerTableView } from "@baize/shared";
import { useNavigate } from "react-router-dom";
import { api, RequestFailed } from "../../api/client.js";
import { pathOf } from "../../routes/screen.js";
import { handResult } from "./table-side.js";
import "./table-side.css";

const HandEndView = ({ table }: { table: PokerTableView }) => {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"again" | "leave" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const result = handResult(table);
  if (result === null) return null;

  const run = async (kind: "again" | "leave") => {
    setBusy(kind);
    setFailure(null);
    try {
      if (kind === "again") await api.startHand(table.groupId);
      else {
        await api.leaveTable(table.groupId);
        navigate(pathOf({ kind: "project", groupId: table.groupId }));
      }
    } catch (cause) {
      setFailure(cause instanceof RequestFailed ? cause.message : "没成，再试一次");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="table-end" data-testid="hand-end" data-tone={result.tone}>
      <p className="table-end-result" data-testid="hand-result">
        {result.headline}
      </p>
      <p className="table-end-detail">{result.detail}</p>
      <div className="table-end-actions">
        <button
          type="button"
          className="ghost-button"
          data-testid="hand-again"
          disabled={busy !== null}
          onClick={() => void run("again")}
        >
          <RotateCcw size={16} aria-hidden="true" />
          再来一手
        </button>
        <button
          type="button"
          className="primary-button table-end-leave"
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
