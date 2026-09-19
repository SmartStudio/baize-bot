import { useState } from "react";
import { ArrowRightLeft, CircleDollarSign, Globe, ShieldAlert, Sparkles } from "lucide-react";
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
import { timeOf } from "./preview.js";

export type BotLookup = (botId: BotId) => { name: string; tag: string; hue: BotHue };
export type ApprovalTable = Record<ApprovalId, Approval>;
export type HandoffTable = Record<HandoffId, Handoff>;
export type DecideApproval = (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => Promise<void>;
export type DecideSkillOffer = (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => Promise<void>;

const UserBubble = ({ text }: { text: string }) => <p className="bubble bubble-user">{text}</p>;

// 多 Bot 群里得先说清这句话是谁说的，单 Bot 群里只有一个人会开口，这一行就是噪音。
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
        <span className="bot-source" data-testid="bot-source" data-bot-name={bot.name}>
          消息来自
          <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
          {bot.tag ? `${bot.name} · ${bot.tag}` : bot.name}
        </span>
      ) : null}
      <div className="bot-line">
        <BotAvatar name={bot.name} hue={bot.hue} size="sm" />
        <p className="bubble bubble-bot" data-testid="bot-bubble" data-streaming={body.streaming}>
          {body.text}
          {body.streaming ? <span className="caret" data-testid="streaming-caret" aria-label="正在输入" /> : null}
        </p>
      </div>
    </div>
  );
};

const SystemNote = ({ text }: { text: string }) => <p className="system-note">{text}</p>;

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
  <div className="card card-tool" data-testid="tool-call-card" data-status={body.status}>
    <Globe size={16} aria-hidden="true" />
    <span className="tool-name">{body.tool}</span>
    <code className="tool-args">{body.argsSummary}</code>
    <span className="tool-meta">{body.durationMs === null ? "" : `${Math.round(body.durationMs / 1000)}s`}</span>
    <span className={`status-dot status-${body.status}`} aria-hidden="true" />
    {/* 四种状态的颜色是给扫一眼的人看的，色盲和读屏的人得有字。 */}
    <span className="tool-status">{TOOL_STATUS_TEXT[body.status]}</span>
  </div>
);

const CostCard = ({ body }: { body: Extract<MessageBody, { kind: "cost" }> }) => (
  <div className="card card-cost" data-testid="cost-card">
    <div className="card-title">
      <CircleDollarSign size={16} aria-hidden="true" />
      本次花费
    </div>
    <div className="metrics">
      <span className="metric">
        <b>约 ¥{body.amount.toFixed(1)}</b>
        <small>费用</small>
      </span>
      <span className="metric">
        <b>{body.steps} 步</b>
        <small>步数</small>
      </span>
    </div>
  </div>
);

const APPROVAL_KIND_TEXT: Record<Approval["kind"], string> = {
  send_external: "对外发送",
  change_production_data: "改生产数据",
  pay: "付钱",
};

const DECIDED_TEXT: Record<Exclude<Approval["status"], "pending">, string> = {
  approved: "已批准",
  rejected: "已拒绝",
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
  return (
    <div className="card card-approval" data-testid="approval-card" data-status={approval.status}>
      <div className="card-title">
        <ShieldAlert size={16} aria-hidden="true" />
        需要你点头 · {APPROVAL_KIND_TEXT[approval.kind]}
      </div>
      <p className="approval-summary">{approval.summary}</p>
      {approval.status === "pending" ? (
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
      ) : (
        <p className="approval-decided" data-testid="approval-decided">
          {DECIDED_TEXT[approval.status]}
          {approval.decidedAt === null ? "" : ` · ${stampOf(message, approval.decidedAt)}`}
        </p>
      )}
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

export const MessageView = ({
  message,
  lookup,
  approvals,
  handoffs,
  checklist,
  onDecide,
  onDecideSkillOffer,
  showSource = false,
}: {
  message: Message;
  lookup: BotLookup;
  approvals: ApprovalTable;
  handoffs: HandoffTable;
  checklist: ChecklistItem[];
  onDecide: DecideApproval;
  onDecideSkillOffer: DecideSkillOffer;
  showSource?: boolean;
}) => {
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
            return <SystemNote text={body.text} />;
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
