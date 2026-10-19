import { useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  ExternalLink,
  History,
  NotebookText,
  MessagesSquare,
  SendHorizontal,
  UserPlus,
  Users,
} from "lucide-react";
import type { Bot, BotId, GroupId, Message, ProjectResponse, ProjectTurn } from "@baize/shared";
import { ArchiveGroup } from "../components/ArchiveGroup.js";
import { BotAvatar } from "../components/BotAvatar.js";
import { PLATFORM, draftText, timeText } from "../components/messages/content.js";
import { Markdown } from "../components/messages/markdown.js";
import { RoutineStateChip } from "../components/routines/RoutineStateChip.js";
import { previewOf } from "../components/messages/preview.js";
import type { BotLookup } from "../components/messages/MessageView.js";
import type { Conversation } from "../state/types.js";
import { byCreatedAt } from "../state/order.js";
import { dueTextOf } from "../components/TaskCard.js";
import { goalBarValue, goalProgressOf, goalText, numberText, weekDeltaText, type Project } from "../state/project.js";
import { TodayPending, type Cards, type PendingProps } from "./TodayPage.js";

type Team = Extract<Conversation, { kind: "team" }>;

const ADJUST_TEAM_DRAFT = "想调整队伍：";

// 进度条后面跟的本周变化，原型里是一句「本周 +N」。勾掉的项和发出的条数各一句，是零就不说。
export const weekChangesOf = (week: Pick<ProjectResponse, "weekChecked" | "weekPublished">): string[] => [
  ...(week.weekChecked > 0 ? [`本周勾掉 ${week.weekChecked} 项`] : []),
  ...(week.weekPublished > 0 ? [`本周发出 ${week.weekPublished} 条`] : []),
];

// 一轮是你说的一句话，连同它之后、你下一句之前群里的其他消息，cost 不算。最近一轮以服务端给的为准，它不受群历史窗口限制。
// 本地群历史跟着推送走，比服务端那份新：同 id 的换成本地这份（流式正文在长），服务端没有的新消息接在后面，
// 拉取之后你又说了话，最近一轮就从本地这句起，更早的轮数跟着加。服务端没见过的消息只收时间严格晚于那句的，
// 同一毫秒的先后本地判不了，留给下一次重拉按落库顺序定。
export const latestTurnOf = (
  server: ProjectTurn | null,
  olderTurns: number,
  local: readonly Message[],
): { turn: Message[]; older: number } => {
  const at = (message: Message) => Date.parse(message.createdAt);
  const fresh = new Map(local.map((message) => [message.id, message]));
  const known =
    server === null ? [] : [server.said, ...server.replies].map((message) => fresh.get(message.id) ?? message);
  const knownIds = new Set(known.map((message) => message.id));
  const extra = local.filter((message) => !knownIds.has(message.id) && message.body.kind !== "cost");
  const since = server === null ? -Infinity : at(server.said);
  const newer = extra.filter((message) => message.body.kind === "user" && at(message) > since).toSorted(byCreatedAt);
  const said = newer.at(-1) ?? known[0];
  if (said === undefined) return { turn: [], older: olderTurns };
  const from = at(said);
  const replies = [...known.slice(1), ...extra]
    .filter(
      (message) =>
        message.body.kind !== "user" && (knownIds.has(message.id) ? at(message) >= from : at(message) > from),
    )
    .toSorted(byCreatedAt);
  return {
    turn: [said, ...replies],
    older: newer.length === 0 ? olderTurns : olderTurns + (server === null ? 0 : 1) + newer.length - 1,
  };
};

// 一块一条消息的流式形态下，同一个 Bot 连着说的几条只在第一条上露头像和名字。中间隔了别人或别的消息就重新露。
const continuesBot = (message: Message, before: Message | undefined): boolean =>
  message.body.kind === "bot" && before?.body.kind === "bot" && before.body.botId === message.body.botId;

const TurnMessage = ({
  message,
  before,
  lookup,
}: {
  message: Message;
  before: Message | undefined;
  lookup: BotLookup;
}) => {
  const body = message.body;
  if (body.kind === "user") return <p className="bubble bubble-user project-turn-me">{body.text}</p>;
  if (body.kind === "bot") {
    const bot = lookup(body.botId);
    return (
      <div className="project-turn-bot">
        {continuesBot(message, before) ? null : (
          <span className="project-turn-who" data-testid="project-turn-who">
            <BotAvatar shape={bot.shape} hue={bot.hue} size="xs" />
            {bot.name}
          </span>
        )}
        <Markdown text={body.text} />
      </div>
    );
  }
  return <small className="project-turn-note">{previewOf(body)}</small>;
};

