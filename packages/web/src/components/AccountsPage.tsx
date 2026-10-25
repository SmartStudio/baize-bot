import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  type Account,
  type AccountId,
  type AccountTier,
  type Computer,
  type ComputerId,
  type Grant,
  type GrantId,
  type GroupId,
} from "@baize/shared";
import { useApp, type RemotePairing } from "../state/app.js";
import { openTerminal } from "../state/live.js";
import type { LoginFlow } from "../state/types.js";
import { ConnectEntries } from "./ConnectEntries.js";
import { ScopeReconnect } from "./ScopeReconnect.js";
import { loginFlowNote } from "./LoginCard.js";
import { useFailureToast } from "./Toasts.js";
import { ACTION_TEXT, SCOPE_TEXT, targetText } from "./grantText.js";
import {
  COMPUTER_KIND_TEXT,
  COMPUTER_STATUS_CLASS,
  COMPUTER_STATUS_TEXT,
  LOGIN_FAILURE_TEXT,
  LOGIN_TEXT,
  PLATFORM,
  TIER,
  TERMINAL_TEXT,
  TIERS,
  VIA_TEXT,
  blockedTier,
  computerName,
  timeText,
} from "./messages/content.js";

type Props = {
  accounts: Account[];
  computers: Record<string, Computer>;
  grants: Grant[];
  projectNames: Record<GroupId, string>;
  grantsVersion: number;
  // 账号和电脑两张表一起拉。
  onLoad: () => Promise<void>;
  onLoadGrants: () => Promise<void>;
  onRevokeGrant: (id: GrantId) => Promise<void>;
  onChangeTier: (accountId: AccountId, tier: AccountTier) => Promise<void>;
};

type Load = "loading" | "ready" | "failed";

type Change = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

type Login = { flows: Partial<Record<AccountId, LoginFlow>>; open: (accountId: AccountId) => Promise<void> };

