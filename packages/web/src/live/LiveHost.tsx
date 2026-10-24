import { useState } from "react";
import { MonitorUp } from "lucide-react";
import type { LiveId } from "@baize/shared";
import { useApp } from "../state/app.js";
import { shownLive } from "../state/live.js";
import { LIVE_TEXT } from "../components/messages/content.js";
import { useFailureToast } from "../components/Toasts.js";
import { LivePanel } from "./LivePanel.js";
import { TerminalPanel } from "./TerminalPanel.js";

// 画面面板整页只挂这一处，终端面板也在这里。一台电脑同一时刻只有一个观看者，首页的登录卡、设置里的账号页、群里的接手卡、电脑页的终端各挂一块，
// 就是几条 socket 在同一台电脑上互相顶掉。摆哪块由 shownLive 定；没摆着的接手在右下角给提示，哪一页都看得到。
export const LiveHost = () => {
  const { state, actions } = useApp();
  const failed = useFailureToast();
  // 「稍后」只收起提示，卡片还在群里。收起接手面板也算：结束按钮发出去到 live_closed 回来之间，提示不该闪一下。
  const [later, setLater] = useState<ReadonlySet<LiveId>>(() => new Set());
  if (state.status !== "ready") return null;

  const putAside = (liveId: LiveId) => setLater((current) => new Set(current).add(liveId));
  const shown = shownLive(state.content);
  const hints = Object.values(state.content.live).flatMap((session) =>
    session.purpose.kind === "takeover" && session.liveId !== shown?.session.liveId && !later.has(session.liveId)
      ? [{ liveId: session.liveId, purpose: session.purpose }]
      : [],
  );

  return (
    <>
      {shown === null ? null : shown.kind === "terminal" ? (
        <TerminalPanel
          key={shown.session.liveId}
          session={shown.session}
          onDismiss={() => void actions.hideTerminal(shown.session.liveId).catch(failed("终端没收起，再试一次"))}
        />
      ) : (
        <LivePanel
          key={shown.session.liveId}
          session={shown.session}
          onDismiss={
            shown.kind === "login"
              ? () =>
                  void actions.dismissLogin(shown.accountId, shown.attempt).catch(failed("登录画面没收起，再试一次"))
              : () => {
                  putAside(shown.session.liveId);
                  void actions.hideTakeover(shown.session.liveId).catch(failed("画面没收起，再试一次"));
                }
          }
        />
      )}
      {hints.length === 0 ? null : (
        <div className="takeover-hints">
          {hints.map(({ liveId, purpose }) => (
            <section
              key={liveId}
              className="takeover-hint"
              data-testid="takeover-hint"
              data-live-id={liveId}
              aria-label={LIVE_TEXT.takeover(state.bots[purpose.botId]?.name)}
            >
              <MonitorUp size={18} aria-hidden="true" />
              <span className="takeover-text">
                <b>{LIVE_TEXT.takeover(state.bots[purpose.botId]?.name)}</b>
                <span className="takeover-reason">{purpose.reason}</span>
              </span>
              <span className="takeover-hint-actions">
                <button
                  type="button"
                  className="ghost-button"
                  data-testid="takeover-hint-later"
                  onClick={() => putAside(liveId)}
                >
                  {LIVE_TEXT.later}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  data-testid="takeover-hint-open"
                  onClick={() => void actions.openTakeover(liveId).catch(failed("画面没打开，再试一次"))}
                >
                  {LIVE_TEXT.open}
                </button>
              </span>
            </section>
          ))}
        </div>
      )}
    </>
  );
};
