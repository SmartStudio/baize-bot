import { useState } from "react";
import { Play, Settings2 } from "lucide-react";
import { POKER_PERSONAS, type GroupId, type PokerSeatNo, type PokerTableView, type Routine } from "@baize/shared";
import { describeTriggers } from "../components/routines/cron.js";
import { ReviewCard } from "../components/poker/ReviewCard.js";
import { SeatsBlock } from "../components/poker/SeatsBlock.js";
import { StatsBlock } from "../components/poker/StatsBlock.js";
import { SwapSeatDialog, type SwapPersona } from "../components/poker/SwapSeatDialog.js";

type Props = {
  table: PokerTableView;
  title: string;
  // 挂在这个项目上的例行，空数组就是没设提醒。
  routines: readonly Routine[];
  onOpenTable: (groupId: GroupId) => void;
  onStartHand: (groupId: GroupId) => Promise<unknown>;
  onSwapSeat: (groupId: GroupId, seat: PokerSeatNo, persona: SwapPersona) => Promise<unknown>;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : "没成功，再试一次");

// 盲注和起始筹码是 D21 的默认值，视图里还不带桌子级的设置，所以这里是字面量，标「默认」。
const BLINDS_AND_STACK = "10/20，每人 2000";

export const PokerProjectPage = ({ table, title, routines, onOpenTable, onStartHand, onSwapSeat }: Props) => {
  const [swapSeat, setSwapSeat] = useState<PokerSeatNo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const resumable = table.session !== null;
  const nextTime = routines[0] === undefined ? null : describeTriggers(routines[0].triggers);

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
            <p className="project-goal" data-testid="poker-next-time">
              {nextTime ?? "你说开就开"}
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
            {resumable ? "接着打" : "开一局"}
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
            规则和例行 · {nextTime === null ? "没设例行" : `${nextTime}到点提醒你`}
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
            {routines.map((routine) => (
              <div key={routine.id}>
                <dt>{routine.name}</dt>
                <dd>{describeTriggers(routine.triggers)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
      {swapSeat === null ? null : (
        <SwapSeatDialog table={table} seat={swapSeat} onPick={swap} onClose={() => setSwapSeat(null)} />
      )}
    </main>
  );
};