// 电脑浏览器登录的号没登上时，行上就能开登录窗口，不用回首页找卡。点了之后怎么样了跟首页的卡同一套说法。
const LoginAction = ({ account, where, login }: { account: Account; where: string; login: Login }) => {
  const failed = useFailureToast();
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
        onClick={() => void login.open(account.id).catch(failed("登录窗口没打开，再试一次"))}
      >
        {opening ? "等你登录…" : "打开登录窗口"}
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
            在{computer === undefined ? "未同步的电脑" : computerName(computer)}
          </small>
          <small className="account-via" data-testid="account-via" data-via={account.via}>
            连接方式：{VIA_TEXT[account.via]}
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
      {account.login !== "valid" && account.via === "computer" ? (
        <LoginAction
          account={account}
          where={computer === undefined ? "账号所在的电脑" : computerName(computer)}
          login={login}
        />
      ) : null}
      <ScopeReconnect account={account} />
      {open ? (
        <fieldset className="account-tiers" aria-label={`${handle} 的档位`} disabled={change.status === "busy"}>
          {TIERS.map((tier) => {
            const blocked = blockedTier(account, tier);
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

// 终端开出去到会话报上来之间等多久。电脑拒开会报 closed、控制面推 live_closed，记录变成 refused；这个超时只兜推送丢了的底。
const TERMINAL_WAIT_MS = 20_000;

type Opening = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

// 云电脑那一行下面的终端入口。还开着终端（刷新之后也算）就给「回到终端」，面板本身由 LiveHost 摆。
const TerminalAction = ({ computer }: { computer: Computer }) => {
  const { state, actions } = useApp();
  const failedToast = useFailureToast();
  const [opening, setOpening] = useState<Opening>({ status: "idle" });
  const content = state.status === "ready" ? state.content : null;
  const existing = content === null ? null : openTerminal(content.live, computer.id);
  const record = content?.terminal?.computerId === computer.id ? content.terminal : null;
  const waiting = record?.status === "open" && content?.live[record.liveId] === undefined ? record.liveId : null;
  const failed =
    opening.status === "failed" ? opening.message : record?.status === "refused" ? TERMINAL_TEXT.notOpened : null;

  useEffect(() => {
    if (waiting === null) return;
    const timer = setTimeout(() => {
      setOpening({ status: "failed", message: TERMINAL_TEXT.notOpened });
      void actions.hideTerminal(waiting).catch((cause: unknown) => console.warn("收起没开成的终端没成", cause));
    }, TERMINAL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting, actions]);

  const open = () => {
    if (existing !== null) {
      void actions.showTerminal(existing).catch(failedToast("没回到终端，再试一次"));
      return;
    }
    setOpening({ status: "busy" });
    actions
      .openTerminal(computer.id)
      .then(() => setOpening({ status: "idle" }))
      .catch((cause: unknown) =>
        setOpening({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };

  const busy = existing === null && (opening.status === "busy" || waiting !== null);
  return (
    <div className="row-card computer-terminal" data-testid="computer-terminal">
      <span>
        <b>终端</b>
        <small>{TERMINAL_TEXT.explain}</small>
        {failed !== null ? (
          <small className="grant-error" role="alert" data-testid="terminal-open-error">
            {failed}
          </small>
        ) : null}
      </span>
      <button type="button" className="ghost-button" data-testid="terminal-open" disabled={busy} onClick={open}>
        {existing !== null ? TERMINAL_TEXT.back : busy ? TERMINAL_TEXT.opening : TERMINAL_TEXT.open}
      </button>
    </div>
  );
};

type Pairing =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "shown"; pairing: RemotePairing }
  | { status: "failed"; message: string };

// token 明文只在建好的那次回包里，住在这个组件里：点「记下了」或离开这一页就没了，再也取不回来。
// 本机和远程各至多一台，已经有远程时不给按钮，免得一点就把那台正在用的 token 换掉。
const ComputersSection = ({ computers, ready }: { computers: Record<string, Computer>; ready: boolean }) => {
  const { actions } = useApp();
  const [pairing, setPairing] = useState<Pairing>({ status: "idle" });
  const rows = Object.values(computers);
  const hasRemote = rows.some((computer) => computer.kind === "remote");
  const add = () => {
    setPairing({ status: "busy" });
    actions
      .addRemoteComputer()
      .then((created) => setPairing(created === undefined ? { status: "idle" } : { status: "shown", pairing: created }))
      .catch((cause: unknown) =>
        setPairing({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };
  return (
    <section className="computers-page" data-testid="computer-list">
      <p className="group-label">电脑</p>
      {rows.map((computer) => (
        <Fragment key={computer.id}>
          <div className="row-card computer-row" data-testid="computer-row" data-computer-id={computer.id}>
            <span>
              <b>{COMPUTER_KIND_TEXT[computer.kind]}</b>
            </span>
            <span className="computer-status" data-testid="computer-status" data-status={computer.status}>
              <i className={`status-dot ${COMPUTER_STATUS_CLASS[computer.status]}`} aria-hidden="true" />
              <b>{COMPUTER_STATUS_TEXT[computer.status]}</b>
            </span>
          </div>
          {computer.kind === "remote" ? <TerminalAction computer={computer} /> : null}
        </Fragment>
      ))}
      {pairing.status === "shown" ? (
        <div className="row-card computer-pairing" data-testid="computer-pairing" role="status">
          <span>
            <b>远程电脑建好了，把这串交给那台电脑上的白泽代理</b>
            <small>只显示这一次。关掉就看不到了，丢了只能重置。</small>
            <code data-testid="computer-pairing-id">{pairing.pairing.computerId}</code>
            <code data-testid="computer-pairing-token">{pairing.pairing.token}</code>
          </span>
          <button
            type="button"
            className="primary-button"
            data-testid="computer-pairing-done"
            onClick={() => setPairing({ status: "idle" })}
          >
            记下了
          </button>
        </div>
      ) : ready && !hasRemote ? (
        <div className="row-card">
          <span>
            <b>加一台远程电脑</b>
            <small>合上本机它也照样跑。在那台电脑上装白泽代理，用这里给的 token 连上来。</small>
            {pairing.status === "failed" ? (
              <small className="grant-error" role="alert" data-testid="computer-add-error">
                没建成：{pairing.message}
              </small>
            ) : null}
          </span>
          <button
            type="button"
            className="ghost-button"
            data-testid="computer-add-remote"
            disabled={pairing.status === "busy"}
            onClick={add}
          >
            加一台远程电脑
          </button>
        </div>
      ) : null}
    </section>
  );
};

// 本机能碰的文件夹就是给本机路径的永久读授权，素材文件夹设了就会建一条（D9）。撤销在下面授权列表里。
const LocalFolders = ({ grants, local }: { grants: Grant[]; local: Computer | undefined }) => {
  const folders = grants.flatMap((grant) =>
    grant.scope === "forever" &&
    grant.action === "read" &&
    grant.target.kind === "path" &&
    grant.target.computerId === local?.id
      ? [grant.target.prefix]
      : [],
  );
  return (
    <div className="row-card" data-testid="local-folders">
      <span>
        <b>本机能碰的文件夹</b>
        <small>{folders.length === 0 ? "还没有。哪里都要先问你" : `${folders.join("、")}。别的地方要先问你`}</small>
      </span>
    </div>
  );
};

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

type GrantsLoad = { status: "loading" | "ready" } | { status: "failed"; message: string };

// 版本号一变就重拉，补上断线期间别处撤掉的和别处新批的授权。
const GrantsSection = ({
  grants,
  projectNames,
  grantsVersion,
  onLoad,
  onRevoke,
}: {
  grants: Grant[];
  projectNames: Record<GroupId, string>;
  grantsVersion: number;
  onLoad: () => Promise<void>;
  onRevoke: (id: GrantId) => Promise<void>;
}) => {
  const [load, setLoad] = useState<GrantsLoad>({ status: "loading" });
  useEffect(() => {
    let active = true;
    onLoad().then(
      () => active && setLoad({ status: "ready" }),
      (cause: unknown) =>
        active && setLoad({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
    );
    return () => {
      active = false;
    };
  }, [grantsVersion, onLoad]);

  return (
    <section className="grants-page" data-testid="grants-page">
      <p className="group-label">长期授权</p>
      {load.status === "failed" ? (
        <p className="later" data-testid="grants-error" role="alert">
          授权列表加载失败：{load.message}
        </p>
      ) : load.status === "loading" && grants.length === 0 ? (
        <p className="later">正在加载授权…</p>
      ) : grants.length === 0 ? (
        <p className="later" data-testid="grants-empty">
          还没有长期授权
        </p>
      ) : (
        grants.map((grant) => (
          <GrantRow
            key={grant.id}
            grant={grant}
            projectName={grant.scope === "project" ? projectNames[grant.groupId] : undefined}
            onRevoke={onRevoke}
          />
        ))
      )}
    </section>
  );
};

// 和 shared 里只能批「这一次」的动作（spend、account_security、delete）对着写，档位开到最大也一样。
const ALWAYS_ASK = ["花钱", "改密码或绑定手机", "授权第三方应用", "删除你电脑上的文件"] as const;

const AlwaysAsk = () => (
  <div className="always-ask" data-testid="always-ask">
    <Lock size={16} aria-hidden="true" />
    <p>
      <b>这几件事不管权限开多大都会问你：</b>
      {ALWAYS_ASK.join("，")}。
    </p>
  </div>
);

// 进来就重拉一遍。拉不到得明说，不然空表会被读成「真的没有账号」。
export const AccountsPage = ({
  accounts,
  computers,
  grants,
  projectNames,
  grantsVersion,
  onLoad,
  onLoadGrants,
  onRevokeGrant,
  onChangeTier,
}: Props) => {
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
      <ConnectEntries computers={Object.values(computers)} openLogin={login.open} />
      <p className="later" data-testid="browser-shared-login-note">
        助理浏览器的登录状态所有 Bot 共用，在一个 Bot 那里登录过，别的 Bot 也能用这个账号。
      </p>
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
      <ComputersSection computers={computers} ready={load === "ready"} />
      <LocalFolders grants={grants} local={local} />
      <GrantsSection
        grants={grants}
        projectNames={projectNames}
        grantsVersion={grantsVersion}
        onLoad={onLoadGrants}
        onRevoke={onRevokeGrant}
      />
      <AlwaysAsk />
    </>
  );
};
