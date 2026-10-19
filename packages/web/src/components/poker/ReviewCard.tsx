import { useState } from "react";
import type { PokerTableView } from "@baize/shared";
import { api, RequestFailed } from "../../api/client.js";
import { BotAvatar } from "../BotAvatar.js";

// 散场后老白写的三手复盘，挂在项目页顶上。没打过就没有这张卡；开了新一场还没散，留着上一场的。
// 卡的内容跟着 reviewState 走：生成中给一句等待，失败给重试按钮，写好了才列关键手。
export const ReviewCard = ({ table }: { table: PokerTableView }) => {
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { reviewState, lastReview: review } = table;
  if (reviewState === null) return null;

  const retry = async () => {
    setRetrying(true);
    setFailure(null);
    try {
      await api.retryPokerReview(table.groupId, { sessionId: reviewState.sessionId });
    } catch (cause) {
      setFailure(cause instanceof RequestFailed ? cause.message : "没派出去，再试一次");
    } finally {
      setRetrying(false);
    }
  };

  const done = reviewState.status === "done" && review !== null && review.sessionId === reviewState.sessionId;
  const body = () => {
    if (reviewState.status === "generating") {
      return (
        <p style={note} data-testid="review-generating">
          {table.host.name}正在写这一场的复盘，写好了会出现在这里
        </p>
      );
    }
    if (!done) {
      return (
        <div style={retryRow} data-testid="review-failed">
          <span style={note}>这一场的复盘没写成</span>
          <button
            type="button"
            className="ghost-button"
            data-testid="review-retry"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? "派活中" : "重新生成"}
          </button>
          {failure === null ? null : (
            <span role="alert" className="today-inline-error" data-testid="review-retry-error">
              {failure}
            </span>
          )}
        </div>
      );
    }
    return (
      <ul style={list}>
        {review.hands.map((hand) => (
          <li key={hand.number} data-testid="review-hand" data-number={hand.number} style={row}>
            <span style={mono}>{hand.title}</span>
            <span>{hand.text}</span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <section data-testid="review-card" data-review-status={reviewState.status} style={card}>
      <header style={head}>
        <BotAvatar shape={table.host.shape} hue={table.host.hue} />
        <div>
          <div style={title}>{table.host.name} · 复盘</div>
          <div style={sub}>{done ? `这一场挑出 ${review.hands.length} 手关键牌` : "最近一场"}</div>
        </div>
      </header>
      {body()}
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

const note = { margin: 0, color: "var(--fg-2)", font: "var(--type-body)" } as const;

const retryRow = { display: "flex", gap: "var(--space-5)", alignItems: "center", flexWrap: "wrap" } as const;

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
