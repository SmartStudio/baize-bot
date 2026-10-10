import { useEffect, useState } from "react";
import { AtSign, Cpu, Download, Gauge, KeyRound, Plug, Settings as SettingsIcon, X } from "lucide-react";
import {
  Settings,
  type Account,
  type AccountId,
  type AccountTier,
  type Bot,
  type BotId,
  type Computer,
  type CreateToolRequest,
  type Grant,
  type GrantId,
  type GroupId,
  type ToolConnection,
  type ToolConnectionId,
  type UpdateToolRequest,
  type UsageResponse,
  type User,
} from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import { ToolsPage } from "./ToolsPage.js";
import { AccountsPage } from "./AccountsPage.js";
import { COMPUTER_STATUS_CLASS, COMPUTER_STATUS_TEXT } from "./messages/content.js";
import { ACTION_TEXT, SCOPE_TEXT, targetText } from "./grantText.js";

export type PageId = "general" | "computer" | "accounts" | "tools" | "grants" | "usage" | "update";

const PAGES: Record<PageId, { title: string; icon: React.ReactNode }> = {
  general: { title: "通用", icon: <SettingsIcon size={16} aria-hidden="true" /> },
  computer: { title: "电脑", icon: <Cpu size={16} aria-hidden="true" /> },
  accounts: { title: "账号", icon: <AtSign size={16} aria-hidden="true" /> },
  tools: { title: "工具", icon: <Plug size={16} aria-hidden="true" /> },
  grants: { title: "授权", icon: <KeyRound size={16} aria-hidden="true" /> },
  usage: { title: "用量与账单", icon: <Gauge size={16} aria-hidden="true" /> },
  update: { title: "更新", icon: <Download size={16} aria-hidden="true" /> },
};

const PAGE_IDS = Object.keys(PAGES) as PageId[];

