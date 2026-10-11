import { useState } from "react";
import { Lightbulb, LoaderCircle } from "lucide-react";
import type { PokerHandId, PokerTableView } from "@baize/shared";
import { RequestFailed } from "../../api/client.js";
import { useApp } from "../../state/app.js";
import { hintStage, hintText } from "./table-side.js";
import { useTableMessages } from "./use-table-messages.js";
import "./table-side.css";

type Hand = NonNullable<PokerTableView["hand"]>;

// 请求已经发出、回包也成功了，但表示「老白在看」的推送还没到：先按等待态画，别让按钮闪回来。
type Asked = { handId: PokerHandId; seq: number };

const HostHintView = ({ table, hand }: { table: PokerTableView; hand: Hand }) => {
  const { actions } = useApp();
  const { messages, history, retry } = useTableMessages(table.groupId);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const seq = hand.view.events.length;
  const staged = hintStage(table);
  const stage = staged === "idle" && asked?.handId === hand.id && asked.seq === seq ? "waiting" : staged;
  const yourTurn = hand.view.legal.kind === "your_turn";

  const ask = async () => {
    setPending(true);
    setFailure(null);
    try {
      await actions.askPokerHint(hand.id, { seq });
      setAsked({ handId: hand.id, seq });
    } catch (cause) {
      setFailure(cause instanceof RequestFailed ? cause.message : "没问成，再试一次");
    } finally {
      setPending(false);
    }
  };

  const text = hintText(messages, table);
  return (
    <section className="table-hint" data-testid="host-hint" data-stage={stage} data-hand={hand.number}>
      {stage === "idle" || stage === "failed" ? (
        <div className="table-hint-ask">
          {stage === "failed" ? <p className="table-hint-muted">老白这次没答上来。</p> : null}
          <button
            type="button"
            className="ghost-button"
            data-testid={stage === "failed" ? "hint-retry" : "hint-ask"}
            disabled={!yourTurn || pending}
            onClick={() => void ask()}
          >
            <Lightbulb size={16} aria-hidden="true" />
            {stage === "failed" ? "再问一次" : "问老白这手怎么打"}
          </button>
          {yourTurn ? null : <p className="table-hint-muted">轮到你出牌时才能问。</p>}
        </div>
      ) : null}
      {stage === "waiting" ? (
        <p className="table-hint-waiting" role="status" data-testid="hint-waiting">
          <LoaderCircle size={16} aria-hidden="true" />
          老白在看这手牌……
        </p>
      ) : null}
      {stage === "done" ? (
        <div className="table-hint-card" data-testid="hint-card">
          <Lightbulb size={16} aria-hidden="true" />
          <div>
            <p className="table-hint-head">
              <b>{table.host.name}</b>
              <span className="table-hint-private" data-testid="hint-private">
                仅你可见
              </span>
            </p>
            {text !== null ? (
              <p className="table-hint-text">{text}</p>
            ) : (
              <p className="table-hint-muted">
                {history === "failed" ? "建议正文没拉回来。" : "建议正文加载中……"}
                {history === "failed" ? (
                  <button type="button" className="link-button" onClick={retry}>
                    重试
                  </button>
                ) : null}
              </p>
            )}
          </div>
        </div>
      ) : null}
      {failure === null ? null : (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
};

export const HostHint = ({ table }: { table: PokerTableView | null }) =>
  table === null || table.hand === null ? null : <HostHintView table={table} hand={table.hand} />;
