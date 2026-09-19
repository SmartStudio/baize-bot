import { useEffect, useState } from "react";
import { Cpu, Download, Gauge, Plug, Settings as SettingsIcon, X } from "lucide-react";
import { Settings, type Bot, type BotId, type UsageResponse, type User } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";

type PageId = "general" | "computer" | "tools" | "usage" | "update";

const PAGES: Record<PageId, { title: string; icon: React.ReactNode }> = {
  general: { title: "通用", icon: <SettingsIcon size={16} aria-hidden="true" /> },
  computer: { title: "电脑", icon: <Cpu size={16} aria-hidden="true" /> },
  tools: { title: "工具", icon: <Plug size={16} aria-hidden="true" /> },
  usage: { title: "用量与账单", icon: <Gauge size={16} aria-hidden="true" /> },
  update: { title: "更新", icon: <Download size={16} aria-hidden="true" /> },
};

const PAGE_IDS = Object.keys(PAGES) as PageId[];

type Props = {
  user: User;
  settings: Settings;
  usage: UsageResponse;
  bots: Record<BotId, Bot>;
  initialPage?: PageId;
  onLoadUsage: () => Promise<void>;
  onChange: (patch: Partial<Settings>) => Promise<void>;
  onLogout: () => void;
  onClose: () => void;
};

const GeneralPage = ({
  user,
  settings,
  onChange,
  onLogout,
}: Pick<Props, "user" | "settings" | "onChange" | "onLogout">) => (
  <>
    <p className="group-label">账户</p>
    <div className="row-card">
      <span className="account-body">
        <b>{user.name}</b>
        <small>
          {user.email} · {user.teamName}
        </small>
      </span>
      <button type="button" className="ghost-button" data-testid="settings-logout" onClick={onLogout}>
        退出登录
      </button>
    </div>

    <p className="group-label">外观</p>
    <div className="row-card">
      <span>
        <b>主题</b>
      </span>
      <select
        data-testid="theme-select"
        aria-label="主题"
        value={settings.theme}
        onChange={(e) => void onChange({ theme: Settings.shape.theme.parse(e.target.value) })}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>

    <p className="group-label">Bot 找你的方式</p>
    <div className="row-card">
      <span>
        <b>需要你点头时通知</b>
        <small>对外发送、改生产数据、付钱。系统通知。</small>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={settings.notify}
        aria-label="通知"
        className={`switch${settings.notify ? " is-on" : ""}`}
        data-testid="notify-switch"
        onClick={() => void onChange({ notify: !settings.notify })}
      />
    </div>
    <div className="row-card">
      <span>
        <b>免打扰</b>
        <small>这段时间 Bot 照常干活，等你点头的事攒到早上一起来。</small>
      </span>
      <span className="dnd">
        <input
          type="time"
          aria-label="免打扰开始"
          data-testid="dnd-from"
          value={settings.dndFrom ?? ""}
          onChange={(e) => void onChange({ dndFrom: e.target.value === "" ? null : e.target.value })}
        />
        <span aria-hidden="true">–</span>
        <input
          type="time"
          aria-label="免打扰结束"
          data-testid="dnd-to"
          value={settings.dndTo ?? ""}
          onChange={(e) => void onChange({ dndTo: e.target.value === "" ? null : e.target.value })}
        />
      </span>
    </div>
  </>
);

const money = (amount: number): string => `¥${amount.toFixed(1)}`;

const when = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const UsagePage = ({ usage, bots }: Pick<Props, "usage" | "bots">) => (
  <div className="usage-page" data-testid="usage-page">
    <section className="usage-section">
      <h3>本周</h3>
      <div className="usage-panel">
        <div className="usage-summary">
          <strong data-testid="usage-total">{money(usage.total)}</strong>
          <span>周预算 · 后续</span>
        </div>
        <div className="usage-bots" data-testid="usage-bots">
          {usage.bots.map((line) => {
            const bot = bots[line.botId];
            return (
              <div className="usage-bot" key={line.botId}>
                <span className="usage-bot-name">
                  <i
                    className="usage-hue"
                    style={{ background: `var(--bot-${bot?.hue ?? "sky"})` }}
                    aria-hidden="true"
                  />
                  {bot?.name ?? "已删除的 Bot"}
                  <small>{line.runs} 次运行</small>
                </span>
                <strong>{money(line.amount)}</strong>
              </div>
            );
          })}
        </div>
        <div className="usage-future" aria-label="后续功能">
          <span>快用完时提醒 · 后续</span>
          <span>负责人加额 · 后续</span>
          <span>默认档位 · 后续</span>
        </div>
      </div>
    </section>
    <section className="usage-section">
      <h3>最近任务</h3>
      <div className="usage-panel">
        <div className="usage-run-head" aria-hidden="true">
          <span>任务</span>
          <span>时间</span>
          <span>花费</span>
        </div>
        <div data-testid="usage-recent">
          {usage.recent.map((run) => {
            const bot = run.botId === null ? undefined : bots[run.botId];
            return (
              <div className="usage-run" key={run.runId}>
                <span className="usage-run-title">
                  {bot ? <BotAvatar name={bot.name} hue={bot.hue} size="xs" /> : null}
                  <span title={run.title}>{run.title}</span>
                </span>
                <time dateTime={run.startedAt}>{when.format(new Date(run.startedAt))}</time>
                <strong>{money(run.amount)}</strong>
              </div>
            );
          })}
        </div>
        <div className="usage-foot">
          <span>对内第一版只看用量，团队统一结算是后续。</span>
          <span>导出本月明细 · 后续</span>
        </div>
      </div>
    </section>
  </div>
);

export const SettingsWindow = ({
  user,
  settings,
  usage,
  bots,
  initialPage = "general",
  onLoadUsage,
  onChange,
  onLogout,
  onClose,
}: Props) => {
  const [page, setPage] = useState<PageId>(initialPage);
  const current = PAGES[page];

  useEffect(() => {
    if (page === "usage") void onLoadUsage();
  }, [page, onLoadUsage]);

  return (
    <div className="scrim" data-testid="settings-window">
      <div className="settings">
        <nav className="settings-nav">
          <b>设置</b>
          {PAGE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`menu-row${id === page ? " is-selected" : ""}`}
              data-testid={`settings-nav-${id}`}
              onClick={() => setPage(id)}
            >
              {PAGES[id].icon}
              {PAGES[id].title}
            </button>
          ))}
        </nav>
        <section className="settings-page">
          <header className="settings-page-head">
            <h2>{current.title}</h2>
            <button
              type="button"
              className="icon-button"
              data-testid="settings-close"
              aria-label="关闭设置"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </header>
          {page === "general" ? (
            <GeneralPage user={user} settings={settings} onChange={onChange} onLogout={onLogout} />
          ) : page === "usage" ? (
            <UsagePage usage={usage} bots={bots} />
          ) : (
            <p className="later" data-testid="settings-later">
              {current.title} · 后续
            </p>
          )}
        </section>
      </div>
    </div>
  );
};
