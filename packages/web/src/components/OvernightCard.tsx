import type { Bot, BotId, GroupId, OvernightItem, OvernightStatus } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";

type Props = {
  items: OvernightItem[];
  bots: Record<BotId, Bot>;
  onSelect: (groupId: GroupId) => void;
  onDismiss: () => void;
};

const status: Record<OvernightStatus, { label: string; className: string }> = {
  done: { label: "完成", className: "badge-accepted" },
  waiting: { label: "等你", className: "badge-pending" },
  working: { label: "在干活", className: "badge-working" },
};

export const OvernightCard = ({ items, bots, onSelect, onDismiss }: Props) => (
  <aside className="overnight-card" data-testid="overnight-card" aria-labelledby="overnight-title">
    <header className="overnight-head">
      <h2 id="overnight-title">你下线的时候，活没停</h2>
      <button type="button" className="ghost-button" onClick={onDismiss}>
        知道了
      </button>
    </header>
    <div className="overnight-list">
      {items.map((item) => {
        const bot = bots[item.botId];
        const state = status[item.status];
        return (
          <button
            type="button"
            className="overnight-row"
            data-testid="overnight-row"
            key={item.botId}
            onClick={() => onSelect(item.groupId)}
          >
            <BotAvatar name={bot?.name ?? "Bot"} hue={bot?.hue ?? "sky"} />
            <span className="overnight-copy">
              <span>
                <b>{bot?.name ?? "已删除的 Bot"}</b> <small>{bot?.tag}</small>
              </span>
              <span className="overnight-text">{item.text}</span>
            </span>
            <span className={`badge ${state.className}`}>{state.label}</span>
          </button>
        );
      })}
    </div>
  </aside>
);
