import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Megaphone, MessageSquareReply } from "lucide-react";
import type {
  AccountId,
  ApprovePlanRequest,
  ContentPlan,
  ContentPlanId,
  DecideDraftRequest,
  Draft,
  DraftContent,
  PublishFailureReason,
  DraftId,
  DraftStatus,
} from "@baize/shared";
import type { ContentBook } from "../../state/types.js";
import { BrandBookOpener } from "../BrandBookDialog.js";
import { PLATFORM, accountText, computerText, draftText, timeText } from "./content.js";

export type ContentActions = {
  decideDraft: (draftId: DraftId, request: DecideDraftRequest) => Promise<void>;
  approvePlan: (planId: ContentPlanId, request: ApprovePlanRequest) => Promise<void>;
  returnPlan: (planId: ContentPlanId) => Promise<void>;
  loginAccount: (accountId: AccountId) => Promise<void>;
};

type Deciding = "approve" | "return" | null;

const STATUS: Record<DraftStatus, { label: string; tone: string }> = {
  pending: { label: "等你确认", tone: "badge-pending" },
  approved: { label: "已批", tone: "badge-accepted" },
  publishing: { label: "发布中", tone: "badge-running" },
  published: { label: "已发", tone: "badge-accepted" },
  failed: { label: "没发出去", tone: "badge-failed" },
  returned: { label: "已退回", tone: "badge-muted" },
};

const FAILURE: Record<PublishFailureReason, string> = {
  login_expired: "账号登录过期了，重新登录后让 Bot 再起一稿",
  page_changed: "平台页面变了，没发出去",
  paused: "Bot 已暂停，这条没发出去，恢复 Bot 后让它再起一稿",
  error: "没发出去",
};

const withText = (content: DraftContent, text: string): DraftContent => ({ ...content, text });

// 改字记着是照哪一版正文改的。Bot 换了正文，这份改字就作废，卡上回到新正文，批准也不再带它。
type Edit = { base: string; text: string };

const editedText = (draft: Draft, edit: Edit | undefined): string =>
  edit !== undefined && edit.base === draft.content.text ? edit.text : draft.content.text;

const scheduleText = (draft: Draft): string =>
  draft.scheduledAt === null ? "批完就发" : `${timeText(draft.scheduledAt)} 发`;

const firstLine = (text: string): string => text.split("\n")[0] ?? text;

const byScheduledAt = (left: Draft, right: Draft): number =>
  (left.scheduledAt ?? "￿").localeCompare(right.scheduledAt ?? "￿");

const dayText = (at: string): string => {
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const DraftMeta = ({ draft, content }: { draft: Draft; content: ContentBook }) => {
  const account = content.accounts[draft.accountId];
  return (
    <p className="draft-meta" data-testid="draft-meta">
      {PLATFORM[draft.platform]} · {accountText(account)} · 从{computerText(account, content.computers)}发出 ·{" "}
      {scheduleText(draft)}
    </p>
  );
};

// 草稿卡和计划卡里展开的那一条共用这一块：原话、正文、改过的提示。只有待批的能改。
const DraftBody = ({
  draft,
  text,
  onText,
}: {
  draft: Draft;
  text: string;
  onText: ((text: string) => void) | null;
}) => (
  <>
    {draft.content.kind === "reply" ? (
      <blockquote className="draft-quote" data-testid="draft-quote">
        <b>{draft.content.replyTo.author}</b>：{draft.content.replyTo.quote}
      </blockquote>
    ) : null}
    {onText === null ? (
      <p className="draft-text">{draft.content.text}</p>
    ) : (
      <textarea
        className={`draft-editor${text === draft.content.text ? "" : " is-edited"}`}
        data-testid="draft-editor"
        data-original={draft.content.text}
        aria-label="草稿正文"
        rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
        value={text}
        onChange={(event) => onText(event.target.value)}
      />
    )}
    {onText !== null && text !== draft.content.text ? (
      <p className="brand-hint" data-testid="brand-hint">
        改过的地方会记进<BrandBookOpener className="brand-hint-link">品牌手册</BrandBookOpener>，下次照着写
      </p>
    ) : null}
  </>
);

const CopyText = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="ghost-button draft-copy"
      data-testid="draft-copy"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied("copied"),
          () => setCopied("failed"),
        )
      }
    >
      <Copy size={14} aria-hidden="true" />
      {copied === "copied" ? "已复制" : copied === "failed" ? "复制失败，再点一次" : "复制正文"}
    </button>
  );
};

