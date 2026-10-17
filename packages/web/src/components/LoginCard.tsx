import { Check, TriangleAlert } from "lucide-react";
import type { Account, AccountId, Computer } from "@baize/shared";
import type { LoginFlow } from "../state/types.js";
import { LOGIN_FAILURE_TEXT, PLATFORM, beforeChinese, computerName, timeText } from "./messages/content.js";

type Props = {
  account: Account;
  computer: Computer | undefined;
  flow: LoginFlow | undefined;
  onLogin: (accountId: AccountId) => Promise<void>;
};

type State = "signed_in" | "opening" | "closed" | "offline" | "refused" | "failed" | "lapsed" | "needed";

const stateOf = (account: Account, flow: LoginFlow | undefined): State => {
  if (account.login === "valid") return "signed_in";
  if (flow === undefined || flow.status === "signed_in") return "needed";
  return flow.status;
};

// 点了登录之后这一次怎么样了，首页的登录卡和账号页的行共用。还没点、或者这次已经登上时是 null。
export const loginFlowNote = (flow: LoginFlow | undefined, where: string): { text: string; alert: boolean } | null => {
  switch (flow?.status) {
    case "opening":
      return { text: `登录窗口已在${beforeChinese(where)}打开，登上后这里会变成已登录。`, alert: false };
    case "closed":
      return { text: "登录页已收起，要登再点一次。", alert: false };
    case "offline":
      return { text: `${beforeChinese(where)}不在线，打开电脑上的白泽后再点登录。`, alert: true };
    case "refused":
      return { text: `登录窗口没打开：${flow.message}`, alert: true };
    case "failed":
      return { text: `登录没成。${LOGIN_FAILURE_TEXT[flow.reason]}`, alert: true };
    case "lapsed":
      return { text: "没等到登录结果，可以再点一次登录。", alert: true };
    case "signed_in":
    case undefined:
      return null;
  }
};

const noteOf = (account: Account, flow: LoginFlow | undefined, where: string): { text: string; alert: boolean } =>
  loginFlowNote(flow, where) ?? {
    text:
      account.login === "expired"
        ? `${timeText(account.loginChangedAt)} 过期的 · 账号在${where}，稿子先不发。`
        : `稿子等着发到这个号，在${beforeChinese(where)}的助理浏览器里登录一次。密码不经过 Bot。`,
    alert: false,
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
  const note = noteOf(account, flow, where);
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
          className={note.alert ? "today-inline-error" : undefined}
          data-testid="login-card-note"
          role={note.alert ? "alert" : undefined}
        >
          {note.text}
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
          {state === "opening" ? "等你登录…" : "打开登录窗口"}
        </button>
      </span>
    </article>
  );
};
