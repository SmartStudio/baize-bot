import { OAuthPlatform, type Account } from "@baize/shared";
import { oauthStartUrl } from "../api/client.js";
import { ACCOUNT_SCOPE_TEXT, PLATFORM } from "./messages/content.js";

// 缺的是授权那一下没给的范围，只能回平台再授权一次补上，所以按钮直接走接入时的同一个入口。
export const ScopeReconnect = ({ account }: { account: Account }) => {
  const platform = OAuthPlatform.safeParse(account.platform);
  if (account.missingScope === null || !platform.success) return null;
  return (
    <div className="scope-reconnect" data-testid="scope-reconnect">
      <small data-testid="scope-reconnect-text">
        {PLATFORM[account.platform]} 账号缺{ACCOUNT_SCOPE_TEXT[account.missingScope]}，重新连接一次就好
      </small>
      <a className="ghost-button" href={oauthStartUrl(platform.data)} data-testid="scope-reconnect-link">
        重新连接
      </a>
    </div>
  );
};
