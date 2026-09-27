import { useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  SendHorizontal,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { ApprovalId, DecideApprovalRequest, GroupId, TodayAssistantLine, TodayResponse } from "@baize/shared";
import { PLATFORM, draftText, timeText } from "../components/messages/content.js";
import { DraftCard, PlanCard, type ContentActions } from "../components/messages/DraftCards.js";
import type { BotLookup } from "../components/messages/MessageView.js";
import { ToolViewContent } from "../components/messages/ToolViewContent.js";
import type { ContentBook } from "../state/types.js";
import { withLoginCards } from "../state/accounts.js";
import type { Today } from "../state/today.js";
import { LoginCard } from "../components/LoginCard.js";

const greeting = (name: string): string => {
  const hour = new Date().getHours();
  const time = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  return `${name}，${time}`;
};

// 首页主窗口的计划行和草稿行就地展开成群里那同一张卡。菜单栏太窄，不给这一份，行就只是一行字。
export type Cards = { content: ContentBook; actions: ContentActions; lookup: BotLookup };

export type PendingProps = {
  data: TodayResponse["pending"];
  compact?: boolean;
  cards?: Cards;
  onDecide: (approvalId: ApprovalId, request: DecideApprovalRequest) => Promise<void>;
  onOpenGroup?: (groupId: GroupId) => void;
  onOpenAccounts?: () => void;
};

const ApprovalRow = ({
  item,
  onDecide,
}: {
  item: Extract<TodayResponse["pending"][number], { kind: "approval" }>;
  onDecide: PendingProps["onDecide"];
}) => {
  const [deciding, setDeciding] = useState<DecideApprovalRequest["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (request: DecideApprovalRequest) => {
    if (deciding !== null) return;
    setDeciding(request.decision);
    setError(null);
    try {
      await onDecide(item.approval.id, request);
    } catch {
      setError("没能提交结论，请重试");
    } finally {
      setDeciding(null);
    }
  };

  return (
    <article className="today-row today-confirm" data-testid="today-row" data-kind={item.kind}>
      <div className="today-row-main">
        <span className="today-kicker">需要你点头</span>
        <strong>
          <ToolViewContent view={item.approval.view} approval />
        </strong>
        {error === null ? null : (
          <small className="today-inline-error" role="alert">
            {error}
          </small>
        )}
      </div>
      <span className="today-row-actions">
        <button
          type="button"
          className="ghost-button today-row-action"
          disabled={deciding !== null}
          onClick={() => void decide({ decision: "rejected" })}
        >
          {deciding === "rejected" ? "拒绝中" : "拒绝"}
        </button>
        <button
          type="button"
          className="primary-button today-row-action"
          data-testid="approval-scope-once"
          disabled={deciding !== null}
          onClick={() => void decide({ decision: "approved", scope: "once" })}
        >
          {deciding === "approved" ? "批准中" : "批准"}
        </button>
      </span>
    </article>
  );
};

// 有卡片就就地展开；没有卡片时，主窗口里点了进群，菜单栏里只是一行字。
const PendingRow = ({
  kind,
  summary,
  groupId,
  cards,
  onOpenGroup,
  children,
}: {
  kind: "plan" | "draft";
  summary: React.ReactNode;
  groupId: GroupId;
  cards: Cards | undefined;
  onOpenGroup: ((groupId: GroupId) => void) | undefined;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  if (cards !== undefined) {
    return (
      <article
        className={`today-row today-confirm today-expandable${open ? " is-open" : ""}`}
        data-testid="today-row"
        data-kind={kind}
      >
        <button
          type="button"
          className="today-expand"
          data-testid="today-expand"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {summary}
          {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        </button>
        {open ? (
          <div className="today-expanded">
            {children}
            {onOpenGroup === undefined ? null : (
              <button
                type="button"
                className="today-open-group"
                data-testid="today-open-group"
                onClick={() => onOpenGroup(groupId)}
              >
                去群里看 <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        ) : null}
      </article>
    );
  }
  return onOpenGroup === undefined ? (
    <article className="today-row today-confirm" data-testid="today-row" data-kind={kind}>
      {summary}
    </article>
  ) : (
    <button
      type="button"
      className="today-row today-confirm"
      data-testid="today-row"
      data-kind={kind}
      onClick={() => onOpenGroup(groupId)}
    >
      {summary}
      <ArrowRight size={16} aria-hidden="true" />
    </button>
  );
};

export const TodayPending = ({ data, compact = false, cards, onDecide, onOpenGroup, onOpenAccounts }: PendingProps) => {
  if (data.length === 0) {
    return (
      <p className="today-empty" data-testid="today-empty">
        没有要你处理的事
      </p>
    );
  }
  return (
    <div className={`today-list${compact ? " is-compact" : ""}`}>
      {(cards === undefined ? data : withLoginCards(data, cards.content)).map((item) => {
        switch (item.kind) {
          case "login":
            return cards === undefined ? null : (
              <LoginCard
                key={`login-${item.account.id}`}
                account={item.account}
                computer={cards.content.computers[item.account.computerId]}
                flow={cards.content.logins[item.account.id]}
                onLogin={cards.actions.loginAccount}
              />
            );
          case "approval":
            return <ApprovalRow item={item} onDecide={onDecide} key={item.approval.id} />;
          case "plan": {
            const summary = (
              <span className="today-row-main">
                <span className="today-kicker">内容计划</span>
                <strong>{item.plan.title}</strong>
                <small>{item.drafts.length} 条草稿等你确认</small>
              </span>
            );
            return (
              <PendingRow
                kind={item.kind}
                summary={summary}
                groupId={item.plan.groupId}
                cards={cards}
                onOpenGroup={onOpenGroup}
                key={item.plan.id}
              >
                {cards === undefined ? null : (
                  <PlanCard
                    planId={item.plan.id}
                    botName={item.plan.botId === null ? null : cards.lookup(item.plan.botId).name}
                    content={cards.content}
                    actions={cards.actions}
                  />
                )}
              </PendingRow>
            );
          }
          case "draft": {
            const summary = (
              <span className="today-row-main">
                <span className="today-kicker">
                  {PLATFORM[item.draft.platform]} {item.draft.content.kind === "reply" ? "回复" : "草稿"}
                </span>
                <strong>{draftText(item.draft)}</strong>
                <small>
                  {item.draft.content.kind === "reply" ? item.draft.content.replyTo.quote : item.draft.content.text}
                </small>
              </span>
            );
            return (
              <PendingRow
                kind={item.kind}
                summary={summary}
                groupId={item.draft.groupId}
                cards={cards}
                onOpenGroup={onOpenGroup}
                key={item.draft.id}
              >
                {cards === undefined ? null : (
                  <DraftCard
                    draftId={item.draft.id}
                    botName={item.draft.botId === null ? null : cards.lookup(item.draft.botId).name}
                    content={cards.content}
                    actions={cards.actions}
                  />
                )}
              </PendingRow>
            );
          }
          case "account": {
            const content = (
              <>
                <TriangleAlert size={18} aria-hidden="true" />
                <span className="today-row-main">
                  <span className="today-kicker">{item.account.login === "none" ? "还没登录" : "登录过期"}</span>
                  <strong>
                    {PLATFORM[item.account.platform]} · {item.account.handle ?? "账号未命名"}
                  </strong>
                  <small>{item.account.login === "none" ? "在账号所在电脑登录" : "在账号所在电脑重新登录"}</small>
                </span>
                {onOpenAccounts === undefined ? null : <ArrowRight size={16} aria-hidden="true" />}
              </>
            );
            return onOpenAccounts === undefined ? (
              <article
                className="today-row today-alert"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.account.id}
              >
                {content}
              </article>
            ) : (
              <button
                type="button"
                className="today-row today-alert"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.account.id}
                onClick={onOpenAccounts}
              >
                {content}
              </button>
            );
          }
          default: {
            const unreachable: never = item;
            return unreachable;
          }
        }
      })}
    </div>
  );
};

const TodaySection = ({
  title,
  id,
  count,
  children,
}: {
  title: string;
  id: "pending" | "done" | "running" | "next";
  count: number;
  children: React.ReactNode;
}) => (
  <section className="today-section" data-testid={`today-${id}`}>
    <header className="today-section-head">
      <h2>{title}</h2>
      {count > 0 ? (
        <span className={id === "pending" ? "is-pending" : undefined} data-testid="today-section-count">
          {count}
        </span>
      ) : null}
    </header>
    {children}
  </section>
);

// 主助理最近说的那一句，点了进单聊接着聊。
const AssistantLatest = ({ line, onOpen }: { line: TodayAssistantLine; onOpen: (() => void) | null }) => {
  const content = (
    <>
      <span className="today-kicker">主助理</span>
      <span className="today-assistant-text" data-testid="today-assistant-text">
        {line.text}
      </span>
      <small>{timeText(line.at)}</small>
    </>
  );
  return onOpen === null ? (
    <p className="today-assistant" data-testid="today-assistant-latest">
      {content}
    </p>
  ) : (
    <button type="button" className="today-assistant" data-testid="today-assistant-latest" onClick={onOpen}>
      {content}
    </button>
  );
};

type Props = {
  today: Today;
  userName: string;
  cards: Cards;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: PendingProps["onDecide"];
  onOpenGroup: (groupId: GroupId) => void;
  onOpenAccounts: () => void;
};

export const TodayPage = ({ today, userName, cards, onSend, onDecide, onOpenGroup, onOpenAccounts }: Props) => {
  const { status, data, error, refresh } = today;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  if (status === "loading") {
    return (
      <main className="today-page today-loading" data-testid="today-page">
        正在整理今天的事
      </main>
    );
  }
  if (status === "failed" || data === null) {
    return (
      <main className="today-page today-loading" data-testid="today-page">
        <p>今天的清单没取到。</p>
        <button type="button" className="ghost-button" onClick={() => void refresh()}>
          重试
        </button>
      </main>
    );
  }

  const pendingCount = data.pending.length;
  const assistantGroupId = data.assistantGroupId;
  const disabled = assistantGroupId === null;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (sending || text.length === 0 || assistantGroupId === null) return;
    setSending(true);
    setSendError(null);
    void onSend(assistantGroupId, text)
      .then(() => setDraft(""))
      .catch(() => setSendError("没发出去，请重试"))
      .finally(() => setSending(false));
  };

  return (
    <main className="today-page" data-testid="today-page">
      <div className="today-content">
        <header className="today-greeting">
          <h1>{greeting(userName)}</h1>
          <p>
            {pendingCount > 0 ? `${pendingCount} 件事等你，其余在按计划跑。` : "没有要你处理的事，其余在按计划跑。"}
          </p>
        </header>
        {data.assistantLatest === null ? null : (
          <AssistantLatest
            line={data.assistantLatest}
            onOpen={assistantGroupId === null ? null : () => onOpenGroup(assistantGroupId)}
          />
        )}
        {error === null ? null : (
          <p className="today-refresh-error" role="status">
            {error}
          </p>
        )}
        <form className="today-composer" onSubmit={submit}>
          <Sparkles size={18} aria-hidden="true" />
          <input
            data-testid="today-composer-input"
            value={draft}
            disabled={disabled}
            aria-label="对主助理说一句"
            placeholder={disabled ? "主助理还没准备好" : "对主助理说一句，比如「下周多发点小红书」"}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="send-button"
            data-testid="today-composer-send"
            aria-label="发送给主助理"
            disabled={disabled || sending || draft.trim().length === 0}
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        </form>
        {sendError === null ? null : (
          <p className="today-form-error" role="alert">
            {sendError}
          </p>
        )}
        <div className="today-templates" aria-label="常用模板">
          {[
            ["推广一个产品", "这周推广一下我们的新版本，X 和小红书都发"],
            ["运营一个号", "把小红书账号做起来，年底做到 1000 粉"],
          ].map(([label, text]) => (
            <button
              type="button"
              className="today-template"
              key={label}
              disabled={disabled}
              onClick={() => setDraft(text ?? "")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="today-columns">
          <div className="today-column">
            <TodaySection title="等你确认" id="pending" count={pendingCount}>
              <TodayPending
                data={data.pending}
                cards={cards}
                onOpenGroup={onOpenGroup}
                onOpenAccounts={onOpenAccounts}
                onDecide={async (id, decision) => {
                  await onDecide(id, decision);
                  await refresh();
                }}
              />
            </TodaySection>
            <TodaySection title="刚做完" id="done" count={data.done.length}>
              {data.done.length === 0 ? (
                <p className="today-empty" data-testid="today-empty">
                  还没有新成果
                </p>
              ) : (
                <div className="today-list">
                  {data.done.map((item) => {
                    const content = (
                      <>
                        <Check size={18} aria-hidden="true" />
                        <span className="today-row-main">
                          <span className="today-kicker">
                            {item.kind === "publication"
                              ? `${PLATFORM[item.platform]} · 已发布`
                              : item.kind === "plan_approved"
                                ? "计划已批准"
                                : "例行已完成"}
                          </span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.kind === "plan_approved"
                              ? `${item.draftCount} 条草稿 · ${timeText(item.at)}`
                              : item.kind === "routine"
                                ? `${item.note} · ${timeText(item.at)}`
                                : timeText(item.at)}
                          </small>
                        </span>
                        {item.kind === "publication" ? (
                          <ExternalLink size={16} aria-hidden="true" />
                        ) : item.groupId === null ? null : (
                          <ArrowRight size={16} aria-hidden="true" />
                        )}
                      </>
                    );
                    if (item.kind === "publication") {
                      return (
                        <a
                          className="today-row today-result"
                          data-testid="today-row"
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          key={`${item.kind}-${item.at}-${item.title}`}
                        >
                          {content}
                        </a>
                      );
                    }
                    return item.groupId === null ? (
                      <article
                        className="today-row today-result"
                        data-testid="today-row"
                        key={`${item.kind}-${item.at}-${item.title}`}
                      >
                        {content}
                      </article>
                    ) : (
                      <button
                        type="button"
                        className="today-row today-result"
                        data-testid="today-row"
                        key={`${item.kind}-${item.at}-${item.title}`}
                        onClick={() => {
                          if (item.groupId !== null) onOpenGroup(item.groupId);
                        }}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
              )}
            </TodaySection>
          </div>
          <div className="today-column">
            <TodaySection title="在进行" id="running" count={data.running.length}>
              {data.running.length === 0 ? (
                <p className="today-empty" data-testid="today-empty">
                  现在没有进行中的计划
                </p>
              ) : (
                <div className="today-list">
                  {data.running.map((item) => (
                    <button
                      type="button"
                      className="today-row today-progress"
                      data-testid="today-row"
                      key={item.groupId}
                      onClick={() => onOpenGroup(item.groupId)}
                    >
                      <span className="today-row-main">
                        <span className="today-kicker">项目</span>
                        <strong>{item.title}</strong>
                        <progress value={item.published} max={Math.max(item.planned, 1)} />
                        <small>
                          {item.published} / {item.planned} 条已发布
                        </small>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </TodaySection>
            <TodaySection title="接下来" id="next" count={data.next.length}>
              {data.next.length === 0 ? (
                <p className="today-empty" data-testid="today-empty">
                  还没有排期
                </p>
              ) : (
                <div className="today-list">
                  {data.next.map((item) => {
                    const groupId = item.kind === "draft" ? item.draft.groupId : item.groupId;
                    const content = (
                      <>
                        <CalendarClock size={18} aria-hidden="true" />
                        <span className="today-row-main">
                          <span className="today-kicker">
                            {item.kind === "draft" ? PLATFORM[item.draft.platform] : "例行"}
                          </span>
                          <strong>{item.kind === "draft" ? draftText(item.draft) : item.title}</strong>
                          <small>{timeText(item.at)}</small>
                        </span>
                        {groupId === null ? null : <ArrowRight size={16} aria-hidden="true" />}
                      </>
                    );
                    const key = item.kind === "draft" ? item.draft.id : item.routineId;
                    return groupId === null ? (
                      <article className="today-row today-scheduled" data-testid="today-row" key={key}>
                        {content}
                      </article>
                    ) : (
                      <button
                        type="button"
                        className="today-row today-scheduled"
                        data-testid="today-row"
                        key={key}
                        onClick={() => onOpenGroup(groupId)}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
              )}
            </TodaySection>
          </div>
        </div>
      </div>
    </main>
  );
};
