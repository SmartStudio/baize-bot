import { useApp } from "../state/app.js";
import { shownLogin } from "../state/live.js";
import { LivePanel } from "./LivePanel.js";

// 登录画面整页只挂这一处。首页的登录卡和设置里的账号页同时渲染，各挂一块就是两条 socket，同一台电脑上会互相顶掉。
// 哪块画面归哪次点击由 shownLogin 按 attempt 认领，卡片和账号页只管点和显示这次怎么样了。
export const LoginLive = () => {
  const { state, actions } = useApp();
  const shown = state.status === "ready" ? shownLogin(state.content) : null;
  if (shown === null) return null;
  return (
    <LivePanel
      key={shown.session.liveId}
      session={shown.session}
      onDismiss={() => void actions.dismissLogin(shown.accountId, shown.attempt).catch(() => undefined)}
    />
  );
};
