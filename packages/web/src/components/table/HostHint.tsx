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

// 控制面的建议挂在决策点上，你一出牌它就不算数了。这一街还没完时，上一步的建议照样有参考价值，
// 页面自己记住最近一条，灰着留到换街或换手。
type Remembered = { handId: PokerHandId; seq: number; text: string };

const stillThisStreet = (remembered: Remembered | null, hand: Hand): remembered is Remembered =>
  remembered !== null &&
  remembered.handId === hand.id &&
  hand.view.street !== "complete" &&
  !hand.view.events.slice(remembered.seq).some((event) => event.kind === "street");

const HostHintView = ({ table, hand }: { table: PokerTableView; hand: Hand }) => {
  const { actions } = useApp();
  const { messages, history, retry } = useTableMessages(table.groupId);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<Remembered | null>(null);

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
  // 渲染时就记下，下一次推送（你出过牌）到来时手上已经有它。
  if (
    stage === "done" &&
    text !== null &&
    (remembered?.handId !== hand.id || remembered.seq !== seq || remembered.text !== text)
  ) {
    setRemembered({ handId: hand.id, seq, text });
  }
  const earlier = stage !== "done" && stillThisStreet(remembered, hand) ? remembered : null;
  return (
    <section className="table-hint" data-testid="host-hint" data-stage={stage} data-hand={hand.number}>
      {earlier === null ? null : (
        <div className="table-hint-card table-hint-earlier" data-testid="hint-earlier">
          <Lightbulb size={16} aria-hidden="true" />
          <div>
            <p className="table-hint-head">
              <b>上一步的建议</b>
            </p>
            <p className="table-hint-text">{earlier.text}</p>
          </div>
        </div>
      )}
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
