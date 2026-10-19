import { useState, type FormEvent } from "react";
import { Pin, Target } from "lucide-react";
import { ProjectGoal, type Bot, type BotId, type ChecklistItem, type TopicTask } from "@baize/shared";
import { TaskRefreshFailed, useApp } from "../state/app.js";
import { goalProgressOf, goalText } from "../state/project.js";
import { BotAvatar } from "./BotAvatar.js";

// 原型 05 的卡上写的是「截止 09-14 12:00」，月日加时分，不带年。
export const dueTextOf = (dueAt: string): string => {
  const at = new Date(dueAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
};

const two = (n: number) => String(n).padStart(2, "0");

// datetime-local 只认本地时间的 YYYY-MM-DDTHH:mm，存回去的是 ISO。
const localInputOf = (iso: string): string => {
  const at = new Date(iso);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
};

// 本地分钟串存不下秒、毫秒和夏令时回拨时的偏移，截止没动过就原样存回服务端给的那份。
type DueDraft = { kind: "kept"; dueAt: string | null } | { kind: "edited"; input: string };
type GoalDraft = { target: string; unit: string; due: DueDraft };

const draftOf = (goal: ProjectGoal | null): GoalDraft => ({
  target: goal === null ? "" : String(goal.target),
  unit: goal?.unit ?? "",
  due: { kind: "kept", dueAt: goal?.dueAt ?? null },
});

const dueInputOf = (due: DueDraft): string =>
  due.kind === "edited" ? due.input : due.dueAt === null ? "" : localInputOf(due.dueAt);

const dueAtOf = (due: DueDraft): { dueAt: string | null } | { error: string } => {
  if (due.kind === "kept") return { dueAt: due.dueAt };
  if (due.input === "") return { dueAt: null };
  const at = new Date(due.input);
  return Number.isNaN(at.getTime()) ? { error: "截止时间看不懂" } : { dueAt: at.toISOString() };
};

const parseGoal = (draft: GoalDraft): { goal: ProjectGoal } | { error: string } => {
  const due = dueAtOf(draft.due);
  if ("error" in due) return due;
  const parsed = ProjectGoal.safeParse({
    target: Number(draft.target),
    unit: draft.unit.trim(),
    dueAt: due.dueAt,
  });
  if (parsed.success) return { goal: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  return { error: field === "unit" ? "单位写 1 到 8 个字" : "目标数得是正整数" };
};

// 保存中整张表单和卡头的目标按钮都锁住：存的是点下那一刻的草稿，之后再改会被收起表单静悄悄丢掉。
type GoalEditing = "closed" | "editing" | "saving";

// 写入成功但补读没回来时卡上可能还是旧值，提示留在卡上，等用户点重新读取。saved 记的是哪一样存上了。
type Saved = "目标" | "清单";
type Refresh = { status: "fresh" } | { status: "failed" | "reading"; saved: Saved };

type GoalEditorProps = {
  task: TopicTask;
  saving: boolean;
  onEditing: (editing: GoalEditing) => void;
  onRefreshFailed: (saved: Saved) => void;
};

const GoalEditor = ({ task, saving, onEditing, onRefreshFailed }: GoalEditorProps) => {
  const { actions } = useApp();
  const [draft, setDraft] = useState(() => draftOf(task.goal));
  const [error, setError] = useState<string | null>(null);
  const save = async (goal: ProjectGoal | null) => {
    onEditing("saving");
    setError(null);
    try {
      await actions.setTaskGoal(task, goal);
      onEditing("closed");
    } catch (cause) {
      if (cause instanceof TaskRefreshFailed) {
        onRefreshFailed("目标");
        onEditing("closed");
        return;
      }
      setError("没存上，再试一次");
      onEditing("editing");
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseGoal(draft);
    if ("error" in parsed) setError(parsed.error);
    else void save(parsed.goal);
  };

  return (
    <form className="task-goal-form" data-testid="task-goal-form" onSubmit={submit} noValidate>
      <label className="field">
        <span>目标数</span>
        <input
          data-testid="task-goal-target"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          disabled={saving}
          value={draft.target}
          onChange={(event) => setDraft({ ...draft, target: event.target.value })}
        />
      </label>
      <label className="field">
        <span>单位</span>
        <input
          data-testid="task-goal-unit"
          maxLength={8}
          disabled={saving}
          value={draft.unit}
          onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
        />
      </label>
      <label className="field">
        <span>截止</span>
        <input
          data-testid="task-goal-due"
          type="datetime-local"
          disabled={saving}
          value={dueInputOf(draft.due)}
          onChange={(event) => setDraft({ ...draft, due: { kind: "edited", input: event.target.value } })}
        />
      </label>
      <span className="task-goal-actions">
        <button type="submit" className="primary-button" data-testid="task-goal-save" disabled={saving}>
          存目标
        </button>
        {task.goal === null ? null : (
          <button
            type="button"
            className="ghost-button"
            data-testid="task-goal-clear"
            disabled={saving}
            onClick={() => void save(null)}
          >
            去掉目标
          </button>
        )}
        <button type="button" className="ghost-button" disabled={saving} onClick={() => onEditing("closed")}>
          取消
        </button>
      </span>
      {error === null ? null : (
        <p className="task-goal-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

type Props = {
  task: TopicTask;
  memberIds: BotId[];
  bots: Record<BotId, Bot>;
  onToggle: (checklist: ChecklistItem[]) => Promise<void>;
  onOpenDetail: () => void;
};

export const TaskCard = ({ task, memberIds, bots, onToggle, onOpenDetail }: Props) => {
  const done = task.checklist.filter((item) => item.done).length;
  const current = task.currentBotId === null ? null : (bots[task.currentBotId]?.name ?? "Bot");
  const { actions } = useApp();
  const [goalEditing, setGoalEditing] = useState<GoalEditing>("closed");
  const [refresh, setRefresh] = useState<Refresh>({ status: "fresh" });
  const [checklistError, setChecklistError] = useState(false);
  const reread = async (saved: Saved) => {
    setRefresh({ status: "reading", saved });
    try {
      await actions.reloadTask(task.id);
      setRefresh({ status: "fresh" });
    } catch {
      setRefresh({ status: "failed", saved });
    }
  };
  const goal = goalProgressOf(task.goal, task.metric, new Date());
  const toggle = async (at: number) => {
    setChecklistError(false);
    try {
      await onToggle(task.checklist.map((item, i) => (i === at ? { ...item, done: !item.done } : item)));
    } catch (cause) {
      if (cause instanceof TaskRefreshFailed) setRefresh({ status: "failed", saved: "清单" });
      else setChecklistError(true);
    }
  };

  return (
    <section className="task-card" data-testid="task-card">
      <header className="task-card-top">
        <Pin size={14} aria-hidden="true" />
        <b className="task-title">{task.title}</b>
        <span className="task-meta" data-testid="task-progress">
          清单 {done} / {task.checklist.length}
        </span>
        {task.dueAt === null ? null : <span className="task-meta">截止 {dueTextOf(task.dueAt)}</span>}
        <button
          type="button"
          className="task-goal"
          data-testid="task-goal"
          aria-expanded={goalEditing !== "closed"}
          disabled={goalEditing === "saving"}
          onClick={() => setGoalEditing(goalEditing === "closed" ? "editing" : "closed")}
        >
          <Target size={12} aria-hidden="true" />
          {goal === null ? "定目标" : `目标 ${goalText(goal)}`}
        </button>
        <span className="task-meta" data-testid="task-current">
          当前 {current ?? "还没人接手"}
        </span>
        <span className="task-card-right">
          <span className="task-members" aria-hidden="true">
            {memberIds.map((botId) => {
              const bot = bots[botId];
              return bot === undefined ? null : <BotAvatar key={botId} shape={bot.shape} hue={bot.hue} size="xs" />;
            })}
          </span>
          <button type="button" className="ghost-button" data-testid="task-open" onClick={onOpenDetail}>
            任务详情
          </button>
        </span>
      </header>
      {goalEditing === "closed" ? null : (
        <GoalEditor
          task={task}
          saving={goalEditing === "saving"}
          onEditing={setGoalEditing}
          onRefreshFailed={(saved) => setRefresh({ status: "failed", saved })}
        />
      )}
      {refresh.status === "fresh" ? null : (
        <p className="task-goal-error" role="alert" data-testid="task-refresh-failed">
          {refresh.saved}已存上，刷新没成功，卡上可能还是旧值。
          <button
            type="button"
            className="ghost-button"
            disabled={refresh.status === "reading"}
            onClick={() => void reread(refresh.saved)}
          >
            重新读取
          </button>
        </p>
      )}
      {task.checklist.length === 0 ? (
        <p className="task-empty">Bot 接手后自己列。</p>
      ) : (
        <ul className="task-checklist" data-testid="task-checklist">
          {task.checklist.map((item, at) => (
            <li key={item.text}>
              <label className="task-check">
                <input
                  type="checkbox"
                  data-testid="checklist-item"
                  data-done={item.done}
                  checked={item.done}
                  onChange={() => void toggle(at)}
                />
                <span className={item.done ? "is-done" : ""}>{item.text}</span>
                {item.ownerBotId === null ? null : <em className="tag">{bots[item.ownerBotId]?.name ?? "Bot"}</em>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {checklistError ? (
        <p className="task-goal-error" role="alert">
          清单没存上，再勾一次
        </p>
      ) : null}
    </section>
  );
};
