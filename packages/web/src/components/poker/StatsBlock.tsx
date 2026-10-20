import type { PokerTableView } from "@baize/shared";
import { formatChips } from "../../state/poker.js";

const signed = (chips: number): string => (chips > 0 ? `+${formatChips(chips)}` : formatChips(chips));

// 战绩按「场」数：从开打到散场是一场，一场里打很多手。筹码是虚拟的这句只在牌桌页上说一次。
// 没散的那一场不进三个数，单列一行，不然页头说打了几十手、战绩却是 0 场，看着像算错了。
export const StatsBlock = ({ table }: { table: PokerTableView }) => {
  const { sessions, sessionsWon, net } = table.stats;
  return (
    <section className="poker-stats" data-testid="stats-block">
      <div className="poker-block-head">
        <h2>战绩</h2>
      </div>
      <div className="poker-stats-figures">
        <div>
          打了 <b data-testid="stats-sessions">{sessions}</b> 场
        </div>
        <div>
          赢了 <b data-testid="stats-won">{sessionsWon}</b> 场
        </div>
        <div>
          净 <b data-testid="stats-net">{signed(net)}</b> 筹码
        </div>
      </div>
      {table.session === null ? null : (
        <p className="poker-stats-open" data-testid="stats-open-session">
          正在打的这一场 {table.session.handCount} 手，净 {signed(table.session.net)} 筹码，散场后算进战绩
        </p>
      )}
    </section>
  );
};
