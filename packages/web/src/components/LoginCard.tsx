import { Check, TriangleAlert } from "lucide-react";
import type { Account, AccountId, Computer } from "@baize/shared";
import type { LoginFlow } from "../state/types.js";
import { LOGIN_FAILURE_TEXT, PLATFORM, computerName, timeText } from "./messages/content.js";

type Props = {
  account: Account;
  computer: Computer | undefined;
  flow: LoginFlow | undefined;
  onLogin: (accountId: AccountId) => Promise<void>;
};

type State = "signed_in" | "opening" | "offline" | "refused" | "failed" | "lapsed" | "needed";

const stateOf = (account: Account, flow: LoginFlow | undefined): State => {
  if (account.login === "valid") return "signed_in";
  if (flow === undefined || flow.status === "signed_in") return "needed";
  return flow.status;
};

const noteOf = (account: Account, flow: LoginFlow | undefined, where: string): string => {
  switch (flow?.status) {
    case "opening":
      return `登录窗口已在${where}打开，扫码后这里会变成已登录。`;
    case "offline":
      return `${where}不在线，打开电脑上的白泽后再点登录。`;
    case "refused":
      return `登录窗口没打开：${flow.message}`;
    case "failed":
      return `登录没成。${LOGIN_FAILURE_TEXT[flow.reason]}`;
    case "lapsed":
      return "没等到登录结果，可以再点一次登录。";
    default:
      return account.login === "expired"
        ? `${timeText(account.loginChangedAt)} 过期的 · 账号在${where}，稿子先不发。`
        : `稿子等着发到这个号，在${where}的助理浏览器里扫一次码。密码不经过 Bot。`;
  }
};

export const LoginCard = ({ account, computer, flow, onLogin }: Props) => {
  const where = computer === undefined ? "账号所在的电脑" : computerName(computer);
  const state = stateOf(account, flow);
  const common = {
    "data-testid": "today-row",
    "data-kind": "login",
    "data-state": state,
    "data-account-id": account.id,
  };
  if (state === "signed_in") {
    return (
      <article className="today-row today-login is-signed-in" {...common}>
        <Check size={18} aria-hidden="true" />
        <span className="today-row-main">
          <span className="today-kicker">{PLATFORM[account.platform]}</span>
          <strong data-testid="login-card-title">
            {account.handle ?? "账号"} 已登录 · {where}
          </strong>
        </span>
      </article>
    );
  }
  const alert = state === "offline" || state === "refused" || state === "failed" || state === "lapsed";
  return (
    <article className="today-row today-login" {...common}>
      <TriangleAlert size={18} aria-hidden="true" />
      <span className="today-row-main">
        <span className="today-kicker">{account.login === "expired" ? "登录过期" : "要登录"}</span>
        <strong data-testid="login-card-title">
          {PLATFORM[account.platform]}
          {account.login === "expired" ? ` · ${account.handle ?? "账号"} 登录过期了` : " 还没登录"}
        </strong>
        <small
          className={alert ? "today-inline-error" : undefined}
          data-testid="login-card-note"
          role={alert ? "alert" : undefined}
        >
          {noteOf(account, flow, where)}
        </small>
      </span>
      <span className="today-row-actions">
        <button
          type="button"
          className="primary-button today-row-action"
          data-testid="login-open"
          disabled={state === "opening"}
          onClick={() => void onLogin(account.id).catch(() => undefined)}
        >
          {state === "opening" ? "等你扫码…" : "打开登录窗口"}
        </button>
      </span>
    </article>
  );
};
