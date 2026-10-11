import type { PokerTableView } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";

// 散场后老白写的三手复盘，挂在项目页顶上。没打过就没有这张卡；开了新一场还没散，留着上一场的。
export const ReviewCard = ({ table }: { table: PokerTableView }) => {
  const review = table.lastReview;
  if (review === null) return null;
  return (
    <section data-testid="review-card" style={card}>
      <header style={head}>
        <BotAvatar name={table.host.name} hue={table.host.hue} />
        <div>
          <div style={title}>{table.host.name} · 复盘</div>
          <div style={sub}>这一场挑出 {review.hands.length} 手关键牌</div>
        </div>
      </header>
      <ul style={list}>
        {review.hands.map((hand) => (
          <li key={hand.number} data-testid="review-hand" data-number={hand.number} style={row}>
            <span style={mono}>{hand.title}</span>
            <span>{hand.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

const card = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  padding: "var(--space-7)",
  border: "1px solid var(--border-1)",
  borderRadius: "var(--radius-lg)",
  background: "var(--bg-surface)",
} as const;

const head = { display: "flex", gap: "var(--space-5)", alignItems: "center" } as const;

const title = { color: "var(--fg-1)", font: "var(--type-ui)", fontWeight: "var(--weight-semibold)" } as const;

const sub = { color: "var(--fg-3)", font: "var(--type-caption)" } as const;

const list = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  margin: 0,
  padding: 0,
  listStyle: "none",
} as const;

const row = { display: "flex", gap: "var(--space-5)", color: "var(--fg-2)", font: "var(--type-body)" } as const;

const mono = { flex: "none", color: "var(--fg-3)", font: "var(--type-mono)" } as const;
