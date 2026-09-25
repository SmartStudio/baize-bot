import { Pin } from "lucide-react";
import type { Bot, BotId, ChecklistItem, TopicTask } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";

// 原型 05 的卡上写的是「截止 09-14 12:00」，月日加时分，不带年。
export const dueTextOf = (dueAt: string): string => {
  const at = new Date(dueAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
};

type Props = {
  task: TopicTask;
  memberIds: BotId[];
  bots: Record<BotId, Bot>;
  onToggle: (checklist: ChecklistItem[]) => void;
  onOpenDetail: () => void;
};

export const TaskCard = ({ task, memberIds, bots, onToggle, onOpenDetail }: Props) => {
  const done = task.checklist.filter((item) => item.done).length;
  const current = task.currentBotId === null ? null : (bots[task.currentBotId]?.name ?? "Bot");
  const toggle = (at: number) =>
    onToggle(task.checklist.map((item, i) => (i === at ? { ...item, done: !item.done } : item)));

  return (
    <section className="task-card" data-testid="task-card">
      <header className="task-card-top">
        <Pin size={14} aria-hidden="true" />
        <b className="task-title">{task.title}</b>
        <span className="task-meta" data-testid="task-progress">
          清单 {done} / {task.checklist.length}
        </span>
        {task.dueAt === null ? null : <span className="task-meta">截止 {dueTextOf(task.dueAt)}</span>}
        <span className="task-meta" data-testid="task-current">
          当前 {current ?? "还没人接手"}
        </span>
        <span className="task-card-right">
          <span className="task-members" aria-hidden="true">
            {memberIds.map((botId) => {
              const bot = bots[botId];
              return bot === undefined ? null : <BotAvatar key={botId} name={bot.name} hue={bot.hue} size="xs" />;
            })}
          </span>
          <button type="button" className="ghost-button" data-testid="task-open" onClick={onOpenDetail}>
            任务详情
          </button>
        </span>
      </header>
      {task.checklist.length === 0 ? (
        <p className="task-empty">Bot 接手后自己列。</p>
      ) : (
        <ul className="task-checklist" data-testid="task-checklist">
          {task.checklist.map((item, at) => (
            <li key={item.text}>
              <label className="task-check">
                <input
                  type="checkbox"
                  data-testid="checklist-item"
                  data-done={item.done}
                  checked={item.done}
                  onChange={() => toggle(at)}
                />
                <span className={item.done ? "is-done" : ""}>{item.text}</span>
                {item.ownerBotId === null ? null : <em className="tag">{bots[item.ownerBotId]?.name ?? "Bot"}</em>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
