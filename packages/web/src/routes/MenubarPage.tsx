import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import type { ApprovalId, DecideApprovalRequest, GroupId } from "@baize/shared";
import { TodayPending } from "./TodayPage.js";
import { pendingCountOf, useToday } from "../state/today.js";

type Props = {
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => Promise<void>;
};

export const MenubarPage = ({ onSend, onDecide }: Props) => {
  const { status, data, error, refresh } = useToday();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (status === "loading") {
    return (
      <main className="menubar-page" data-testid="menubar-page">
        正在整理
      </main>
    );
  }
  if (status === "failed" || data === null) {
    return (
      <main className="menubar-page menubar-failed" data-testid="menubar-page">
        <p>{error}</p>
        <button type="button" className="ghost-button" onClick={() => void refresh()}>
          点一下重试
        </button>
      </main>
    );
  }

  const count = pendingCountOf(data);
  const disabled = data.assistantGroupId === null;
  return (
    <main className="menubar-page" data-testid="menubar-page">
      <header className="menubar-head">
        <span className="menubar-mark" aria-hidden="true">
          白
        </span>
        <strong>{count > 0 ? `${count} 件等你` : "没有要你处理的事"}</strong>
        {count > 0 ? <span className="menubar-count">{count}</span> : null}
      </header>
      {error === null ? null : (
        <p className="today-refresh-error" role="status">
          {error}
        </p>
      )}
      <TodayPending
        data={data.pending}
        compact
        onDecide={async (id, decision) => {
          await onDecide(id, decision);
          await refresh();
        }}
      />
      <form
        className="menubar-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (disabled || sending || text.length === 0 || data.assistantGroupId === null) return;
          setSending(true);
          setSendError(null);
          void onSend(data.assistantGroupId, text)
            .then(() => setDraft(""))
            .catch(() => setSendError("没发出去，请重试"))
            .finally(() => setSending(false));
        }}
      >
        <input
          value={draft}
          disabled={disabled}
          aria-label="对主助理说一句"
          placeholder={disabled ? "主助理还没准备好" : "对主助理说一句"}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="发送"
          disabled={disabled || sending || draft.trim().length === 0}
        >
          <SendHorizontal size={16} aria-hidden="true" />
        </button>
      </form>
      {sendError === null ? null : (
        <p className="today-form-error" role="alert">
          {sendError}
        </p>
      )}
    </main>
  );
};
