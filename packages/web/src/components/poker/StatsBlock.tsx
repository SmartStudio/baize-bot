import type { PokerTableView } from "@baize/shared";

// 战绩：打了几局、几局你赢、筹码净变化。筹码是虚拟的，数字旁边要写明。
export const StatsBlock = ({ table }: { table: PokerTableView }) => {
  const { sessions, sessionsWon, net } = table.stats;
  return (
    <section className="poker-stats" data-testid="stats-block">
      <div className="poker-block-head">
        <h2>战绩</h2>
        <span data-testid="stats-note">虚拟筹码，不涉及真钱</span>
      </div>
      <div className="poker-stats-figures">
        <div>
          <b data-testid="stats-sessions">{sessions}</b>局
        </div>
        <div>
          <b data-testid="stats-won">{sessionsWon}</b>局你赢
        </div>
        <div>
          <b data-testid="stats-net">{net > 0 ? `+${net}` : `${net}`}</b>筹码
        </div>
      </div>
    </section>
  );
};
