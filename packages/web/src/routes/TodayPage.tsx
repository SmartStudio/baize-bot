import { useState } from "react";
import { ArrowRight, CalendarClock, Check, ExternalLink, SendHorizontal, Sparkles, TriangleAlert } from "lucide-react";
import type { ApprovalId, DecideApprovalRequest, Draft, GroupId, TodayResponse } from "@baize/shared";
import { ToolViewContent } from "../components/messages/ToolViewContent.js";
import { pendingCountOf, type Today } from "../state/today.js";

const PLATFORM: Record<Draft["platform"], string> = {
  github: "GitHub",
  x: "X",
  xiaohongshu: "小红书",
};

const greeting = (name: string): string => {
  const hour = new Date().getHours();
  const time = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  return `${name}，${time}`;
};

const draftText = (draft: Draft): string =>
  draft.content.kind === "post" ? (draft.content.title ?? draft.content.text) : `回复 ${draft.content.replyTo.author}`;

export const timeText = (at: string, now = new Date()): string => {
  const date = new Date(at);
  const day = (value: Date): string => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day(date) === day(now)) return `今天 ${clock}`;
  if (day(date) === day(tomorrow)) return `明天 ${clock}`;
  if (day(date) === day(yesterday)) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
};

type PendingProps = {
  data: TodayResponse["pending"];
  compact?: boolean;
  onDecide: (approvalId: ApprovalId, request: DecideApprovalRequest) => Promise<void>;
  onOpenGroup?: (groupId: GroupId) => void;
  onOpenSettings?: () => void;
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

export const TodayPending = ({ data, compact = false, onDecide, onOpenGroup, onOpenSettings }: PendingProps) => {
  if (data.length === 0) {
    return (
      <p className="today-empty" data-testid="today-empty">
        没有要你处理的事
      </p>
    );
  }
  return (
    <div className={`today-list${compact ? " is-compact" : ""}`}>
      {data.map((item) => {
        switch (item.kind) {
          case "approval":
            return <ApprovalRow item={item} onDecide={onDecide} key={item.approval.id} />;
          case "plan": {
            const content = (
              <>
                <span className="today-row-main">
                  <span className="today-kicker">内容计划</span>
                  <strong>{item.plan.title}</strong>
                  <small>{item.drafts.length} 条草稿等你确认</small>
                </span>
                {onOpenGroup === undefined ? null : <ArrowRight size={16} aria-hidden="true" />}
              </>
            );
            return onOpenGroup === undefined ? (
              <article
                className="today-row today-confirm"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.plan.id}
              >
                {content}
              </article>
            ) : (
              <button
                type="button"
                className="today-row today-confirm"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.plan.id}
                onClick={() => onOpenGroup(item.plan.groupId)}
              >
                {content}
              </button>
            );
          }
          case "draft": {
            const content = (
              <>
                <span className="today-row-main">
                  <span className="today-kicker">{PLATFORM[item.draft.platform]} 草稿</span>
                  <strong>{draftText(item.draft)}</strong>
                  <small>
                    {item.draft.content.kind === "reply" ? item.draft.content.replyTo.quote : item.draft.content.text}
                  </small>
                </span>
                {onOpenGroup === undefined ? null : <ArrowRight size={16} aria-hidden="true" />}
              </>
            );
            return onOpenGroup === undefined ? (
              <article
                className="today-row today-confirm"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.draft.id}
              >
                {content}
              </article>
            ) : (
              <button
                type="button"
                className="today-row today-confirm"
                data-testid="today-row"
                data-kind={item.kind}
                key={item.draft.id}
                onClick={() => onOpenGroup(item.draft.groupId)}
              >
                {content}
              </button>
            );
          }
          case "account": {
            const content = (
              <>
                <TriangleAlert size={18} aria-hidden="true" />
                <span className="today-row-main">
                  <span className="today-kicker">登录过期</span>
                  <strong>
                    {PLATFORM[item.account.platform]} · {item.account.handle ?? "账号未命名"}
                  </strong>
                  <small>在账号所在电脑重新登录</small>
                </span>
                {onOpenSettings === undefined ? null : <ArrowRight size={16} aria-hidden="true" />}
              </>
            );
            return onOpenSettings === undefined ? (
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
                onClick={onOpenSettings}
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
      {count > 0 ? <span className={id === "pending" ? "is-pending" : undefined}>{count}</span> : null}
    </header>
    {children}
  </section>
);

type Props = {
  today: Today;
  userName: string;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: PendingProps["onDecide"];
  onOpenGroup: (groupId: GroupId) => void;
  onOpenSettings: () => void;
};

export const TodayPage = ({ today, userName, onSend, onDecide, onOpenGroup, onOpenSettings }: Props) => {
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

  const pendingCount = pendingCountOf(data);
  const disabled = data.assistantGroupId === null;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (disabled || sending || text.length === 0 || data.assistantGroupId === null) return;
    setSending(true);
    setSendError(null);
    void onSend(data.assistantGroupId, text)
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
                onOpenGroup={onOpenGroup}
                onOpenSettings={onOpenSettings}
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
