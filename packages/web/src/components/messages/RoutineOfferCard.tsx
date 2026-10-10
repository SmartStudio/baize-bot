import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Repeat, ShieldCheck } from "lucide-react";
import type { Message, RoutineBoundary } from "@baize/shared";
import { useApp } from "../../state/app.js";
import { shelfRow } from "../../state/stamped.js";
import { describeCron } from "../routines/cron.js";
import { assistantGroupOf, editPrefill, prefillState } from "../routines/prefill.js";
import { pathOf } from "../../routes/screen.js";

const BOUNDARY_TEXT: Record<RoutineBoundary, string> = {
  read_only: "只读，不发东西",
  draft: "可以起草，发之前等你批",
};

// 卡的状态只跟着消息走：点加上后等接口回来、消息换成 added 才收起，这里不先改样子。
// 首页递进来的是今天快照里那份，消息架上有更新的就认更新的，结完不用等快照重拉就收起。
export const RoutineOfferCard = ({ message }: { message: Message }) => {
  const { state, actions } = useApp();
  const navigate = useNavigate();
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // 同一个事件循环里连点两下时 sent 还没来得及渲染成 disabled，靠这个同步的闩挡住第二下。
  const latch = useRef(false);

  const ready = state.status === "ready" ? state : null;
  const shelved = ready === null ? undefined : shelfRow(ready.messages, message.groupId, message.id);
  const { body } = shelved !== undefined && shelved.revision > message.revision ? shelved : message;
  if (body.kind !== "routine_offer") return null;

  if (body.status === "added") {
    return (
      <div className="card routine-offer is-folded" data-testid="routine-offer" data-status={body.status}>
        <span className="badge badge-accepted">已加上</span>
        <span>例行「{body.name}」到点自己跑，在例行页能停能改</span>
      </div>
    );
  }
  if (body.status === "dismissed") {
    return (
      <div className="card routine-offer is-folded is-muted" data-testid="routine-offer" data-status={body.status}>
        例行「{body.name}」没有加
      </div>
    );
  }

  const project = ready?.conversations.find((c) => c.kind === "team" && c.groupId === body.groupId);
  const executor = ready?.bots[body.executorBotId];
  const assistantGroupId = ready === null ? null : assistantGroupOf(ready.conversations, ready.bots);

  const decide = (decision: "add" | "dismiss") => {
    if (latch.current) return;
    latch.current = true;
    setSent(true);
    setFailure(null);
    void actions
      .decideRoutineOffer(message.id, decision)
      .catch((cause: unknown) =>
        setFailure(
          `${decision === "add" ? "没加上" : "没撤下"}：${cause instanceof Error ? cause.message : "请求失败"}`,
        ),
      )
      .finally(() => {
        latch.current = false;
        setSent(false);
      });
  };
  const revise = () => {
    if (assistantGroupId !== null)
      navigate(pathOf({ kind: "group", groupId: assistantGroupId }), { state: prefillState(editPrefill(body.name)) });
  };

  return (
    <div className="card routine-offer" data-testid="routine-offer" data-status={body.status}>
      <div className="card-title">
        <Repeat size={16} aria-hidden="true" />
        加一条例行 · {body.name}
      </div>
      <p className="offer-hint">主助理看你常这么做，问要不要让它到点自己跑</p>
      <dl className="offer-kv">
        <dt>什么时候</dt>
        <dd data-testid="routine-offer-when">{describeCron(body.cron)}</dd>
        <dt>做什么</dt>
        <dd data-testid="routine-offer-what">{body.instruction}</dd>
        <dt>放在哪</dt>
        <dd data-testid="routine-offer-where">
          {body.groupId === null
            ? "日常，不挂项目"
            : `${project?.kind === "team" ? project.task.title : "项目"}，跟着项目走`}
        </dd>
        <dt>谁来跑</dt>
        <dd data-testid="routine-offer-executor">{executor?.name ?? "Bot"}</dd>
        <dt>边界</dt>
        <dd data-testid="routine-offer-boundary">{BOUNDARY_TEXT[body.boundary]}</dd>
        <dt>跑失败了</dt>
        <dd>停下告诉你</dd>
      </dl>
      {failure === null ? null : (
        <p className="routine-offer-error" role="alert" data-testid="routine-offer-error">
          {failure}
        </p>
      )}
      <div className="approval-actions">
        <span className="offer-note">
          <ShieldCheck size={14} aria-hidden="true" />
          例行不另开权限，连续 3 次没人看就自己停。
        </span>
        <button
          type="button"
          className="ghost-button"
          data-testid="routine-offer-dismiss"
          disabled={sent}
          onClick={() => decide("dismiss")}
        >
          不要
        </button>
        <button
          type="button"
          className="ghost-button"
          data-testid="routine-offer-revise"
          disabled={sent || assistantGroupId === null}
          onClick={revise}
        >
          改一下
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="routine-offer-add"
          disabled={sent}
          onClick={() => decide("add")}
        >
          <Plus size={14} aria-hidden="true" />
          加上
        </button>
      </div>
    </div>
  );
};
