import { useState } from "react";
import { CircleDollarSign, Globe, Handshake, ShieldAlert } from "lucide-react";
import type { Approval, ApprovalId, BotHue, BotId, DecideApprovalRequest, Message, MessageBody } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";
import { timeOf } from "./preview.js";

export type BotLookup = (botId: BotId) => { name: string; tag: string; hue: BotHue };
export type ApprovalTable = Record<ApprovalId, Approval>;
export type DecideApproval = (approvalId: ApprovalId, decision: DecideApprovalRequest["decision"]) => Promise<void>;

const UserBubble = ({ text }: { text: string }) => <p className="bubble bubble-user">{text}</p>;

const BotBubble = ({ body, lookup }: { body: Extract<MessageBody, { kind: "bot" }>; lookup: BotLookup }) => {
  const bot = lookup(body.botId);
  return (
    <div className="bot-line">
      <BotAvatar name={bot.name} hue={bot.hue} size="sm" />
      <p className="bubble bubble-bot" data-testid="bot-bubble" data-streaming={body.streaming}>
        {body.text}
        {body.streaming ? <span className="caret" data-testid="streaming-caret" aria-label="正在输入" /> : null}
      </p>
    </div>
  );
};

const SystemNote = ({ text }: { text: string }) => <p className="system-note">{text}</p>;

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

const LaterCard = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <div className="card card-later">
    {icon}
    <span>{text}</span>
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

// timeOf 只认 Message，而结论时间挂在 Approval 上。借这条审批消息套一层，免得为同一个格式再写一份。
const decidedTimeOf = (message: Message, decidedAt: string): string => timeOf({ ...message, createdAt: decidedAt });

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
          {approval.decidedAt === null ? "" : ` · ${decidedTimeOf(message, approval.decidedAt)}`}
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

export const MessageView = ({
  message,
  lookup,
  approvals,
  onDecide,
}: {
  message: Message;
  lookup: BotLookup;
  approvals: ApprovalTable;
  onDecide: DecideApproval;
}) => {
  const body = message.body;
  return (
    <div className="message" data-testid="message" data-kind={body.kind}>
      {(() => {
        switch (body.kind) {
          case "user":
            return <UserBubble text={body.text} />;
          case "bot":
            return <BotBubble body={body} lookup={lookup} />;
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
          case "handoff":
            return <LaterCard icon={<Handshake size={16} aria-hidden="true" />} text="交接报文 · 后续" />;
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
