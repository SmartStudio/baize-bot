import { useState } from "react";
import { ChevronRight, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { BotHue, BotShape, type Bot, type BotId } from "@baize/shared";
import type { BotDraft } from "../api/client.js";
import { BotAvatar, SHAPES } from "./BotAvatar.js";
import { SkillsTab } from "./skills/SkillsTab.js";

type Props = {
  bot: Bot;
  onChange: (botId: BotId, draft: BotDraft) => Promise<void>;
  onPause: (botId: BotId) => Promise<void>;
  onResume: (botId: BotId) => Promise<void>;
  onClose: () => void;
};

type Tab = "settings" | "skills";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "settings", label: "设置", icon: <SlidersHorizontal size={14} aria-hidden="true" /> },
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

// 名字、标签、描述改在 Bot 页头部的编辑弹窗里；这里只剩颜色、形状、通知和暂停。
export const BotSettingsPanel = ({ bot, onChange, onPause, onResume, onClose }: Props) => {
  const [tab, setTab] = useState<Tab>("settings");

  const commit = (draft: BotDraft) => void onChange(bot.id, draft);

  return (
    <aside className="bot-panel" data-testid="bot-panel">
      <button
        type="button"
        className="icon-button bot-panel-close"
        data-testid="bot-panel-close"
        aria-label="收起 Bot 设置"
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <header className="bot-panel-head">
        <BotAvatar shape={bot.shape} hue={bot.hue} size="lg" />
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
        <div className="bot-shape-options" role="group" aria-label="形状">
          {BotShape.options.map((shape) => (
            <button
              key={shape}
              type="button"
              aria-pressed={shape === bot.shape}
              aria-label={SHAPES[shape].name}
              className={`bot-shape-option${shape === bot.shape ? " is-selected" : ""}`}
              data-testid="bot-shape-option"
              data-shape={shape}
              onClick={() => commit({ shape })}
            >
              <BotAvatar shape={shape} hue={bot.hue} size="sm" />
            </button>
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
      {tab === "skills" ? <SkillsTab botId={bot.id} key={bot.id} /> : null}
      {tab === "settings" ? (
        <>
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
