import { useState } from "react";
import { Check, Users } from "lucide-react";
import type { Bot, BotId } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import type { GroupDraft } from "../api/client.js";

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6;

// <input type="datetime-local"> 给的是「2026-09-14T12:00」这种没有时区的本地时间，Timestamp 要的是 ISO。
// 空字符串就是没填，截止可空。
const isoOf = (local: string): string | null => {
  if (local.trim().length === 0) return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

type Props = {
  bots: Bot[];
  onCreate: (draft: GroupDraft) => Promise<void>;
  onClose: () => void;
};

export const NewGroupDialog = ({ bots, onCreate, onClose }: Props) => {
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<BotId[]>([]);
  const [summary, setSummary] = useState("");
  const [due, setDue] = useState("");
  const [sending, setSending] = useState(false);

  const toggle = (botId: BotId) => {
    setPicked((now) =>
      now.includes(botId) ? now.filter((id) => id !== botId) : now.length < MAX_MEMBERS ? [...now, botId] : now,
    );
  };

  const ready = title.trim().length > 0 && picked.length >= MIN_MEMBERS && !sending;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    void onCreate({ title: title.trim(), botIds: picked, summary: summary.trim(), dueAt: isoOf(due) })
      .then(onClose)
      .catch(() => setSending(false));
  };

  return (
    <div className="scrim" data-testid="new-group-dialog">
      <form className="dialog" onSubmit={submit}>
        <header className="dialog-head">
          <Users size={20} aria-hidden="true" />
          <span>
            <b>一个群，跟一个主题任务</b>
            <small>Bot 在群里对话、交接，你在群里点头。任务卡钉在群顶部，清单由 Bot 维护。</small>
          </span>
        </header>
        <label className="field">
          <span>主题任务</span>
          <input
            data-testid="group-title"
            value={title}
            placeholder="Globex X3 × 200 订单"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="field">
          <span>拉谁进来</span>
          <div className="bot-picker">
            {bots.map((bot) => {
              const on = picked.includes(bot.id);
              return (
                <button
                  key={bot.id}
                  type="button"
                  className={`bot-pill${on ? " is-picked" : ""}`}
                  data-testid="group-member"
                  data-bot-name={bot.name}
                  aria-pressed={on}
                  onClick={() => toggle(bot.id)}
                >
                  <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
                  {bot.name}
                  {on ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <small>2 到 6 个 Bot，都是你自己的。谁先接手，在群里 @它就行。已选 {picked.length} 个。</small>
        </div>
        <label className="field">
          <span>一句话说明</span>
          <textarea
            data-testid="group-summary"
            rows={3}
            value={summary}
            placeholder="这个群要办成什么事，谁管哪一段，哪些事要先找你点头。"
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="field">
          <span>截止（可选）</span>
          <input type="datetime-local" data-testid="group-due" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <p className="dialog-note">清单由 Bot 维护。交接时 Bot 自己更新已完成、未完成和清单，你随时在群里改。</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" data-testid="group-cancel" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" data-testid="group-submit" disabled={!ready}>
            建群并派活
          </button>
        </div>
      </form>
    </div>
  );
};
