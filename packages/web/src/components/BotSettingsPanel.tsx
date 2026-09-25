import { useEffect, useState } from "react";
import { ChevronRight, Clock, SlidersHorizontal, Sparkles } from "lucide-react";
import { BotHue, type Bot, type BotId, type ToolConnection } from "@baize/shared";
import type { BotDraft } from "../api/client.js";
import { BotAvatar } from "./BotAvatar.js";
import { RoutinesTab } from "./routines/RoutinesTab.js";
import { SkillsTab } from "./skills/SkillsTab.js";

type Props = {
  bot: Bot;
  tools: ToolConnection[];
  onChange: (botId: BotId, draft: BotDraft) => Promise<void>;
  onPause: (botId: BotId) => Promise<void>;
  onResume: (botId: BotId) => Promise<void>;
  onOpenTools: () => void;
};

type Tab = "settings" | "routines" | "skills";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "设置", icon: <SlidersHorizontal size={14} aria-hidden="true" /> },
  { id: "routines", label: "例行", icon: <Clock size={14} aria-hidden="true" /> },
  { id: "skills", label: "会做的活", icon: <Sparkles size={14} aria-hidden="true" /> },
];

const LATER_ROWS = [{ title: "已登录站点", note: "在电脑里登录一次，所有 Bot 共用 · 后续" }];

const RUN_STATE_FAILED: Record<Bot["runState"], string> = {
  running: "没停下来，再试一次",
  paused: "没接着做，再试一次",
};

// 挂在 bot.id 上换 Bot 就重建，上一个 Bot 在途的锁和报错不会带过来。
const RunStateRow = ({ bot, onPause, onResume }: Pick<Props, "bot" | "onPause" | "onResume">) => {
  const [request, setRequest] = useState<"idle" | "busy" | "failed">("idle");
  const change = async () => {
    setRequest("busy");
    try {
      if (bot.runState === "paused") await onResume(bot.id);
      else await onPause(bot.id);
      setRequest("idle");
    } catch {
      setRequest("failed");
    }
  };
  return (
    <div className="row-card bot-run-state">
      <span>
        <b>{bot.runState === "paused" ? "已暂停" : "运行中"}</b>
        {bot.runState === "paused" ? (
          <small data-testid="bot-paused-note">正在做的停在下一步，新消息先排着，点继续接着做</small>
        ) : null}
        {request === "failed" ? (
          <small className="bot-run-state-error" data-testid="bot-run-state-error" role="alert">
            {RUN_STATE_FAILED[bot.runState]}
          </small>
        ) : null}
      </span>
      <button
        type="button"
        className={bot.runState === "paused" ? "primary-button" : "ghost-button"}
        data-testid={bot.runState === "paused" ? "bot-resume" : "bot-pause"}
        disabled={request === "busy"}
        onClick={() => void change()}
      >
        {bot.runState === "paused" ? "继续" : "暂停"}
      </button>
    </div>
  );
};

export const BotSettingsPanel = ({ bot, tools, onChange, onPause, onResume, onOpenTools }: Props) => {
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
      {tab === "routines" ? <RoutinesTab botId={bot.id} key={bot.id} /> : null}
      {tab === "skills" ? <SkillsTab botId={bot.id} key={bot.id} /> : null}
      {tab === "settings" ? (
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
          <RunStateRow bot={bot} onPause={onPause} onResume={onResume} key={bot.id} />
          <button
            type="button"
            className="row-card bot-tools-link"
            data-testid="bot-available-tools"
            onClick={onOpenTools}
          >
            <span>
              <b>可用工具</b>
              <small data-testid="bot-available-tools-summary">
                {tools
                  .filter((tool) => tool.assignedBotIds.includes(bot.id))
                  .map((tool) => tool.name)
                  .join(" · ") || "还没勾。去「设置 · 工具」连 MCP 再勾给它"}
              </small>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
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
      ) : null}
    </aside>
  );
};
