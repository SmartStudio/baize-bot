import { useRef, useState } from "react";
import { Check, UserPlus } from "lucide-react";
import type { Bot, BotId, GroupId, MessageBody, MessageId, TeamOfferMember } from "@baize/shared";
import { RequestFailed } from "../../api/client.js";
import { useApp } from "../../state/app.js";

type Body = Extract<MessageBody, { kind: "team_offer" }>;

const PROJECT_FALLBACK = "这个项目";

/** 要加人的那个项目叫什么。侧栏里没有这个群时（刚被删、还没推过来）退回一个泛称。 */
export const useOfferProject = (groupId: GroupId): string => {
  const { state } = useApp();
  if (state.status !== "ready") return PROJECT_FALLBACK;
  const conversation = state.conversations.find((item) => item.groupId === groupId);
  return conversation?.kind === "team" ? conversation.task.title : PROJECT_FALLBACK;
};

const whoIs = (member: TeamOfferMember, bots: Partial<Record<BotId, Bot>>): { name: string; detail: string } => {
  if (member.kind === "new") return { name: member.name, detail: member.description };
  const bot = bots[member.botId];
  return { name: bot?.name ?? "队员", detail: bot?.tags.join("、") ?? "" };
};

// 一次提交走到哪。seen 是提交时卡上的状态：首页、项目页的卡读清单快照，快照可能旧、可能拉不下来。
// 回包到了就用回包里的状态，直到卡上的状态变了，说明更新的快照或同 id 的消息到了，再听它的。
type Submission =
  { phase: "sending"; seen: Body["status"] } | { phase: "settled"; seen: Body["status"]; status: Body["status"] };

const shown = (submission: Submission | null, status: Body["status"]): Body["status"] =>
  submission?.phase === "settled" && submission.seen === status ? submission.status : status;

// 状态跟着消息走。建议人选默认不勾、点「加上」才算；主助理直接提的人默认勾上，也能取消，人被删了要靠这个改勾。
export const TeamOfferCard = ({ body, messageId }: { body: Body; messageId: MessageId }) => {
  const { state, actions } = useApp();
  const project = useOfferProject(body.groupId);
  const bots = state.status === "ready" ? state.bots : {};
  const [picked, setPicked] = useState<ReadonlySet<number>>(
    () => new Set(body.members.flatMap((member, at) => (member.suggested ? [] : [at]))),
  );
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 同一个事件循环里连点两下时 submission 还没渲染成 disabled，靠这份同步的副本挡住第二下。
  const latch = useRef<Submission | null>(null);
  const submit = (next: Submission | null) => {
    latch.current = next;
    setSubmission(next);
  };
  const status =
    (state.status === "ready" ? state.offerOutcomes[messageId] : undefined) ?? shown(submission, body.status);
  const inFlight = state.status === "ready" && state.offersInFlight[messageId] === true;
  const locked = inFlight || submission?.phase === "sending";

  if (status === "confirmed") {
    return (
      <div className="card team-offer is-folded" data-testid="team-offer" data-status={status}>
        <Check size={16} aria-hidden="true" />
        <span>「{project}」的队伍已经组好</span>
      </div>
    );
  }
  if (status === "dismissed") {
    return (
      <div className="card team-offer is-folded is-muted" data-testid="team-offer" data-status={status}>
        「{project}」没有加人
      </div>
    );
  }

  const toggle = (at: number, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(at);
      else next.delete(at);
      return next;
    });

  const decide = (which: "confirm" | "defer") => {
    const before = latch.current;
    if (inFlight || before?.phase === "sending") return;
    const from = shown(before, body.status);
    if (from === "confirmed" || from === "dismissed") return;
    const seen = body.status;
    submit({ phase: "sending", seen });
    setError(null);
    const request =
      which === "confirm"
        ? ({ decision: "confirm", picked: [...picked].toSorted((left, right) => left - right) } as const)
        : ({ decision: "defer" } as const);
    void actions.decideTeamOffer(messageId, request).then(
      (message) =>
        submit(message?.body.kind === "team_offer" ? { phase: "settled", seen, status: message.body.status } : before),
      (cause: unknown) => {
        setError(cause instanceof RequestFailed ? cause.message : "没能提交，请重试");
        submit(before);
      },
    );
  };

  return (
    <div className="card team-offer" data-testid="team-offer" data-status={status}>
      <div className="card-title">
        <UserPlus size={16} aria-hidden="true" />
        给「{project}」拉人
      </div>
      <p className="offer-hint">
        {status === "deferred" ? "先放着了，想好了随时点确认" : "勾上的人会加进这个项目，不勾的不会动"}
      </p>
      <ul className="team-offer-list">
        {body.members.map((member, at) => {
          const { name, detail } = whoIs(member, bots);
          const on = picked.has(at);
          return (
            <li key={`${at}-${name}`} className="team-offer-member" data-testid="team-offer-member" data-picked={on}>
              <div className="team-offer-who">
                <b>{name}</b>
                {member.kind === "new" ? (
                  <span className="tag" data-testid="team-offer-new">
                    新
                  </span>
                ) : null}
                {detail === "" ? null : <span className="team-offer-detail">{detail}</span>}
              </div>
              <p className="team-offer-note">{member.note}</p>
              <div className="team-offer-pick">
                {on ? (
                  <span className="team-offer-in">
                    <Check size={14} aria-hidden="true" />
                    {member.suggested ? "已加上" : "在队里"}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ghost-button"
                  data-testid="team-offer-toggle"
                  disabled={locked}
                  onClick={() => toggle(at, !on)}
                >
                  {on ? "不加了" : "加上"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error === null ? null : (
        <p className="team-offer-error" role="alert">
          {error}
        </p>
      )}
      <div className="approval-actions">
        {status === "offered" ? (
          <button
            type="button"
            className="ghost-button"
            data-testid="team-offer-defer"
            disabled={locked}
            onClick={() => decide("defer")}
          >
            先放着
          </button>
        ) : null}
        <button
          type="button"
          className="primary-button"
          data-testid="team-offer-confirm"
          disabled={locked || picked.size === 0}
          onClick={() => decide("confirm")}
        >
          确认组队（{picked.size} 个）
        </button>
      </div>
    </div>
  );
};

// 团队名单补拉连着失败、停下来之后的提示。成员可能落后于服务端，点重试再拉一趟。
export const GroupsStale = () => {
  const { state, actions } = useApp();
  if (state.status !== "ready" || state.loads.groups !== "failed") return null;
  return (
    <p className="team-offer-error" data-testid="groups-stale" role="alert">
      项目名单没刷新，队伍里的人可能不是最新的
      <button type="button" className="ghost-button" onClick={() => void actions.loadGroups()}>
        重试
      </button>
    </p>
  );
};
