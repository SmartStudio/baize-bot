import { X } from "lucide-react";
import type { Bot, BotId, TopicTask } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import { dueTextOf } from "./TaskCard.js";

const timeRangeOf = (from: string, to: string | null): string => {
  const hhmm = (iso: string) => {
    const at = new Date(iso);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  };
  return to === null ? `${hhmm(from)} 起` : `${hhmm(from)} – ${hhmm(to)}`;
};

type Props = {
  task: TopicTask;
  memberIds: BotId[];
  bots: Record<BotId, Bot>;
  onClose: () => void;
};

export const TaskPanel = ({ task, memberIds, bots, onClose }: Props) => {
  const done = task.checklist.filter((item) => item.done).length;
  // 经手过的按记录排，没经手过的排在后面写「等待接手」。谁都能一眼看出这个任务传到哪一步了。
  const handedIds = new Set(task.handled.map((record) => record.botId));
  const waiting = memberIds.filter((botId) => !handedIds.has(botId));

  return (
    <aside className="task-panel" data-testid="task-panel">
      <header className="task-panel-head">
        <b>{task.title}</b>
        <button
          type="button"
          className="icon-button"
          data-testid="task-close"
          aria-label="关掉任务详情"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p className="task-panel-line">{task.dueAt === null ? "没定截止" : `截止 ${dueTextOf(task.dueAt)}`}</p>
      {task.summary.length === 0 ? null : <p className="task-panel-summary">{task.summary}</p>}

      <p className="group-label">
        清单 {done} / {task.checklist.length}
      </p>
      {task.checklist.length === 0 ? (
        <p className="task-empty">Bot 接手后自己列。</p>
      ) : (
        <ul className="task-panel-list" data-testid="task-panel-checklist">
          {task.checklist.map((item) => (
            <li key={item.text} data-done={item.done}>
              <span>{item.text}</span>
              <small>
                {item.done ? "已完成" : "未完成"}
                {item.ownerBotId === null ? "" : ` · ${bots[item.ownerBotId]?.name ?? "Bot"}`}
              </small>
            </li>
          ))}
        </ul>
      )}

      <p className="group-label">经手</p>
      <ul className="task-panel-list" data-testid="task-handled">
        {task.handled.map((record) => {
          const bot = bots[record.botId];
          return (
            <li key={`${record.botId}-${record.from}`}>
              <span>
                {bot === undefined ? null : <BotAvatar name={bot.name} hue={bot.hue} size="xs" />}
                {bot?.name ?? "Bot"}
                {bot !== undefined && bot.tags.length > 0 ? ` · ${bot.tags.join("、")}` : ""}
                {record.to === null ? <em className="tag">当前</em> : null}
              </span>
              <small>{timeRangeOf(record.from, record.to)}</small>
            </li>
          );
        })}
        {waiting.map((botId) => {
          const bot = bots[botId];
          return (
            <li key={botId}>
              <span>
                {bot === undefined ? null : <BotAvatar name={bot.name} hue={bot.hue} size="xs" />}
                {bot?.name ?? "Bot"}
                {bot !== undefined && bot.tags.length > 0 ? ` · ${bot.tags.join("、")}` : ""}
              </span>
              <small>等待接手</small>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