const Block = ({
  title,
  id,
  aside,
  children,
}: {
  title: string;
  id: "pending" | "plan" | "next" | "achievements";
  aside?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="project-block" data-testid={`project-${id}`}>
    <header className="project-block-head">
      <h3>{title}</h3>
      {aside}
    </header>
    {children}
  </section>
);

type Props = {
  project: Project;
  conversation: Team;
  bots: Record<BotId, Bot>;
  messages: readonly Message[];
  lookup: BotLookup;
  cards: Cards;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: PendingProps["onDecide"];
  onOpenGroup: (groupId: GroupId) => void;
  onArchive: (groupId: GroupId) => Promise<unknown>;
};

export const ProjectPage = ({
  project,
  conversation,
  bots,
  messages,
  lookup,
  cards,
  onSend,
  onDecide,
  onOpenGroup,
  onArchive,
}: Props) => {
  const { status, data, error, refresh } = project;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const task = conversation.task;
  const groupId = conversation.groupId;
  const members = conversation.botIds.flatMap((botId) => {
    const bot = bots[botId];
    return bot === undefined ? [] : [bot];
  });

  if (status === "loading") {
    return (
      <main className="today-page today-loading" data-testid="project-page">
        正在整理这个项目
      </main>
    );
  }
  if (status === "failed" || data === null) {
    return (
      <main className="today-page today-loading" data-testid="project-page">
        <p>{error}</p>
        <button type="button" className="ghost-button" onClick={() => void refresh()}>
          重试
        </button>
      </main>
    );
  }

  const done = task.checklist.filter((item) => item.done).length;
  const goal = goalProgressOf(task.goal, task.metric, new Date());
  const goalWeek = goal === null ? null : weekDeltaText(goal.weekDelta);
  const { turn, older } = latestTurnOf(data.latestTurn, data.olderTurns, messages);
  const working = data.working[0];
  // 调整队伍就是跟主助理说一句：预填开头把话头递过去，已经打了字的不覆盖。
  const adjustTeam = () => {
    setDraft((current) => (current.trim() === "" ? ADJUST_TEAM_DRAFT : current));
    input.current?.focus();
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (sending || text.length === 0) return;
    setSending(true);
    setSendError(null);
    void onSend(groupId, text)
      .then(() => setDraft(""))
      .catch(() => setSendError("没发出去，请重试"))
      .finally(() => setSending(false));
  };

  return (
    <main className="today-page" data-testid="project-page">
      <div className="today-content">
        <header className="project-head">
          <div className="project-head-main">
            <h1>{task.title}</h1>
            {task.summary === "" ? null : <p className="project-goal">{task.summary}</p>}
            {task.cadence === "" ? null : (
              <p className="project-cadence" data-testid="project-cadence">
                节奏：{task.cadence}
              </p>
            )}
            <div className="project-progress" data-testid="project-progress">
              {goal === null ? (
                <span>
                  <b>{done}</b> / {task.checklist.length} 项
                </span>
              ) : (
                <>
                  <span>
                    <b>{numberText(goal.current)}</b> / {numberText(goal.target)} {goal.unit}
                  </span>
                  <progress value={goalBarValue(goal)} max={goal.target} aria-label={goalText(goal)} />
                  {goalWeek === null ? null : (
                    <span className="project-up" data-testid="project-goal-week">
                      {goalWeek}
                    </span>
                  )}
                  {task.goal === null || task.goal.dueAt === null ? null : (
                    <span>截止 {dueTextOf(task.goal.dueAt)}</span>
                  )}
                </>
              )}
              {weekChangesOf(data).map((text) => (
                <span key={text} className="project-up" data-testid="project-week">
                  {text}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="ghost-button project-open-group"
            data-testid="project-open-group"
            onClick={() => onOpenGroup(groupId)}
          >
            <MessagesSquare size={16} aria-hidden="true" />
            进项目群
          </button>
          <ArchiveGroup groupId={groupId} handInPlay={false} onArchive={onArchive} />
        </header>
        {error === null ? null : (
          <p className="today-refresh-error" role="status">
            {error}
          </p>
        )}
        <form className="today-composer project-composer" onSubmit={submit}>
          <input
            ref={input}
            data-testid="project-composer-input"
            value={draft}
            aria-label="对这个项目说一句"
            placeholder="对这个项目说一句，比如「这周多发两条小红书」"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="send-button"
            data-testid="project-composer-send"
            aria-label="发到项目群"
            disabled={sending || draft.trim().length === 0}
          >
            <SendHorizontal size={16} aria-hidden="true" />
          </button>
        </form>
        {sendError === null ? null : (
          <p className="today-form-error" role="alert">
            {sendError}
          </p>
        )}
        <div className="project-thread" data-testid="project-thread">
          <div className="project-latest" data-testid="project-latest-turn">
            {turn.length === 0 ? (
              <p className="today-empty">你还没在这个项目里说过话，在上面说一句就是第一轮</p>
            ) : (
              turn.map((message, at) => (
                <TurnMessage message={message} before={turn[at - 1]} lookup={lookup} key={message.id} />
              ))
            )}
          </div>
          <button
            type="button"
            className="project-older"
            data-testid="project-older"
            onClick={() => onOpenGroup(groupId)}
          >
            <History size={14} aria-hidden="true" />
            {older > 0 ? `更早 ${older} 轮 · 完整对话在项目群里` : "完整对话在项目群里"}
          </button>
        </div>
        <Block
          title="等你"
          id="pending"
          aside={
            working === undefined ? null : (
              <span className="project-working" data-testid="project-working">
                {working.botId === null ? "" : `${lookup(working.botId).name}在做：`}
                {working.title}
                {data.working.length > 1 ? ` 等 ${data.working.length} 件` : ""}
                ，写好会变成草稿卡放在这里
              </span>
            )
          }
        >
          <TodayPending
            data={data.pending}
            cards={cards}
            onOpenGroup={onOpenGroup}
            onDecide={async (id, decision) => {
              await onDecide(id, decision);
              await refresh();
            }}
          />
        </Block>
        {data.plan !== null ? (
          <Block
            title="本周计划"
            id="plan"
            aside={
              <span className="project-block-count">
                {data.plan.drafts.filter((item) => item.status === "published").length} / {data.plan.drafts.length}{" "}
                条已发布
              </span>
            }
          >
            <div className="today-list">
              {data.plan.drafts.map((item) => (
                <article className="today-row today-scheduled" key={item.id}>
                  <CalendarClock size={18} aria-hidden="true" />
                  <span className="today-row-main">
                    <span className="today-kicker">
                      {PLATFORM[item.platform]}
                      {item.scheduledAt === null ? "" : ` · ${timeText(item.scheduledAt)}`}
                    </span>
                    <strong>{draftText(item)}</strong>
                  </span>
                  {item.status === "published" ? <Check size={16} aria-hidden="true" /> : null}
                </article>
              ))}
            </div>
          </Block>
        ) : data.next !== null ? (
          <Block title="下一步" id="next">
            <div className="today-list">
              <article className="today-row today-scheduled">
                <CalendarClock size={18} aria-hidden="true" />
                <span className="today-row-main">
                  <span className="today-kicker">
                    {data.next.kind === "draft" ? PLATFORM[data.next.draft.platform] : "例行"}
                  </span>
                  <strong>{data.next.kind === "draft" ? draftText(data.next.draft) : data.next.title}</strong>
                  <small>{timeText(data.next.at)}</small>
                </span>
              </article>
            </div>
          </Block>
        ) : null}
        <Block title="成果" id="achievements">
          {data.achievements.length === 0 ? (
            <p className="today-empty">还没有发出去的成果</p>
          ) : (
            <div className="today-list">
              {data.achievements.map((item) =>
                item.kind === "review" ? (
                  <details className="project-review" data-testid="project-review" key={item.id}>
                    <summary className="today-row today-result">
                      <NotebookText size={18} aria-hidden="true" />
                      <span className="today-row-main">
                        <span className="today-kicker">周复盘</span>
                        <strong>{item.title}</strong>
                        <small>{timeText(item.at)}</small>
                      </span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </summary>
                    <div className="project-review-body" data-testid="project-review-body">
                      <Markdown text={item.body} />
                    </div>
                  </details>
                ) : (
                  <a
                    className="today-row today-result"
                    data-testid="project-achievement"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    key={item.id}
                  >
                    <Check size={18} aria-hidden="true" />
                    <span className="today-row-main">
                      <span className="today-kicker">{PLATFORM[item.platform]} · 已发布</span>
                      <strong>{item.title}</strong>
                      <small>{timeText(item.at)}</small>
                    </span>
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                ),
              )}
            </div>
          )}
        </Block>
        <details className="project-fold" data-testid="project-fold">
          <summary>
            <Users size={16} aria-hidden="true" />
            队伍 {members.length} · 例行 {data.routines.length}
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <div className="today-list">
            {members.map((bot) => (
              <article className="today-row" key={bot.id}>
                <BotAvatar shape={bot.shape} hue={bot.hue} size="sm" />
                <span className="today-row-main">
                  <strong>{bot.name}</strong>
                  <small>{bot.tags.length === 0 ? "队员" : bot.tags.join("、")}</small>
                </span>
              </article>
            ))}
            {data.routines.map((routine) => (
              <article className="today-row" key={routine.routineId}>
                <History size={18} aria-hidden="true" />
                <span className="today-row-main">
                  <span className="today-kicker">例行 · {lookup(routine.botId).name}</span>
                  <strong>{routine.name}</strong>
                  <small>
                    <RoutineStateChip state={routine.state} />
                    {routine.state !== "on"
                      ? null
                      : routine.nextAt === null
                        ? " 没有排下次"
                        : ` 下次 ${timeText(routine.nextAt)}`}
                  </small>
                </span>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="ghost-button project-adjust-team"
            data-testid="project-adjust-team"
            onClick={adjustTeam}
          >
            <UserPlus size={14} aria-hidden="true" />
            调整队伍
          </button>
        </details>
      </div>
    </main>
  );
};
