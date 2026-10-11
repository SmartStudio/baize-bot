import type { PokerTableView } from "@baize/shared";

// 战绩：打了几局、几局你赢、筹码净变化。筹码是虚拟的，数字旁边要写明。
export const StatsBlock = ({ table }: { table: PokerTableView }) => {
  const { sessions, sessionsWon, net } = table.stats;
  return (
    <section data-testid="stats-block" style={block}>
      <header style={head}>
        <h3 style={heading}>战绩</h3>
        <span data-testid="stats-note" style={note}>
          虚拟筹码，不涉及真钱
        </span>
      </header>
      <div style={stats}>
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

const block = { display: "flex", flexDirection: "column", gap: "var(--space-4)" } as const;

const head = { display: "flex", gap: "var(--space-5)", alignItems: "baseline" } as const;

const heading = { margin: 0, color: "var(--fg-1)", font: "var(--type-heading)" } as const;

const note = { color: "var(--fg-3)", font: "var(--type-caption)" } as const;

const stats = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-9)",
  color: "var(--fg-3)",
  font: "var(--type-caption)",
} as const;
