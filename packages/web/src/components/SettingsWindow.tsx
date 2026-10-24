import { useEffect, useState, type FormEvent } from "react";
import { AtSign, Gauge, Puzzle, Settings as SettingsIcon, Shield, X } from "lucide-react";
import { useEscapeToClose } from "./useEscapeToClose.js";
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
import { PrivacyPage } from "./PrivacyPage.js";
import { inDesktopShell, notifyPermission, type NotifyPermission } from "../state/notify.js";

export type PageId = "general" | "accounts" | "tools" | "usage" | "privacy";

const PAGES: Record<PageId, { title: string; icon: React.ReactNode }> = {
  general: { title: "通用", icon: <SettingsIcon size={16} aria-hidden="true" /> },
  accounts: { title: "账号与电脑", icon: <AtSign size={16} aria-hidden="true" /> },
  tools: { title: "插件", icon: <Puzzle size={16} aria-hidden="true" /> },
  usage: { title: "用量", icon: <Gauge size={16} aria-hidden="true" /> },
  privacy: { title: "数据与隐私", icon: <Shield size={16} aria-hidden="true" /> },
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
  // 首页版本号，重连和审批变化都会让它加一。账号与电脑页开着就照它重拉授权，补上断线期间别处撤掉的和别处新批的。
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

const PERMISSION_TEXT: Record<NotifyPermission, string> = {
  default: "浏览器还没允许白泽发通知。允许之后，上面那个开关开着才弹得出系统通知。",
  granted: "已开启，Bot 找你时浏览器会弹系统通知。",
  denied: "浏览器拒绝了白泽的通知。要收通知，到地址栏左边的网站设置里把「通知」改成允许。",
  unsupported: "这个浏览器发不了系统通知。",
};

// 桌面 App 的通知由壳自己弹，不经过浏览器授权，这一行只在浏览器里出现。
const NotifyPermissionRow = () => {
  const [permission, setPermission] = useState(notifyPermission);
  const [asking, setAsking] = useState(false);
  if (inDesktopShell()) return null;
  const ask = () => {
    setAsking(true);
    void Notification.requestPermission()
      .then(setPermission)
      .finally(() => setAsking(false));
  };
  return (
    <div className="row-card" data-testid="notify-permission" data-state={permission}>
      <span>
        <b>浏览器通知</b>
        <small>{PERMISSION_TEXT[permission]}</small>
      </span>
      {permission === "default" ? (
        <button
          type="button"
          className="ghost-button"
          data-testid="notify-permission-request"
          disabled={asking}
          onClick={ask}
        >
          允许通知
        </button>
      ) : null}
    </div>
  );
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
    <NotifyPermissionRow />
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
// 预算只收整数元，照原样写，不带小数。
const budgetText = (budget: number): string => `¥${budget}`;

const monthDay = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" });

const when = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type BudgetEdit =
  | { status: "viewing" }
  | { status: "editing"; draft: string; error: string | null }
  | { status: "saving"; draft: string };

// 预算是设置里的一项，读写都走 settings；用量回包里那份 budget 要等下次拉用量才跟上，这里不读它。
const BudgetRow = ({ budget, onChange }: { budget: number | null; onChange: Props["onChange"] }) => {
  const [edit, setEdit] = useState<BudgetEdit>({ status: "viewing" });
  const save = async (next: number | null, draft: string) => {
    setEdit({ status: "saving", draft });
    try {
      await onChange({ budget: next });
      setEdit({ status: "viewing" });
    } catch (cause) {
      setEdit({ status: "editing", draft, error: cause instanceof Error ? cause.message : "没存上，请重试" });
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (edit.status !== "editing") return;
    const amount = Number(edit.draft);
    if (!Number.isInteger(amount) || amount <= 0) {
      setEdit({ ...edit, error: "填一个大于 0 的整数，单位是元" });
      return;
    }
    void save(amount, edit.draft);
  };

  if (edit.status === "viewing") {
    return (
      <div className="row-card">
        <span>
          <b>每月预算</b>
          <small>用到 80% 提醒你一次；到了预算，例行的自动触发就停下，你自己派的活照常。</small>
        </span>
        <button
          type="button"
          className="ghost-button"
          data-testid="budget-edit"
          onClick={() => setEdit({ status: "editing", draft: budget === null ? "" : String(budget), error: null })}
        >
          {budget === null ? "设一个" : `${budgetText(budget)} · 改`}
        </button>
      </div>
    );
  }
  const saving = edit.status === "saving";
  return (
    <form className="row-card budget-form" data-testid="budget-form" onSubmit={submit}>
      <label className="field">
        <span>每月预算（元）</span>
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          data-testid="budget-input"
          value={edit.draft}
          disabled={saving}
          onChange={(event) => setEdit({ status: "editing", draft: event.target.value, error: null })}
        />
        {edit.status === "editing" && edit.error !== null ? (
          <small className="error" role="alert" data-testid="budget-error">
            {edit.error}
          </small>
        ) : null}
      </label>
      <span className="budget-actions">
        {budget === null ? null : (
          <button
            type="button"
            className="ghost-button"
            data-testid="budget-clear"
            disabled={saving}
            onClick={() => void save(null, edit.draft)}
          >
            不设预算
          </button>
        )}
        <button type="button" className="ghost-button" disabled={saving} onClick={() => setEdit({ status: "viewing" })}>
          取消
        </button>
        <button type="submit" className="primary-button" data-testid="budget-save" disabled={saving}>
          存
        </button>
      </span>
    </form>
  );
};

const UsagePage = ({
  usage,
  bots,
  budget,
  onChange,
}: Pick<Props, "usage" | "bots" | "onChange"> & { budget: number | null }) => (
  <div className="usage-page" data-testid="usage-page">
    <section className="usage-section">
      <h3>本月 · {monthDay.format(new Date(usage.monthStartsAt))}到今天，所有 Bot 加起来</h3>
      <div className="usage-panel">
        <div className="usage-summary">
          <strong data-testid="usage-total">{money(usage.total)}</strong>
          <span data-testid="usage-budget">{budget === null ? "没设预算" : `/ 预算 ${budgetText(budget)}`}</span>
        </div>
        {budget === null ? null : (
          <div
            className="usage-meter"
            data-testid="usage-meter"
            role="meter"
            aria-label="本月花费占预算"
            aria-valuemin={0}
            aria-valuemax={budget}
            aria-valuenow={Math.min(usage.total, budget)}
          >
            <i style={{ width: `${Math.min(100, (usage.total / budget) * 100)}%` }} />
          </div>
        )}
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
      </div>
    </section>
    <section className="usage-section">
      <h3>预算</h3>
      <BudgetRow budget={budget} onChange={onChange} />
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
                  {bot ? <BotAvatar shape={bot.shape} hue={bot.hue} size="xs" /> : null}
                  <span title={run.title}>{run.title}</span>
                </span>
                <time dateTime={run.startedAt}>{when.format(new Date(run.startedAt))}</time>
                <strong>{money(run.amount)}</strong>
              </div>
            );
          })}
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
  onChangeTier,
  onChange,
  onLogout,
  onClose,
}: Props) => {
  const [page, setPage] = useState<PageId>(initialPage);
  const current = PAGES[page];
  useEscapeToClose(onClose);

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
          ) : page === "accounts" ? (
            <AccountsPage
              accounts={accounts}
              computers={computers}
              grants={grants}
              projectNames={projectNames}
              grantsVersion={grantsVersion}
              onLoad={onLoadAccounts}
              onLoadGrants={onLoadGrants}
              onRevokeGrant={onRevokeGrant}
              onChangeTier={onChangeTier}
            />
          ) : page === "tools" ? (
            <ToolsPage
              tools={tools}
              bots={bots}
              onCreate={onCreateTool}
              onUpdate={onUpdateTool}
              onDelete={onDeleteTool}
            />
          ) : page === "usage" ? (
            <UsagePage usage={usage} bots={bots} budget={settings.budget} onChange={onChange} />
          ) : (
            <PrivacyPage user={user} />
          )}
        </section>
      </div>
    </div>
  );
};
