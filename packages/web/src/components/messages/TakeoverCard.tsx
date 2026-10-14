import { MonitorUp } from "lucide-react";
import type { MessageBody, MessageId, ToolView } from "@baize/shared";
import type { ContentBook } from "../../state/types.js";
import type { ContentActions } from "./DraftCards.js";
import type { InspectTool } from "./MessageView.js";
import { LIVE_TEXT, TAKEOVER_RESULT, computerName } from "./content.js";

type ToolCall = Extract<MessageBody, { kind: "tool_call" }>;

// 工具调用行整行是一个按钮，「打开画面」放不进去。接手卡拆成两个并排的按钮：左边整块照旧开工具检查器，右边开画面。
// 结论只看两处：画面还在就能开；画面不在了按工具调用的终态说。电脑名只有画面在时才知道，Bot 和工具调用都不带电脑。
export const TakeoverCard = ({
  messageId,
  body,
  view,
  botName,
  content,
  actions,
  selected,
  onInspect,
}: {
  messageId: MessageId;
  body: ToolCall;
  view: Extract<ToolView, { kind: "takeover" }>;
  botName: string;
  content: ContentBook;
  actions: ContentActions;
  selected: boolean;
  onInspect: InspectTool;
}) => {
  const session = content.live[view.liveId];
  const computer = session === undefined ? undefined : content.computers[session.computerId];
  return (
    <div
      className={`card takeover-card${selected ? " is-selected" : ""}`}
      data-testid="takeover-card"
      data-status={body.status}
      data-live-id={view.liveId}
    >
      <button
        type="button"
        className="takeover-inspect"
        data-testid="takeover-inspect"
        aria-pressed={selected}
        onClick={() => onInspect({ messageId, body })}
      >
        <MonitorUp size={18} aria-hidden="true" />
        <span className="takeover-text">
          <b>{LIVE_TEXT.takeover(botName)}</b>
          <span className="takeover-reason">{view.reason}</span>
          {computer === undefined ? null : (
            <small data-testid="takeover-computer">页面开在{computerName(computer)}</small>
          )}
        </span>
      </button>
      {session === undefined ? (
        <span className="takeover-result" data-testid="takeover-result">
          {TAKEOVER_RESULT[body.status]}
        </span>
      ) : (
        <button
          type="button"
          className="primary-button takeover-open"
          data-testid="takeover-open"
          onClick={() => void actions.openTakeover(view.liveId).catch(() => undefined)}
        >
          {LIVE_TEXT.open}
        </button>
      )}
    </div>
  );
};