// 批完之后每种状态各说一句。可起草档批了也不发，只有它给「复制正文」。
const DraftOutcome = ({ draft, content }: { draft: Draft; content: ContentBook }) => {
  const publication = content.publications[draft.id];
  switch (draft.status) {
    case "pending":
      return null;
    case "approved":
      return content.accounts[draft.accountId]?.tier === "draft" ? (
        <div className="draft-outcome">
          <span>可起草档，不会自动发，复制去平台上自己发。</span>
          <CopyText text={draft.content.text} />
        </div>
      ) : (
        <div className="draft-outcome">{scheduleText(draft)}</div>
      );
    case "publishing":
      return <div className="draft-outcome">正在发出</div>;
    case "published":
      return (
        <div className="draft-outcome">
          {publication === undefined ? (
            "已发出"
          ) : (
            <a href={publication.url} target="_blank" rel="noreferrer" data-testid="draft-link">
              看原帖 <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      );
    case "failed":
      return (
        <div className="draft-outcome is-failed" data-testid="draft-failure">
          {draft.failure === null ? FAILURE.error : FAILURE[draft.failure]}
        </div>
      );
    case "returned":
      return <div className="draft-outcome">已退回，不会发。</div>;
    default: {
      const unreached: never = draft.status;
      return unreached;
    }
  }
};

export const DraftCard = ({
  draftId,
  botName,
  content,
  actions,
}: {
  draftId: DraftId;
  botName: string | null;
  content: ContentBook;
  actions: ContentActions;
}) => {
  const draft = content.drafts[draftId];
  const [edit, setEdit] = useState<Edit | undefined>(undefined);
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [error, setError] = useState<string | null>(null);
  if (draft === undefined) return null;

  const current = editedText(draft, edit);
  const reply = draft.content.kind === "reply";
  const status = STATUS[draft.status];
  const decide = (request: DecideDraftRequest) => {
    if (deciding !== null) return;
    setDeciding(request.decision);
    setError(null);
    actions
      .decideDraft(draft.id, request)
      .catch(() => setError("没能提交，请重试"))
      .finally(() => setDeciding(null));
  };

  return (
    <div className="card draft-card" data-testid="draft-card" data-status={draft.status}>
      <div className="draft-card-head">
        {reply ? <MessageSquareReply size={16} aria-hidden="true" /> : <Megaphone size={16} aria-hidden="true" />}
        <span className="draft-card-title">
          <b>{reply ? "回复一条评论" : draftText(draft)}</b>
          <small>
            {botName === null ? "" : `${botName} · `}
            {PLATFORM[draft.platform]} {accountText(content.accounts[draft.accountId])}
          </small>
        </span>
        <span className={`badge ${status.tone}`}>{status.label}</span>
      </div>
      <DraftMeta draft={draft} content={content} />
      <DraftBody
        draft={draft}
        text={current}
        onText={draft.status === "pending" ? (text) => setEdit({ base: draft.content.text, text }) : null}
      />
      {draft.status === "pending" ? (
        <div className="approval-actions draft-actions">
          <button
            type="button"
            className="ghost-button"
            data-testid="draft-return"
            disabled={deciding !== null}
            onClick={() => decide({ decision: "return" })}
          >
            {deciding === "return" ? "退回中" : "退回"}
          </button>
          <button
            type="button"
            className="primary-button"
            data-testid="draft-approve"
            disabled={deciding !== null || current.trim().length === 0}
            onClick={() =>
              decide(
                current === draft.content.text
                  ? { decision: "approve" }
                  : { decision: "approve", content: withText(draft.content, current) },
              )
            }
          >
            {deciding === "approve" ? "批准中" : "批准"}
          </button>
        </div>
      ) : (
        <DraftOutcome draft={draft} content={content} />
      )}
      {error === null ? null : (
        <p className="draft-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

const PlanFolded = ({ plan }: { plan: ContentPlan }) => (
  <div className="card plan-card is-folded" data-testid="plan-card" data-status={plan.status}>
    <Megaphone size={16} aria-hidden="true" />
    <span className="plan-folded-title">{plan.title}</span>
    <span className={`badge ${plan.status === "approved" ? "badge-accepted" : "badge-muted"}`}>
      {plan.status === "approved" ? `已批 ${plan.draftIds.length} 条` : "已退回"}
    </span>
  </div>
);

export const PlanCard = ({
  planId,
  botName,
  content,
  actions,
}: {
  planId: ContentPlanId;
  botName: string | null;
  content: ContentBook;
  actions: ContentActions;
}) => {
  const plan = content.plans[planId];
  const [open, setOpen] = useState<ReadonlySet<DraftId>>(new Set());
  const [texts, setTexts] = useState<Partial<Record<DraftId, Edit>>>({});
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [error, setError] = useState<string | null>(null);
  if (plan === undefined) return null;
  if (plan.status !== "pending") return <PlanFolded plan={plan} />;

  const drafts = plan.draftIds
    .map((id) => content.drafts[id])
    .filter((draft): draft is Draft => draft !== undefined)
    .sort(byScheduledAt);
  const edits = drafts.flatMap((draft) => {
    const text = editedText(draft, texts[draft.id]);
    return text === draft.content.text ? [] : [{ draftId: draft.id, content: withText(draft.content, text) }];
  });
  const scheduled = drafts.flatMap((draft) => (draft.scheduledAt === null ? [] : [draft.scheduledAt]));
  const first = scheduled[0];
  const last = scheduled.at(-1);
  const range =
    first === undefined || last === undefined
      ? null
      : dayText(first) === dayText(last)
        ? dayText(first)
        : `${dayText(first)}到${dayText(last)}`;

  const toggle = (id: DraftId) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (kind: Exclude<Deciding, null>, work: () => Promise<void>) => {
    if (deciding !== null) return;
    setDeciding(kind);
    setError(null);
    work()
      .catch(() => setError("没能提交，请重试"))
      .finally(() => setDeciding(null));
  };

  return (
    <div className="card plan-card" data-testid="plan-card" data-status={plan.status}>
      <div className="draft-card-head">
        <Megaphone size={16} aria-hidden="true" />
        <span className="draft-card-title">
          <b>{plan.title}</b>
          <small>
            {[botName, `${drafts.length} 条草稿`, range].filter((part): part is string => part !== null).join(" · ")}
          </small>
        </span>
        <span className="badge badge-pending">等你确认</span>
      </div>
      <ol className="plan-drafts">
        {drafts.map((draft) => {
          const text = editedText(draft, texts[draft.id]);
          const expanded = open.has(draft.id);
          return (
            <li
              className={`plan-draft${expanded ? " is-open" : ""}`}
              data-testid="plan-draft"
              data-scheduled-at={draft.scheduledAt ?? ""}
              key={draft.id}
            >
              <button
                type="button"
                className="plan-draft-toggle"
                data-testid="plan-draft-toggle"
                aria-expanded={expanded}
                onClick={() => toggle(draft.id)}
              >
                <span className="plan-draft-time">
                  {draft.scheduledAt === null ? "批完就发" : timeText(draft.scheduledAt)}
                </span>
                <span className="badge">{PLATFORM[draft.platform]}</span>
                <span className="plan-draft-line">{firstLine(text)}</span>
                {text === draft.content.text ? null : <span className="badge badge-accepted">已改</span>}
                {expanded ? (
                  <ChevronDown size={14} aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" />
                )}
              </button>
              {expanded ? (
                <div className="plan-draft-body">
                  <DraftMeta draft={draft} content={content} />
                  <DraftBody
                    draft={draft}
                    text={text}
                    onText={(next) =>
                      setTexts((current) => ({ ...current, [draft.id]: { base: draft.content.text, text: next } }))
                    }
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="plan-note">批准后按排期发出，不再逐条问你。发之前内容被改动，会重新问。</p>
      <div className="approval-actions draft-actions">
        <button
          type="button"
          className="ghost-button"
          data-testid="plan-return"
          disabled={deciding !== null}
          onClick={() => run("return", () => actions.returnPlan(plan.id))}
        >
          {deciding === "return" ? "退回中" : "退回"}
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="plan-approve"
          disabled={deciding !== null || edits.some((edit) => edit.content.text.trim().length === 0)}
          onClick={() => run("approve", () => actions.approvePlan(plan.id, { edits }))}
        >
          {deciding === "approve"
            ? "批准中"
            : `批准 ${drafts.length} 条${edits.length === 0 ? "" : `（改了 ${edits.length} 条）`}`}
        </button>
      </div>
      {error === null ? null : (
        <p className="draft-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
