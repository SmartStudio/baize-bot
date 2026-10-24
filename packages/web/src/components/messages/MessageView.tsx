import { useState } from "react";
import { ArrowRightLeft, ChevronDown, ChevronRight, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import type {
  Approval,
  ApprovalId,
  Bot,
  BotHue,
  BotId,
  BotShape,
  ChecklistItem,
  DecideApprovalRequest,
  DecidePreferenceOfferRequest,
  DecideSkillOfferRequest,
  Handoff,
  HandoffId,
  Message,
  MessageBody,
  MessageId,
  PreferenceOfferStatus,
  SkillChangeOp,
  SkillOfferStatus,
} from "@baize/shared";
import type { ContentBook } from "../../state/types.js";
import { BotAvatar, resolveBotAvatarState } from "../BotAvatar.js";
import { ACTION_TEXT, SCOPE_TEXT, offeredScopes, targetText } from "../grantText.js";
import { DraftCard, PlanCard, type ContentActions } from "./DraftCards.js";
import { RoutineOfferCard } from "./RoutineOfferCard.js";
import { ProjectOfferCard, type ProjectOfferActions } from "./ProjectOfferCard.js";
import { Markdown } from "./markdown.js";
import { skillOfferTitle, timeOf } from "./preview.js";
import { TakeoverCard } from "./TakeoverCard.js";
import { useFailureToast } from "../Toasts.js";
import { TeamOfferCard } from "./TeamOfferCard.js";
import { useApp } from "../../state/app.js";
import { ApprovalDetails, ToolViewContent } from "./ToolViewContent.js";
import type { Turn } from "./turns.js";

export type BotLookup = (botId: BotId) => {
  name: string;
  tags: readonly string[];
  hue: BotHue;
  shape: BotShape;
  runState: Bot["runState"];
  pendingApproval: boolean;
};
export type ApprovalTable = Record<ApprovalId, Approval>;
export type HandoffTable = Record<HandoffId, Handoff>;
export type DecideApproval = (approvalId: ApprovalId, request: DecideApprovalRequest) => Promise<void>;
export type DecideSkillOffer = (messageId: MessageId, decision: DecideSkillOfferRequest["decision"]) => Promise<void>;
export type DecidePreferenceOffer = (
  messageId: MessageId,
  decision: DecidePreferenceOfferRequest["decision"],
) => Promise<void>;
type ToolCall = Extract<MessageBody, { kind: "tool_call" }>;
export type InspectedTool = { messageId: MessageId; body: ToolCall };
export type InspectTool = (tool: InspectedTool) => void;

// 例行任务替你发的那句标个小签，说明这句是到点自动发的，不用再另起一行 system。
const UserBubble = ({ body }: { body: Extract<MessageBody, { kind: "user" }> }) => (
  <>
    {body.routine === undefined ? null : (
      <span className="routine-label" data-testid="routine-label">
        例行任务「{body.routine.name}」
      </span>
    )}
    <p className="bubble bubble-user">{body.text}</p>
  </>
);

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
      {showSource || (body.mentions?.length ?? 0) > 0 ? (
        <div className="bot-source" data-testid="bot-source" data-bot-name={bot.name}>
          <BotAvatar
            shape={bot.shape}
            hue={bot.hue}
            state={resolveBotAvatarState({
              paused: bot.runState === "paused",
              pendingApproval: bot.pendingApproval,
              working: body.streaming,
            })}
            size="xs"
          />
          {bot.tags.length > 0 ? `${bot.name} · ${bot.tags.join("、")}` : bot.name}
          {body.mentions?.length ? (
            <span className="tag" data-testid="bot-recipient">
              发给 {body.mentions.map((id) => lookup(id).name).join("、")}
            </span>
          ) : null}
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

type OfferCopy = {
  dismiss: string;
  save: string;
  decided: Record<Exclude<SkillOfferStatus, "offered">, string>;
  failed: string;
};

const OFFER_COPY: Record<SkillChangeOp, OfferCopy> = {
  add: { dismiss: "不存", save: "存", decided: { saved: "已存", dismissed: "没存" }, failed: "没存上" },
  edit: { dismiss: "不改", save: "改", decided: { saved: "已改", dismissed: "没改" }, failed: "没改成" },
  remove: { dismiss: "留着", save: "删掉", decided: { saved: "已删", dismissed: "留着" }, failed: "没删掉" },
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
  const [failure, setFailure] = useState<string | null>(null);
  const { change } = body;
  const copy = OFFER_COPY[change.op];
  const decide = (decision: DecideSkillOfferRequest["decision"]) => {
    setSent(true);
    setFailure(null);
    void onDecide(messageId, decision).catch((cause: unknown) => {
      setFailure(
        `${decision === "save" ? copy.failed : "没点上"}：${cause instanceof Error ? cause.message : "请求失败"}`,
      );
      setSent(false);
    });
  };
  return (
    <div className="card card-skill-offer" data-testid="skill-offer" data-op={change.op} data-status={body.status}>
      <div className="card-title" data-testid="skill-offer-title">
        <Sparkles size={16} aria-hidden="true" />
        {skillOfferTitle(change)}
      </div>
      {change.op === "add" && change.origin !== null ? (
        <p className="skill-offer-source">
          来源{" "}
          <a href={change.origin} rel="noreferrer" target="_blank" data-testid="skill-offer-source">
            {change.origin}
          </a>
        </p>
      ) : null}
      {change.op === "remove" ? null : (
        <ol className="skill-steps">
          {change.steps.map((step, at) => (
            <li key={`${at}-${step}`} data-testid="skill-offer-step">
              {step}
            </li>
          ))}
        </ol>
      )}
      {failure === null || body.status !== "offered" ? null : (
        <p className="team-offer-error" role="alert" data-testid="skill-offer-error">
          {failure}
        </p>
      )}
      {body.status === "offered" ? (
        <div className="approval-actions">
          <button
            type="button"
            className="ghost-button"
            data-testid="skill-offer-dismiss"
            disabled={sent}
            onClick={() => decide("dismiss")}
          >
            {copy.dismiss}
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="skill-offer-save"
            disabled={sent}
            onClick={() => decide("save")}
          >
            {copy.save}
          </button>
        </div>
      ) : (
        <p className="approval-decided" data-testid="skill-offer-decided">
          {copy.decided[body.status]}
        </p>
      )}
    </div>
  );
};

const PREFERENCE_DECIDED_TEXT: Record<Exclude<PreferenceOfferStatus, "offered">, string> = {
  saved: "已记住",
  dismissed: "没记",
};

// 和 SkillOfferCard 一样，状态在消息正文里，点完等服务端把改过的那条推回来。点「记住」之前这句话还不是偏好，Bot 不会照着做。
const PreferenceOfferCard = ({
  body,
  messageId,
  onDecide,
}: {
  body: Extract<MessageBody, { kind: "preference_offer" }>;
  messageId: MessageId;
  onDecide: DecidePreferenceOffer;
}) => {
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const decide = (decision: DecidePreferenceOfferRequest["decision"]) => {
    setSent(true);
    setFailure(null);
    void onDecide(messageId, decision).catch((cause: unknown) => {
      setFailure(
        `${decision === "save" ? "没记上" : "没撤下"}：${cause instanceof Error ? cause.message : "请求失败"}`,
      );
      setSent(false);
    });
  };
  return (
    <div
      className="card card-skill-offer card-preference-offer"
      data-testid="preference-offer"
      data-status={body.status}
    >
      <div className="card-title">
        <Sparkles size={16} aria-hidden="true" />
        要记住这一条吗？
      </div>
      <p data-testid="preference-offer-text">{body.text}</p>
      {body.private ? <p data-testid="preference-offer-private">分享 Bot 时默认不带这条</p> : null}
      {failure === null || body.status !== "offered" ? null : (
        <p className="team-offer-error" role="alert" data-testid="preference-offer-error">
          {failure}
        </p>
      )}
      {body.status === "offered" ? (
        <div className="approval-actions">
          <button
            type="button"
            className="ghost-button"
            data-testid="preference-offer-dismiss"
            disabled={sent}
            onClick={() => decide("dismiss")}
          >
            不用
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="preference-offer-save"
            disabled={sent}
            onClick={() => decide("save")}
          >
            记住
          </button>
        </div>
      ) : (
        <p className="approval-decided" data-testid="preference-offer-decided">
          {PREFERENCE_DECIDED_TEXT[body.status]}
        </p>
      )}
    </div>
  );
};

const TOOL_STATUS_TEXT: Record<ToolCall["status"], string> = {
  running: "运行中",
  ok: "完成",
  failed: "失败",
  blocked: "拦下",
};

const ToolCallCard = ({
  messageId,
  body,
  selected,
  onInspect,
}: {
  messageId: MessageId;
  body: ToolCall;
  selected: boolean;
  onInspect: InspectTool;
}) => (
  <button
    type="button"
    className={`tool-line${selected ? " is-selected" : ""}`}
    data-testid="tool-call-card"
    data-status={body.status}
    data-view-kind={body.view.kind}
    aria-pressed={selected}
    onClick={() => onInspect({ messageId, body })}
  >
    <span className="tool-args">
      <ToolViewContent view={body.view} />
    </span>
    <span aria-hidden="true">·</span>
    <span className={`status-dot status-${body.status}`} role="img" aria-label={TOOL_STATUS_TEXT[body.status]} />
    <span className="tool-meta">{body.durationMs === null ? "—" : `${(body.durationMs / 1000).toFixed(1)}s`}</span>
  </button>
);

const DECIDED_TEXT: Record<Exclude<Approval["status"], "pending">, string> = {
  approved: "已批准",
  rejected: "已拒绝",
  expired: "已失效",
  voided: "已作废 · 你发了新消息，这一步不做了",
  timed_out: "已拒绝 · 10 分钟没人批",
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
  const { state } = useApp();
  const tools = state.status === "ready" ? state.tools : [];
  const [sent, setSent] = useState(false);
  const failed = useFailureToast();
  // 结论以服务端推回来的那条为准，这里只锁住按钮，免得一次点两下发两个决定。
  const decide = (request: DecideApprovalRequest) => {
    setSent(true);
    void onDecide(approval.id, request).catch((cause: unknown) => {
      setSent(false);
      failed("这一步没记下，再点一次")(cause);
    });
  };
  if (approval.status === "expired") {
    return (
      <div className="card card-approval" data-testid="approval-card" data-status={approval.status}>
        <div className="card-title">
          <ShieldAlert size={16} aria-hidden="true" />
          已失效 · {ACTION_TEXT[approval.action]}
        </div>
        <p className="approval-summary" data-testid="approval-summary">
          <ToolViewContent view={approval.view} approval tools={tools} />
        </p>
        <ApprovalDetails view={approval.view} />
        <div className="approval-actions">
          <p className="approval-expired-text">这一步已经不用了</p>
        </div>
      </div>
    );
  }
  if (approval.status !== "pending") {
    return (
      <div className="card card-approval approval-compact" data-testid="approval-card" data-status={approval.status}>
        <span className="approval-compact-text">
          <ToolViewContent view={approval.view} approval tools={tools} />
        </span>
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
        需要你点头 · {ACTION_TEXT[approval.action]}
      </div>
      <p className="approval-summary" data-testid="approval-summary">
        <ToolViewContent view={approval.view} approval tools={tools} />
      </p>
      <ApprovalDetails view={approval.view} />
      {approval.target === null ? null : <p className="approval-target">目标：{targetText(approval.target)}</p>}
      {approval.deadlineAt === null ? null : (
        <p className="approval-target" data-testid="approval-deadline">
          {new Date(approval.deadlineAt).toLocaleTimeString("zh-TW", {
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          })}{" "}
          前没人批就按拒绝处理
        </p>
      )}
      <div className="approval-actions">
        <button
          type="button"
          className="ghost-button"
          data-testid="approval-reject"
          disabled={sent}
          onClick={() => decide({ decision: "rejected" })}
        >
          拒绝
        </button>
        {offeredScopes(approval).map((scope) => (
          // approval-approve 是桌面 prove 和真栈验收脚本点的钩子，范围的 testid 只好挂在外层。
          <span data-testid={`approval-scope-${scope}`} key={scope}>
            <button
              type="button"
              className="primary-button"
              data-testid={scope === "once" ? "approval-approve" : undefined}
              disabled={sent}
              onClick={() => decide({ decision: "approved", scope })}
            >
              批准<small>{SCOPE_TEXT[scope]}</small>
            </button>
          </span>
        ))}
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
        <BotAvatar shape={to.shape} hue={to.hue} size="xs" />
        {to.name}
      </div>
      <div className="card card-handoff" data-testid="handoff-card" data-status={handoff.status}>
        <div className="handoff-head">
          <ArrowRightLeft size={16} aria-hidden="true" />
          <span className="handoff-label">交接</span>
          <span className="handoff-pair" data-testid="handoff-pair">
            <BotAvatar shape={from.shape} hue={from.hue} size="xs" />
            {from.name}
            <span className="handoff-arrow" aria-hidden="true">
              →
            </span>
            <BotAvatar shape={to.shape} hue={to.hue} size="xs" />
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
  onDecidePreferenceOffer: DecidePreferenceOffer;
  onInspectTool: InspectTool;
  selectedToolId: MessageId | null;
  showSource: boolean;
  content: ContentBook;
  contentActions: ContentActions;
  projectOfferActions: ProjectOfferActions;
};

const MessageView = ({
  message,
  lookup,
  approvals,
  handoffs,
  checklist,
  onDecide,
  onDecideSkillOffer,
  onDecidePreferenceOffer,
  onInspectTool,
  selectedToolId,
  showSource,
  content,
  contentActions,
  projectOfferActions,
}: MessageProps) => {
  const body = message.body;
  return (
    <div className="message" data-testid="message" data-kind={body.kind} data-message-id={message.id}>
      {(() => {
        switch (body.kind) {
          case "user":
            return <UserBubble body={body} />;
          case "bot":
            return <BotBubble body={body} lookup={lookup} showSource={showSource} />;
          case "system":
            return <SystemNote body={body} />;
          case "tool_call":
            return body.view.kind === "takeover" ? (
              <TakeoverCard
                messageId={message.id}
                body={body}
                view={body.view}
                botName={lookup(body.botId).name}
                content={content}
                actions={contentActions}
                selected={selectedToolId === message.id}
                onInspect={onInspectTool}
              />
            ) : (
              <ToolCallCard
                messageId={message.id}
                body={body}
                selected={selectedToolId === message.id}
                onInspect={onInspectTool}
              />
            );
          case "cost":
            return null;
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
          case "preference_offer":
            return <PreferenceOfferCard body={body} messageId={message.id} onDecide={onDecidePreferenceOffer} />;
          case "handoff": {
            const handoff = handoffs[body.handoffId];
            return handoff === undefined ? (
              <HandoffPlaceholder />
            ) : (
              <HandoffCard handoff={handoff} message={message} lookup={lookup} checklist={checklist} />
            );
          }
          case "draft": {
            const botId = content.drafts[body.draftId]?.botId ?? null;
            return (
              <DraftCard
                draftId={body.draftId}
                botName={botId === null ? null : lookup(botId).name}
                content={content}
                actions={contentActions}
              />
            );
          }
          case "plan": {
            const botId = content.plans[body.planId]?.botId ?? null;
            return (
              <PlanCard
                planId={body.planId}
                botName={botId === null ? null : lookup(botId).name}
                content={content}
                actions={contentActions}
              />
            );
          }
          case "project_offer":
            return (
              <ProjectOfferCard
                body={body}
                messageId={message.id}
                accounts={content.accounts}
                actions={projectOfferActions}
              />
            );
          case "team_offer":
            return <TeamOfferCard body={body} messageId={message.id} />;
          case "routine_offer":
            return <RoutineOfferCard message={message} />;
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

export type ToggleTools = (ids: MessageId[], open: boolean) => void;

const Activity = ({
  tools,
  openTools,
  onToggle,
  selectedToolId,
  onInspect,
}: {
  tools: Message[];
  openTools: ReadonlySet<MessageId>;
  onToggle: ToggleTools;
  selectedToolId: MessageId | null;
  onInspect: InspectTool;
}) => {
  // 展开状态按工具消息 id 记在面板上：往上接页并进打头的回合、往后追加一步，回合都可能重挂载或换一批工具，
  // 任意一步记着就算展开。
  const open = tools.some((message) => openTools.has(message.id));
  const running = tools.some((message) => message.body.kind === "tool_call" && message.body.status === "running");

  return (
    <div className="activity" data-testid="activity">
      <div className="turn-meta">
        <button
          className="activity-toggle"
          type="button"
          data-testid="activity-toggle"
          aria-expanded={open}
          onClick={() =>
            onToggle(
              tools.map((message) => message.id),
              !open,
            )
          }
        >
          {running ? `干活中，做了 ${tools.length} 步…` : `做了 ${tools.length} 步`}
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
      </div>
      <div className="activity-lines">
        {tools.map((message) => (
          <div
            className="message"
            data-testid="message"
            data-kind="tool_call"
            data-message-id={message.id}
            key={message.id}
            hidden={!open}
          >
            {message.body.kind === "tool_call" ? (
              <ToolCallCard
                messageId={message.id}
                body={message.body}
                selected={selectedToolId === message.id}
                onInspect={onInspect}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

type TurnProps = Omit<MessageProps, "message"> & {
  turn: Turn;
  openTools: ReadonlySet<MessageId>;
  onToggleTools: ToggleTools;
};

// 工具调用收进「做了几步」，跑的过程中也折着，人只看结果，要查再点开。接手卡是要人动手的，交还之后也得看得见结论，不进折叠区。
const folded = (message: Message) => message.body.kind === "tool_call" && message.body.view.kind !== "takeover";

export const TurnView = ({ turn, openTools, onToggleTools, ...props }: TurnProps) => {
  if (turn.kind === "system" && turn.message.body.kind === "system" && turn.message.body.tone === "error") {
    return (
      <div className="turn turn-system">
        <div className="message" data-testid="message" data-kind="system" data-message-id={turn.message.id}>
          <div className="notice notice-error" data-testid="notice" data-tone="error">
            <TriangleAlert size={16} aria-hidden="true" />
            <div className="notice-body">
              <p>{turn.message.body.text}</p>
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
      </div>
    );
  }
  const tools = turn.items.filter(folded);
  return (
    <div className="turn turn-bot" data-testid="bot-turn" data-bot-id={turn.botId}>
      <div className="turn-content">
        {turn.items
          .filter((message) => !folded(message))
          .map((message) => (
            <MessageView key={message.id} message={message} {...props} />
          ))}
        {tools.length > 0 ? (
          <Activity
            tools={tools}
            openTools={openTools}
            onToggle={onToggleTools}
            selectedToolId={props.selectedToolId}
            onInspect={props.onInspectTool}
          />
        ) : null}
      </div>
    </div>
  );
};