type Props = {
  user: User;
  settings: Settings;
  usage: UsageResponse;
  bots: Record<BotId, Bot>;
  tools: ToolConnection[];
  grants: Grant[];
  projectNames: Record<GroupId, string>;
  accounts: Account[];
  computers: Record<string, Computer>;
  // 首页版本号，重连和审批变化都会让它加一。授权页开着就照它重拉，补上断线期间别处撤掉的和别处新批的授权。
  grantsVersion: number;
  initialPage?: PageId;
  onCreateTool: (draft: CreateToolRequest) => Promise<void>;
  onUpdateTool: (id: ToolConnectionId, patch: UpdateToolRequest) => Promise<void>;
  onDeleteTool: (id: ToolConnectionId) => Promise<void>;
  onLoadUsage: () => Promise<void>;
  onLoadGrants: () => Promise<void>;
  onRevokeGrant: (id: GrantId) => Promise<void>;
  onLoadAccounts: () => Promise<void>;
  onLoadComputers: () => Promise<void>;
  onChangeTier: (id: AccountId, tier: AccountTier) => Promise<void>;
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
        <small>{user.email}</small>
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

const GrantRow = ({
  grant,
  projectName,
  onRevoke,
}: {
  grant: Grant;
  projectName: string | undefined;
  onRevoke: (id: GrantId) => Promise<void>;
}) => {
  const [revoke, setRevoke] = useState<"idle" | "busy" | "failed">("idle");
  const run = async () => {
    setRevoke("busy");
    try {
      await onRevoke(grant.id);
    } catch {
      setRevoke("failed");
    }
  };
  return (
    <div className="row-card grant-row" data-testid="grant-row" data-grant-id={grant.id}>
      <span>
        <b>{SCOPE_TEXT[grant.scope]}</b>
        <small>
          {ACTION_TEXT[grant.action]} · {targetText(grant.target)}
        </small>
        {grant.scope === "project" ? <small>项目：{projectName ?? "已删除的对话"}</small> : null}
        {revoke === "failed" ? (
          <small className="grant-error" data-testid="grant-revoke-error" role="alert">
            没撤掉，再试一次
          </small>
        ) : null}
      </span>
      <button
        type="button"
        className="ghost-button"
        data-testid="grant-revoke"
        disabled={revoke === "busy"}
        onClick={() => void run()}
      >
        撤销
      </button>
    </div>
  );
};

const GrantsPage = ({
  grants,
  projectNames,
  loading,
  error,
  onRevoke,
}: {
  grants: Grant[];
  projectNames: Record<GroupId, string>;
  loading: boolean;
  error: string | null;
  onRevoke: (id: GrantId) => Promise<void>;
}) => {
  if (loading) return <p className="later">正在加载授权…</p>;
  if (error !== null) {
    return (
      <p className="later" data-testid="grants-error" role="alert">
        授权列表加载失败：{error}
      </p>
    );
  }
  if (grants.length === 0) {
    return (
      <p className="later" data-testid="grants-empty">
        还没有长期授权
      </p>
    );
  }
  return (
    <div className="grants-page" data-testid="grants-page">
      {grants.map((grant) => (
        <GrantRow
          key={grant.id}
          grant={grant}
          projectName={grant.scope === "project" ? projectNames[grant.groupId] : undefined}
          onRevoke={onRevoke}
        />
      ))}
    </div>
  );
};

const COMPUTER_KIND_TEXT: Record<Computer["kind"], string> = {
  local: "本机",
  remote: "远程",
};

type ComputerLoad = { status: "loading" | "ready" } | { status: "failed"; message: string };

// 列表读的是 store 里那张表，computer_updated 推送写的也是它，别处上下线这里跟着变。进页再拉一次补断线期间错过的。
const ComputerPage = ({ computers, onLoad }: { computers: Record<string, Computer>; onLoad: () => Promise<void> }) => {
  const [load, setLoad] = useState<ComputerLoad>({ status: "loading" });

  useEffect(() => {
    let active = true;
    onLoad().then(
      () => active && setLoad({ status: "ready" }),
      (cause: unknown) =>
        active &&
        setLoad({ status: "failed", message: cause instanceof Error ? cause.message : "加载电脑失败，请重试" }),
    );
    return () => {
      active = false;
    };
  }, [onLoad]);

  const rows = Object.values(computers);
  if (load.status === "failed" && rows.length === 0) {
    return (
      <p className="later" data-testid="computer-error" role="alert">
        电脑列表加载失败：{load.message}
      </p>
    );
  }
  if (load.status === "loading" && rows.length === 0) {
    return (
      <p className="later" data-testid="computer-loading">
        加载中…
      </p>
    );
  }

  return (
    <div className="computers-page" data-testid="computer-list">
      {rows.map((computer) => (
        <div
          className="row-card computer-row"
          data-testid="computer-row"
          data-computer-id={computer.id}
          key={computer.id}
        >
          <span>
            <b>{COMPUTER_KIND_TEXT[computer.kind]}</b>
          </span>
          <span className="computer-status" data-testid="computer-status" data-status={computer.status}>
            <i className={`status-dot ${COMPUTER_STATUS_CLASS[computer.status]}`} aria-hidden="true" />
            <b>{COMPUTER_STATUS_TEXT[computer.status]}</b>
          </span>
        </div>
      ))}
    </div>
  );
};

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
      <h3>本月</h3>
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
  tools,
  grants,
  projectNames,
  accounts,
  computers,
  grantsVersion,
  initialPage = "general",
  onCreateTool,
  onUpdateTool,
  onDeleteTool,
  onLoadUsage,
  onLoadGrants,
  onRevokeGrant,
  onLoadAccounts,
  onLoadComputers,
  onChangeTier,
  onChange,
  onLogout,
  onClose,
}: Props) => {
  const [page, setPage] = useState<PageId>(initialPage);
  const [grantsLoading, setGrantsLoading] = useState(initialPage === "grants");
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const current = PAGES[page];

  useEffect(() => {
    if (page === "usage") void onLoadUsage();
  }, [page, onLoadUsage]);

  useEffect(() => {
    if (page !== "grants") return;
    void onLoadGrants()
      .then(() => setGrantsError(null))
      .catch((cause: unknown) => setGrantsError(cause instanceof Error ? cause.message : "请重试"))
      .finally(() => setGrantsLoading(false));
  }, [page, grantsVersion, onLoadGrants]);

  const selectPage = (next: PageId) => {
    if (next === page) return;
    if (next === "grants") {
      setGrantsLoading(true);
      setGrantsError(null);
    }
    setPage(next);
  };

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
              onClick={() => selectPage(id)}
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
          ) : page === "tools" ? (
            <ToolsPage
              tools={tools}
              bots={bots}
              onCreate={onCreateTool}
              onUpdate={onUpdateTool}
              onDelete={onDeleteTool}
            />
          ) : page === "computer" ? (
            <ComputerPage computers={computers} onLoad={onLoadComputers} />
          ) : page === "accounts" ? (
            <AccountsPage
              accounts={accounts}
              computers={computers}
              onLoad={onLoadAccounts}
              onChangeTier={onChangeTier}
            />
          ) : page === "grants" ? (
            <GrantsPage
              grants={grants}
              projectNames={projectNames}
              loading={grantsLoading}
              error={grantsError}
              onRevoke={onRevokeGrant}
            />
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
