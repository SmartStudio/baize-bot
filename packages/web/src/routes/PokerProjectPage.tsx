import { useState } from "react";
import { Play, Settings2 } from "lucide-react";
import { POKER_PERSONAS, type GroupId, type PokerSeatNo, type PokerTableView } from "@baize/shared";
import { ReviewCard } from "../components/poker/ReviewCard.js";
import { SeatsBlock } from "../components/poker/SeatsBlock.js";
import { StatsBlock } from "../components/poker/StatsBlock.js";
import { SwapSeatDialog, type SwapPersona } from "../components/poker/SwapSeatDialog.js";

type Props = {
  table: PokerTableView;
  title: string;
  onOpenTable: (groupId: GroupId) => void;
  onStartHand: (groupId: GroupId) => Promise<unknown>;
  onSwapSeat: (groupId: GroupId, seat: PokerSeatNo, persona: SwapPersona) => Promise<unknown>;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : "没成功，再试一次");

// 盲注和起始筹码是 D21 的默认值，视图里还不带桌子级的设置，所以这里是字面量，标「默认」。
const BLINDS_AND_STACK = "10/20，每人 2000";

export const PokerProjectPage = ({ table, title, onOpenTable, onStartHand, onSwapSeat }: Props) => {
  const [swapSeat, setSwapSeat] = useState<PokerSeatNo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const resumable = table.session !== null;

  const start = () => {
    setStarting(true);
    setStartError(null);
    void (resumable ? Promise.resolve() : onStartHand(table.groupId))
      .then(() => onOpenTable(table.groupId))
      .catch((cause: unknown) => setStartError(messageOf(cause)))
      .finally(() => setStarting(false));
  };

  const swap = async (persona: SwapPersona) => {
    if (swapSeat === null) return;
    const down = table.seats.find((seat) => seat.seat === swapSeat)?.name ?? "";
    await onSwapSeat(table.groupId, swapSeat, persona);
    setNotice(`${down} 下桌，${POKER_PERSONAS[persona].name} 上桌`);
    setSwapSeat(null);
  };

  return (
    <main className="today-page" data-testid="poker-project" data-poker-project={table.groupId}>
      <div className="today-content">
        <header className="project-head">
          <div className="project-head-main">
            <h1>{title}</h1>
            <p className="project-goal" data-testid="poker-session">
              {table.session === null ? "你说开就开" : `这一场打了 ${table.session.handCount} 手，还没散`}
            </p>
          </div>
          <button
            type="button"
            className="primary-button project-open-group"
            data-testid="poker-start"
            disabled={starting}
            onClick={start}
          >
            <Play size={16} aria-hidden="true" />
            {resumable ? "接着打" : "开一场"}
          </button>
        </header>
        {startError === null ? null : (
          <p className="today-inline-error" role="alert" data-testid="poker-start-error">
            {startError}
          </p>
        )}
        <ReviewCard table={table} />
        <SeatsBlock table={table} notice={notice} onSwap={setSwapSeat} />
        <StatsBlock table={table} />
        <details className="poker-rules" data-testid="poker-rules">
          <summary>
            <Settings2 size={16} aria-hidden="true" />
            规则
          </summary>
          <dl>
            <div>
              <dt>盲注和起始筹码</dt>
              <dd>
                {BLINDS_AND_STACK}
                <span className="tag">默认</span>
              </dd>
            </div>
            <div>
              <dt>手牌谁看得见</dt>
              <dd>只有你和发牌引擎。牌友看不到你的牌，也看不到彼此的</dd>
            </div>
          </dl>
        </details>
      </div>
      {swapSeat === null ? null : (
        <SwapSeatDialog table={table} seat={swapSeat} onPick={swap} onClose={() => setSwapSeat(null)} />
      )}
    </main>
  );
};
