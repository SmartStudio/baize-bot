import { useEffect, useState } from "react";
import { ChevronRight, Clock, SlidersHorizontal } from "lucide-react";
import { BotHue, type Bot, type BotId } from "@baize/shared";
import type { BotDraft } from "../api/client.js";
import { BotAvatar } from "./BotAvatar.js";
import { RoutinesTab } from "./routines/RoutinesTab.js";

type Props = { bot: Bot; onChange: (botId: BotId, draft: BotDraft) => Promise<void> };

type Tab = "settings" | "routines";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "设置", icon: <SlidersHorizontal size={14} aria-hidden="true" /> },
  { id: "routines", label: "例行", icon: <Clock size={14} aria-hidden="true" /> },
];

const LATER_ROWS = [
  { title: "可用工具", note: "去「设置 · 工具」连 MCP 再勾给它 · 后续" },
  { title: "已登录站点", note: "在电脑里登录一次，所有 Bot 共用 · 后续" },
  { title: "会做的活", note: "干过的活它会存成 skill · 后续" },
];

export const BotSettingsPanel = ({ bot, onChange }: Props) => {
  const [name, setName] = useState(bot.name);
  const [tag, setTag] = useState(bot.tag);
  const [description, setDescription] = useState(bot.description);
  const [tab, setTab] = useState<Tab>("settings");

  useEffect(() => {
    setName(bot.name);
    setTag(bot.tag);
    setDescription(bot.description);
  }, [bot.id, bot.name, bot.tag, bot.description]);

  const commit = (draft: BotDraft) => void onChange(bot.id, draft);

  return (
    <aside className="bot-panel" data-testid="bot-panel">
      <header className="bot-panel-head">
        <BotAvatar name={name} hue={bot.hue} size="lg" />
        <div className="hue-row">
          {BotHue.options.map((hue) => (
            <button
              key={hue}
              type="button"
              className={`hue-swatch${hue === bot.hue ? " is-selected" : ""}`}
              style={{ background: `var(--bot-${hue})` }}
              aria-label={`换成 ${hue}`}
              onClick={() => commit({ hue })}
            />
          ))}
        </div>
      </header>
      <nav className="panel-tabs" role="tablist" aria-label="Bot 设置分页">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`panel-tab${tab === item.id ? " is-selected" : ""}`}
            data-testid={`bot-tab-${item.id}`}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      {tab === "routines" ? (
        <RoutinesTab botId={bot.id} key={bot.id} />
      ) : (
        <>
          <label className="field">
            <span>名称</span>
            <input
              data-testid="bot-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const next = name.trim();
                if (next.length === 0) return setName(bot.name);
                if (next !== bot.name) commit({ name: next });
              }}
            />
          </label>
          <label className="field">
            <span>标签（可选）</span>
            <input
              data-testid="bot-tag-input"
              value={tag}
              placeholder="销售、客服、采购"
              onChange={(e) => setTag(e.target.value)}
              onBlur={() => tag !== bot.tag && commit({ tag })}
            />
            <small>出现在名字旁边，方便一眼认出</small>
          </label>
          <label className="field">
            <span>描述</span>
            <textarea
              data-testid="bot-description-input"
              rows={5}
              value={description}
              placeholder="它负责什么、怎么干活、什么不做"
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description !== bot.description && commit({ description })}
            />
            <small>它怎么干活、什么不做，都写在这里。改完自动保存。</small>
          </label>
          <div className="row-card">
            <span>
              <b>通知</b>
              <small>干完活或需要你回应时通知你</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={bot.notify}
              aria-label="通知"
              className={`switch${bot.notify ? " is-on" : ""}`}
              data-testid="bot-notify-switch"
              onClick={() => commit({ notify: !bot.notify })}
            />
          </div>
          {LATER_ROWS.map((row) => (
            <div className="row-card is-later" key={row.title}>
              <span>
                <b>{row.title}</b>
                <small>{row.note}</small>
              </span>
              <ChevronRight size={16} aria-hidden="true" />
            </div>
          ))}
        </>
      )}
    </aside>
  );
};
