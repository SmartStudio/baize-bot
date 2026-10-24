import { useState } from "react";
import { ChevronRight, Pencil, X } from "lucide-react";
import { BotHue, BotShape, type Bot, type BotId } from "@baize/shared";
import type { BotDraft } from "../api/client.js";
import { BotAvatar, SHAPES } from "./BotAvatar.js";

type Props = {
  bot: Bot;
  onChange: (botId: BotId, draft: BotDraft) => Promise<void>;
  onPause: (botId: BotId) => Promise<void>;
  onResume: (botId: BotId) => Promise<void>;
  onClose: () => void;
};

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

// 颜色和形状建好之后很少再改，默认收着，点头像才摊开，免得每次打开设置都先看到一排选项。
const BotLookPicker = ({ bot, commit }: { bot: Bot; commit: (draft: BotDraft) => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <header className="bot-panel-head">
      <button
        type="button"
        className="bot-look-toggle"
        data-testid="bot-look-toggle"
        aria-expanded={open}
        aria-label={open ? "收起颜色和形状" : "换颜色和形状"}
        title={open ? "收起" : "换颜色和形状"}
        onClick={() => setOpen(!open)}
      >
        <BotAvatar shape={bot.shape} hue={bot.hue} size="lg" />
        <span className="bot-look-badge" aria-hidden="true">
          <Pencil size={12} />
        </span>
      </button>
      {open ? (
        <>
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
        </>
      ) : null}
    </header>
  );
};

// 名字、标签、描述改在 Bot 页头部的编辑弹窗里；这里只剩颜色、形状、通知和暂停，颜色和形状收在头像后面。
// 技能不在这里配：头部「它知道的」里能看，加、改、删跟它在对话里说。
export const BotSettingsPanel = ({ bot, onChange, onPause, onResume, onClose }: Props) => {
  const [save, setSave] = useState<"idle" | "failed">("idle");
  const commit = (draft: BotDraft) => {
    setSave("idle");
    onChange(bot.id, draft).catch(() => setSave("failed"));
  };

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
      <BotLookPicker bot={bot} commit={commit} />
      {save === "failed" ? (
        <p className="bot-settings-error" data-testid="bot-settings-error" role="alert">
          没存上，再试一次
        </p>
      ) : null}
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
      <RunStateRow bot={bot} onPause={onPause} onResume={onResume} />
      {LATER_ROWS.map((row) => (
        <div className="row-card is-later" key={row.title}>
          <span>
            <b>{row.title}</b>
            <small>{row.note}</small>
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </div>
      ))}
    </aside>
  );
};
