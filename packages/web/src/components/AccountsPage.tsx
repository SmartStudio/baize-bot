import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  BrowserPlatform,
  type Account,
  type AccountId,
  type AccountTier,
  type Computer,
  type ComputerId,
  type OAuthPlatform,
} from "@baize/shared";
import { oauthStartUrl } from "../api/client.js";
import { useApp } from "../state/app.js";
import type { LoginFlow } from "../state/types.js";
import { loginFlowNote } from "./LoginCard.js";
import {
  COMPUTER_STATUS_CLASS,
  COMPUTER_STATUS_TEXT,
  LOGIN_FAILURE_TEXT,
  LOGIN_TEXT,
  PLATFORM,
  TIER,
  TIERS,
  blockedTier,
  computerName,
  timeText,
} from "./messages/content.js";

type Props = {
  accounts: Account[];
  computers: Record<string, Computer>;
  onLoad: () => Promise<void>;
  onChangeTier: (accountId: AccountId, tier: AccountTier) => Promise<void>;
};

type Load = "loading" | "ready" | "failed";

type Change = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

type Login = { flows: Partial<Record<AccountId, LoginFlow>>; open: (accountId: AccountId) => Promise<void> };

// 扫码登录的平台没登上时，行上就能开登录窗口，不用回首页找卡。点了之后怎么样了跟首页的卡同一套说法。
const LoginAction = ({ account, where, login }: { account: Account; where: string; login: Login }) => {
  const flow = login.flows[account.id];
  const note = loginFlowNote(flow, where);
  const opening = flow?.status === "opening";
  return (
    <div className="account-login-action" data-testid="account-login-action">
      {note === null ? null : (
        <small
          className={note.alert ? "account-login-note is-alert" : "account-login-note"}
          data-testid="login-card-note"
          role={note.alert ? "alert" : undefined}
        >
          {note.text}
        </small>
      )}
      <button
        type="button"
        className="primary-button"
        data-testid="login-open"
        disabled={opening}
        onClick={() => void login.open(account.id).catch(() => undefined)}
      >
        {opening ? "等你扫码…" : "打开登录窗口"}
      </button>
    </div>
  );
};

