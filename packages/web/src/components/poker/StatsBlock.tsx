import type { PokerTableView } from "@baize/shared";
import { formatChips } from "../../state/poker.js";

// 战绩按「场」数：从开打到散场是一场，一场里打很多手。筹码是虚拟的这句只在牌桌页上说一次。
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
          净 <b data-testid="stats-net">{net > 0 ? `+${formatChips(net)}` : formatChips(net)}</b> 筹码
        </div>
      </div>
    </section>
  );
};
