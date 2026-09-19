import { useState } from "react";
import { ArrowRightLeft, ChevronDown, ChevronRight, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import type {
  Approval,
  ApprovalId,
  BotHue,
  BotId,
  ChecklistItem,
  DecideApprovalRequest,
  DecideSkillOfferRequest,
  Handoff,
  HandoffId,
  Message,
  MessageBody,
  MessageId,
  SkillOfferStatus,
} from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";
import { Markdown } from "./markdown.js";
import { formatAmount, timeOf } from "./preview.js";
import type { Turn } from "./turns.js";

export type BotLookup = (botId: BotId) => { name: string; tag: string; hue: BotHue };
export type ApprovalTable = Record<ApprovalId, Approval>;
export type HandoffTable = Record<HandoffId, Handoff>;
export type DecideApproval = (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => Promise<void>;
export type DecideSkillOffer = (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => Promise<void>;

const UserBubble = ({ text }: { text: string }) => <p className="bubble bubble-user">{text}</p>;

const BotBubble = ({
  body,
  lookup,
  showSource,
}: {
  body: Extract<MessageBody, { kind: "bot" }>;
  lookup: BotLookup;
  showSource: boolean;
}) => {
  const bot = lookup(body.botId);
  return (
    <div className="bot-block">
      {showSource ? (
        <div className="bot-source" data-testid="bot-source" data-bot-name={bot.name}>
          消息来自
          <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
          {bot.tag ? `${bot.name} · ${bot.tag}` : bot.name}
        </div>
      ) : null}
      <div className="bubble bubble-bot" data-testid="bot-bubble" data-streaming={body.streaming}>
        <Markdown text={body.text} />
        {body.streaming ? <span className="caret" data-testid="streaming-caret" aria-label="正在输入" /> : null}
      </div>
    </div>
  );
};

const SystemNote = ({ body }: { body: Extract<MessageBody, { kind: "system" }> }) =>
  body.tone === "error" ? (
    <div className="notice notice-error" data-testid="notice" data-tone="error">
      <TriangleAlert size={16} aria-hidden="true" />
      <p>{body.text}</p>
    </div>
  ) : (
    <p className="system-note">{body.text}</p>
  );

const OFFER_DECIDED_TEXT: Record<Exclude<SkillOfferStatus, "offered">, string> = {
  saved: "已存",
  dismissed: "没存",
};

// 这张卡的状态就在消息正文里，不像审批和交接另有一张表。点完什么都不改，等服务端把改过的那条消息推回来。
const SkillOfferCard = ({
  body,
  messageId,
  onDecide,
}: {
  body: Extract<MessageBody, { kind: "skill_offer" }>;
  messageId: MessageId;
  onDecide: DecideSkillOffer;
}) => {
  const [sent, setSent] = useState(false);
  const decide = (decision: DecideSkillOfferRequest["decision"]) => {
    setSent(true);
    void onDecide(messageId, decision).catch(() => setSent(false));
  };
  return (
    <div className="card card-skill-offer" data-testid="skill-offer" data-status={body.status}>
      <div className="card-title">
        <Sparkles size={16} aria-hidden="true" />
        存成 skill「{body.name}」？
      </div>
      <ol className="skill-steps">
        {body.steps.map((step, at) => (
          <li key={`${at}-${step}`} data-testid="skill-offer-step">
            {step}
          </li>
        ))}
      </ol>
      {body.status === "offered" ? (
        <div className="approval-actions">
          <button
            type="button"
            className="ghost-button"
            data-testid="skill-offer-dismiss"
            disabled={sent}
            onClick={() => decide("dismiss")}
          >
            不存
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="skill-offer-save"
            disabled={sent}
            onClick={() => decide("save")}
          >
            存
          </button>
        </div>
      ) : (
        <p className="approval-decided" data-testid="skill-offer-decided">
          {OFFER_DECIDED_TEXT[body.status]}
        </p>
      )}
    </div>
  );
};

type ToolCall = Extract<MessageBody, { kind: "tool_call" }>;

const TOOL_STATUS_TEXT: Record<ToolCall["status"], string> = {
  running: "运行中",
  ok: "完成",
  failed: "失败",
  blocked: "拦下",
};

const ToolCallCard = ({ body }: { body: ToolCall }) => (
  <div className="tool-line" data-testid="tool-call-card" data-status={body.status}>
    <span className="tool-name">{body.tool}</span>
    <span aria-hidden="true">·</span>
    <span className="tool-args">{body.argsSummary}</span>
    <span aria-hidden="true">·</span>
    <span className={`status-dot status-${body.status}`} role="img" aria-label={TOOL_STATUS_TEXT[body.status]} />
    <span className="tool-meta">{body.durationMs === null ? "—" : `${(body.durationMs / 1000).toFixed(1)}s`}</span>
  </div>
);

const CostCard = ({ body }: { body: Extract<MessageBody, { kind: "cost" }> }) => (
  <div className="cost-caption" data-testid="cost-card" data-kind="cost">
    约 ¥{formatAmount(body.amount)}
  </div>
);

const APPROVAL_KIND_TEXT: Record<Approval["kind"], string> = {
  send_external: "对外发送",
  change_production_data: "改生产数据",
  pay: "付钱",
};

const DECIDED_TEXT: Record<Exclude<Approval["status"], "pending">, string> = {
  approved: "同意",
  rejected: "不同意",
};

// timeOf 只认 Message，而结论时间和接手时间挂在 Approval、Handoff 上。借这条消息套一层，免得为同一个格式
// 再写一份。
const stampOf = (message: Message, at: string): string => timeOf({ ...message, createdAt: at });

const ApprovalCard = ({
  approval,
  message,
  onDecide,
}: {
  approval: Approval;
  message: Message;
  onDecide: DecideApproval;
}) => {
  const [sent, setSent] = useState(false);
  // 结论以服务端推回来的那条为准，这里只锁住按钮，免得一次点两下发两个决定。
  const decide = (decision: DecideApprovalRequest["decision"]) => {
    setSent(true);
    void onDecide(approval.id, decision).catch(() => setSent(false));
  };
  if (approval.status !== "pending") {
    return (
      <div className="card card-approval approval-compact" data-testid="approval-card" data-status={approval.status}>
        <span className="approval-compact-text">{approval.summary}</span>
        <span
          className="approval-pill"
          data-testid="approval-decided"
          title={approval.decidedAt === null ? undefined : stampOf(message, approval.decidedAt)}
        >
          {DECIDED_TEXT[approval.status]}
        </span>
      </div>
    );
  }
  return (
    <div className="card card-approval" data-testid="approval-card" data-status={approval.status}>
      <div className="card-title">
        <ShieldAlert size={16} aria-hidden="true" />
        需要你点头 · {APPROVAL_KIND_TEXT[approval.kind]}
      </div>
      <p className="approval-summary">{approval.summary}</p>
      <div className="approval-actions">
        <button
          type="button"
          className="ghost-button"
          data-testid="approval-reject"
          disabled={sent}
          onClick={() => decide("rejected")}
        >
          拒绝
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="approval-approve"
          disabled={sent}
          onClick={() => decide("approved")}
        >
          批准
        </button>
      </div>
    </div>
  );
};

// 新建审批先推 approval_updated 再推那条消息，但历史和推送会赛跑。查不到就先占个位，别让整条消息消失。
const ApprovalPlaceholder = () => (
  <div className="card card-approval" data-testid="approval-card" data-status="unknown">
    <div className="card-title">
      <ShieldAlert size={16} aria-hidden="true" />
      等你点头
    </div>
  </div>
);

// 指针指到清单外面（Bot 交接完用户又删了一项）时还是把这一项指出来，光秃秃一个序号也比整行消失强。
const pointerTextOf = (checklist: ChecklistItem[], at: number): string => {
  const item = checklist[at];
  return item === undefined ? `第 ${at + 1} 项` : `第 ${at + 1} 项 · ${item.text}`;
};

const HandoffCard = ({
  handoff,
  message,
  lookup,
  checklist,
}: {
  handoff: Handoff;
  message: Message;
  lookup: BotLookup;
  checklist: ChecklistItem[];
}) => {
  const from = lookup(handoff.fromBotId);
  const to = lookup(handoff.toBotId);
  const accepted = handoff.status === "accepted";
  return (
    <>
      <div className="bot-source handoff-source">
        已发消息给
        <BotAvatar name={to.name} hue={to.hue} size="xs" />
        {to.name}
      </div>
      <div className="card card-handoff" data-testid="handoff-card" data-status={handoff.status}>
        <div className="handoff-head">
          <ArrowRightLeft size={16} aria-hidden="true" />
          <span className="handoff-label">交接</span>
          <span className="handoff-pair" data-testid="handoff-pair">
            <BotAvatar name={from.name} hue={from.hue} size="xs" />
            {from.name}
            <span className="handoff-arrow" aria-hidden="true">
              →
            </span>
            <BotAvatar name={to.name} hue={to.hue} size="xs" />
            {to.name}
          </span>
          <span className={`badge ${accepted ? "badge-accepted" : "badge-await-bot"}`} data-testid="handoff-status">
            {accepted
              ? `已接手${handoff.acceptedAt === null ? "" : ` · ${stampOf(message, handoff.acceptedAt)}`}`
              : `等${to.name}确认`}
          </span>
        </div>
        <dl className="handoff-body">
          <div className="handoff-row">
            <dt>做了什么</dt>
            <dd data-testid="handoff-done">{handoff.done}</dd>
          </div>
          <div className="handoff-row">
            <dt>没做什么</dt>
            <dd data-testid="handoff-not-done">{handoff.notDone}</dd>
          </div>
          <div className="handoff-row">
            <dt>下一步</dt>
            <dd data-testid="handoff-next">{handoff.next}</dd>
          </div>
          {handoff.checklistIndex === null ? null : (
            <div className="handoff-row">
              <dt>清单</dt>
              <dd data-testid="handoff-checklist">{pointerTextOf(checklist, handoff.checklistIndex)}</dd>
            </div>
          )}
        </dl>
      </div>
    </>
  );
};

// 新建交接先推 handoff_updated 再推那条消息，跟审批一样会跟历史赛跑。查不到就先占个位。
const HandoffPlaceholder = () => (
  <div className="card card-handoff" data-testid="handoff-card" data-status="unknown">
    <div className="handoff-head">
      <ArrowRightLeft size={16} aria-hidden="true" />
      <span className="handoff-label">交接</span>
    </div>
  </div>
);

type MessageProps = {
  message: Message;
  lookup: BotLookup;
  approvals: ApprovalTable;
  handoffs: HandoffTable;
  checklist: ChecklistItem[];
  onDecide: DecideApproval;
  onDecideSkillOffer: DecideSkillOffer;
  showSource: boolean;
};

const MessageView = ({
  message,
  lookup,
  approvals,
  handoffs,
  checklist,
  onDecide,
  onDecideSkillOffer,
  showSource,
}: MessageProps) => {
  const body = message.body;
  return (
    <div className="message" data-testid="message" data-kind={body.kind}>
      {(() => {
        switch (body.kind) {
          case "user":
            return <UserBubble text={body.text} />;
          case "bot":
            return <BotBubble body={body} lookup={lookup} showSource={showSource} />;
          case "system":
            return <SystemNote body={body} />;
          case "tool_call":
            return <ToolCallCard body={body} />;
          case "cost":
            return <CostCard body={body} />;
          case "approval": {
            const approval = approvals[body.approvalId];
            return approval === undefined ? (
              <ApprovalPlaceholder />
            ) : (
              <ApprovalCard approval={approval} message={message} onDecide={onDecide} />
            );
          }
          case "skill_offer":
            return <SkillOfferCard body={body} messageId={message.id} onDecide={onDecideSkillOffer} />;
          case "handoff": {
            const handoff = handoffs[body.handoffId];
            return handoff === undefined ? (
              <HandoffPlaceholder />
            ) : (
              <HandoffCard handoff={handoff} message={message} lookup={lookup} checklist={checklist} />
            );
          }
          default: {
            // MessageBody 多一种时这里编译不过，逼着新卡片有人画，而不是静悄悄地什么都不渲染。
            const unreached: never = body;
            return unreached;
          }
        }
      })()}
    </div>
  );
};

const CostMessage = ({ message }: { message: Message }) =>
  message.body.kind === "cost" ? (
    <div className="message message-cost" data-testid="message" data-kind="cost">
      <CostCard body={message.body} />
    </div>
  ) : null;

const Activity = ({ tools, cost }: { tools: Message[]; cost: Message | null }) => {
  const [expanded, setExpanded] = useState(false);
  const running = tools.find((message) => message.body.kind === "tool_call" && message.body.status === "running");
  const open = running !== undefined || expanded;
  const runningName = running?.body.kind === "tool_call" ? running.body.tool : "";

  return (
    <div className="activity" data-testid="activity">
      <div className="turn-meta">
        <button
          className="activity-toggle"
          type="button"
          data-testid="activity-toggle"
          aria-expanded={open}
          disabled={running !== undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          {running === undefined ? `用了 ${tools.length} 个工具` : `正在用 ${runningName}…`}
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        {cost === null ? null : (
          <>
            <span aria-hidden="true">·</span>
            <CostMessage message={cost} />
          </>
        )}
      </div>
      <div className="activity-lines">
        {tools.map((message) => (
          <div className="message" data-testid="message" data-kind="tool_call" key={message.id} hidden={!open}>
            {message.body.kind === "tool_call" ? <ToolCallCard body={message.body} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

type TurnProps = Omit<MessageProps, "message"> & { turn: Turn };

export const TurnView = ({ turn, ...props }: TurnProps) => {
  if (turn.kind === "system" && turn.message.body.kind === "system" && turn.message.body.tone === "error") {
    return (
      <div className="turn turn-system">
        <div className="message" data-testid="message" data-kind="system">
          <div className="notice notice-error" data-testid="notice" data-tone="error">
            <TriangleAlert size={16} aria-hidden="true" />
            <div className="notice-body">
              <p>{turn.message.body.text}</p>
              {turn.cost === null ? null : <CostMessage message={turn.cost} />}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (turn.kind === "user" || turn.kind === "system") {
    return (
      <div className={`turn turn-${turn.kind}`}>
        <MessageView message={turn.message} {...props} />
        {turn.kind === "system" && turn.cost !== null ? <MessageView message={turn.cost} {...props} /> : null}
      </div>
    );
  }
  if (turn.kind === "cost") {
    return (
      <div className="turn turn-cost">
        <MessageView message={turn.message} {...props} />
      </div>
    );
  }

  const tools = turn.items.filter((message) => message.body.kind === "tool_call");
  return (
    <div className="turn turn-bot" data-testid="bot-turn" data-bot-id={turn.botId}>
      <div className="turn-content">
        {turn.items
          .filter((message) => message.body.kind !== "tool_call")
          .map((message) => (
            <MessageView key={message.id} message={message} {...props} />
          ))}
        {/* 工具活动和花费收在回合底部：正在用工具时它像「正在输入」，跑完了它是这轮的收尾小字。 */}
        {tools.length > 0 ? <Activity tools={tools} cost={turn.cost} /> : null}
        {tools.length === 0 && turn.cost !== null ? <MessageView message={turn.cost} {...props} /> : null}
      </div>
    </div>
  );
};
