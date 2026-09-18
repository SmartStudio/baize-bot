import { CircleDollarSign, Globe, Handshake, ShieldQuestion } from "lucide-react";
import type { BotHue, BotId, Message, MessageBody } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";

export type BotLookup = (botId: BotId) => { name: string; tag: string; hue: BotHue };

const UserBubble = ({ text }: { text: string }) => <p className="bubble bubble-user">{text}</p>;

const BotBubble = ({ body, lookup }: { body: Extract<MessageBody, { kind: "bot" }>; lookup: BotLookup }) => {
  const bot = lookup(body.botId);
  return (
    <div className="bot-line">
      <BotAvatar name={bot.name} hue={bot.hue} size="sm" />
      <p className="bubble bubble-bot">{body.text}</p>
    </div>
  );
};

const SystemNote = ({ text }: { text: string }) => <p className="system-note">{text}</p>;

const ToolCallCard = ({ body }: { body: Extract<MessageBody, { kind: "tool_call" }> }) => (
  <div className="card card-tool" data-testid="tool-call-card">
    <Globe size={16} aria-hidden="true" />
    <span className="tool-name">{body.tool}</span>
    <code className="tool-args">{body.argsSummary}</code>
    <span className="tool-meta">{body.durationMs === null ? "" : `${Math.round(body.durationMs / 1000)}s`}</span>
    <span className={`status-dot status-${body.status}`} aria-hidden="true" />
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

export const MessageView = ({ message, lookup }: { message: Message; lookup: BotLookup }) => {
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
          case "approval":
            return <LaterCard icon={<ShieldQuestion size={16} aria-hidden="true" />} text="审批卡 · 后续" />;
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