const AccountRow = ({
  account,
  computer,
  login,
  onChangeTier,
}: {
  account: Account;
  computer: Computer | undefined;
  login: Login;
  onChangeTier: Props["onChangeTier"];
}) => {
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<Change>({ status: "idle" });
  const choose = (tier: AccountTier) => {
    if (tier === account.tier || change.status === "busy") return;
    setChange({ status: "busy" });
    onChangeTier(account.id, tier)
      .then(() => setChange({ status: "idle" }))
      .catch((cause: unknown) =>
        setChange({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };
  const handle = account.handle ?? "未登录";
  return (
    <div className="account-row" data-testid="account-row" data-tier={account.tier} data-login={account.login}>
      <button
        type="button"
        className="row-card account-row-head"
        data-testid="account-tier-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          <b>
            {PLATFORM[account.platform]} · {handle}
          </b>
          <small data-testid="account-where">
            在{computer === undefined ? "未同步的电脑" : computerName(computer)} · 权限「{TIER[account.tier].title}」
          </small>
          <small className="account-login" data-testid="account-login">
            {LOGIN_TEXT[account.login]}
            {account.login === "expired" ? ` · ${timeText(account.loginChangedAt)}` : ""}
          </small>
          {account.lastLoginFailure === null ? null : (
            <small className="account-login-failure" data-testid="account-login-failure">
              上次登录没成（{timeText(account.lastLoginFailure.at)}）：
              {LOGIN_FAILURE_TEXT[account.lastLoginFailure.reason]}
            </small>
          )}
        </span>
        <span className="account-tier" data-testid="account-tier">
          {TIER[account.tier].title}
        </span>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button>
      {account.login !== "valid" && BrowserPlatform.safeParse(account.platform).success ? (
        <LoginAction
          account={account}
          where={computer === undefined ? "账号所在的电脑" : computerName(computer)}
          login={login}
        />
      ) : null}
      {open ? (
        <fieldset className="account-tiers" aria-label={`${handle} 的档位`} disabled={change.status === "busy"}>
          {TIERS.map((tier) => {
            const blocked = blockedTier(account.platform, tier);
            return (
              <label
                key={tier}
                className={`account-tier-option${blocked === null ? "" : " is-blocked"}`}
                data-testid="account-tier-option"
                data-tier={tier}
              >
                <input
                  type="radio"
                  name={`tier-${account.id}`}
                  checked={account.tier === tier}
                  disabled={blocked !== null}
                  onChange={() => choose(tier)}
                />
                <span>
                  <b>{TIER[tier].title}</b>
                  <small>{TIER[tier].note}</small>
                  {blocked === null ? null : (
                    <small className="account-tier-reason" data-testid="account-tier-reason">
                      {blocked}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
          {change.status === "failed" ? (
            <small className="account-tier-error" role="alert">
              没换成：{change.message}
            </small>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
};

type Group = { computerId: ComputerId; computer: Computer | undefined; accounts: Account[] };

// 本机在前，远程在后，表里还没有的电脑排最后；组内保持列表原来的顺序。
const groupsOf = (accounts: Account[], computers: Record<string, Computer>): Group[] => {
  const groups = new Map<ComputerId, Group>();
  for (const account of accounts) {
    const group = groups.get(account.computerId);
    if (group === undefined) {
      groups.set(account.computerId, {
        computerId: account.computerId,
        computer: computers[account.computerId],
        accounts: [account],
      });
    } else group.accounts.push(account);
  }
  const rank = (group: Group): number => (group.computer === undefined ? 2 : group.computer.kind === "local" ? 0 : 1);
  return [...groups.values()].sort((left, right) => rank(left) - rank(right));
};

const OAUTH_PLATFORMS: OAuthPlatform[] = ["github", "x"];

type Connect = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

// OAuth 平台整页跳去平台授权，回来落在首页，结果由主窗口读查询串提示。
// 扫码登录的平台先在本机建一个未登录的号（已经有就用那个），再在它上面开登录窗口，扫码的进度写在那一行上。
const ConnectEntries = ({ local, login }: { local: Computer | undefined; login: Login }) => {
  const { actions } = useApp();
  const [connect, setConnect] = useState<Connect>({ status: "idle" });
  const start = (platform: BrowserPlatform) => {
    if (local === undefined || connect.status === "busy") return;
    setConnect({ status: "busy" });
    actions
      .addAccount(platform, local.id)
      .then(async (accountId) => {
        if (accountId !== undefined) await login.open(accountId);
        setConnect({ status: "idle" });
      })
      .catch((cause: unknown) =>
        setConnect({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };
  return (
    <div className="account-connect" data-testid="account-connect">
      {OAUTH_PLATFORMS.map((platform) => (
        <a
          key={platform}
          className="ghost-button"
          href={oauthStartUrl(platform)}
          data-testid="account-connect-link"
          data-platform={platform}
        >
          接入 {PLATFORM[platform]}
        </a>
      ))}
      {BrowserPlatform.options.map((platform) => (
        <button
          type="button"
          key={platform}
          className="ghost-button"
          data-testid="account-connect-browser"
          data-platform={platform}
          disabled={local === undefined || connect.status === "busy"}
          title={local === undefined ? "要在装了白泽的本机上扫码登录" : undefined}
          onClick={() => start(platform)}
        >
          接入 {PLATFORM[platform]}
        </button>
      ))}
      {connect.status === "failed" ? (
        <small className="account-connect-error" data-testid="account-connect-error" role="alert">
          没接上：{connect.message}
        </small>
      ) : null}
    </div>
  );
};

// 进来就重拉一遍。拉不到得明说，不然空表会被读成「真的没有账号」。
export const AccountsPage = ({ accounts, computers, onLoad, onChangeTier }: Props) => {
  const { state, actions } = useApp();
  const login: Login = {
    flows: state.status === "ready" ? state.content.logins : {},
    open: actions.loginAccount,
  };
  const local = Object.values(computers).find((computer) => computer.kind === "local");
  const [load, setLoad] = useState<Load>("loading");
  const fetchAccounts = useCallback(() => {
    onLoad().then(
      () => setLoad("ready"),
      () => setLoad("failed"),
    );
  }, [onLoad]);
  useEffect(fetchAccounts, [fetchAccounts]);
  const retry = () => {
    setLoad("loading");
    fetchAccounts();
  };

  return (
    <>
      <ConnectEntries local={local} login={login} />
      {load === "failed" ? (
        <p className="later" data-testid="accounts-failed" role="alert">
          账号没取到。{" "}
          <button type="button" className="ghost-button" data-testid="accounts-retry" onClick={retry}>
            重试
          </button>
        </p>
      ) : null}
      {accounts.length > 0 ? (
        <div className="accounts-page" data-testid="accounts-page">
          {groupsOf(accounts, computers).map((group) => (
            <section
              className="account-group"
              data-testid="account-group"
              data-computer-id={group.computerId}
              key={group.computerId}
            >
              <header className="account-group-head" data-testid="account-group-head">
                <b>{group.computer === undefined ? "未同步的电脑" : computerName(group.computer)}</b>
                {group.computer === undefined ? null : (
                  <span className="computer-status" data-status={group.computer.status}>
                    <i className={`status-dot ${COMPUTER_STATUS_CLASS[group.computer.status]}`} aria-hidden="true" />
                    {COMPUTER_STATUS_TEXT[group.computer.status]}
                  </span>
                )}
              </header>
              {group.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  computer={group.computer}
                  login={login}
                  onChangeTier={onChangeTier}
                />
              ))}
            </section>
          ))}
        </div>
      ) : load === "ready" ? (
        <p className="later" data-testid="accounts-empty">
          还没有接入的平台账号
        </p>
      ) : load === "loading" ? (
        <p className="later">正在读取账号…</p>
      ) : null}
    </>
  );
};
