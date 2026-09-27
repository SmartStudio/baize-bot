import { useEffect, useState } from "react";
import { ChevronLeft, Clock, Copy, Globe, Play, Plus, ShieldCheck, X } from "lucide-react";
import { OnFailure, type Bot, type BotId, type Routine, type RoutineId, type TriggerInput } from "@baize/shared";
import { BotAvatar } from "../components/BotAvatar.js";
import { useApp } from "../state/app.js";
import { MY_ROUTINES } from "../state/routines.js";
import { CRON_PRESETS, DEFAULT_TIME, cronExprOf, cronPresetOf, describeTriggers } from "../components/routines/cron.js";

type RoutineRun = Routine["runs"][number];

// 列表、还没存下来的草稿、正在编的某一条，三选一。写成联合是为了让「编着一条还没有 id 的例行任务」拼不出来。
type View = { kind: "list" } | { kind: "draft" } | { kind: "editing"; routineId: RoutineId };

// 编辑器认的那一份。存下来的那条从 Routine 里取这四个字段，草稿自己攒着，两边共用同一个表单。
type Form = {
  name: string;
  instruction: string;
  triggers: TriggerInput[];
  onFailure: Routine["onFailure"];
};

const EMPTY_FORM: Form = { name: "", instruction: "", triggers: [], onFailure: "stop_and_tell" };

const formOf = (routine: Routine): Form => ({
  name: routine.name,
  instruction: routine.instruction,
  triggers: routine.triggers,
  onFailure: routine.onFailure,
});

const pad = (value: number) => String(value).padStart(2, "0");

const stampOf = (iso: string, now: Date): string => {
  const at = new Date(iso);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString()
    ? `今天 ${clock}`
    : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
};

const RUN_STATUS_TEXT: Record<RoutineRun["status"], string> = {
  running: "运行中",
  ok: "完成",
  failed: "失败",
  stopped: "停下等你",
};

const runText = (run: RoutineRun): string => {
  const status = RUN_STATUS_TEXT[run.status];
  if ((run.status === "stopped" || run.status === "failed") && run.note.length > 0) return run.note;
  return run.note.length === 0 ? status : `${status} · ${run.note}`;
};

const hookUrlOf = (token: string) => `${window.location.origin}/api/hooks/${token}`;

const TriggerChip = ({
  trigger,
  onChange,
  onRemove,
}: {
  trigger: TriggerInput;
  onChange: (next: TriggerInput) => void;
  onRemove: () => void;
}) => {
  const preset = trigger.kind === "cron" ? cronPresetOf(trigger.expr) : null;
  const label = CRON_PRESETS.find((item) => item.id === preset?.id)?.label;
  return (
    <span className="trigger-chip" data-testid="trigger-chip">
      {trigger.kind === "cron" ? <Clock size={14} aria-hidden="true" /> : <Globe size={14} aria-hidden="true" />}
      {trigger.kind === "cron" ? (
        label === undefined ? (
          <code>{trigger.expr}</code>
        ) : (
          <>
            <span>{label}</span>
            {preset?.time != null ? (
              <input
                type="time"
                className="trigger-time"
                data-testid="trigger-time"
                aria-label={`${label}几点跑`}
                // 时刻是按段敲出来的，每敲一段都发一条整包 PATCH 的话，先发的后到就把时刻盖回去了。
                // 失焦再发一次，key 让存回来的那条重新给上初值。
                key={trigger.expr}
                defaultValue={preset.time}
                onBlur={(e) =>
                  e.target.value !== "" &&
                  e.target.value !== preset.time &&
                  onChange({ kind: "cron", expr: cronExprOf(preset.id, e.target.value) })
                }
              />
            ) : null}
          </>
        )
      ) : trigger.token === undefined ? (
        <span>Webhook · 存下来才发地址</span>
      ) : (
        <>
          <code data-testid="webhook-url">{hookUrlOf(trigger.token)}</code>
          <button
            type="button"
            className="icon-button"
            aria-label="复制 webhook 地址"
            data-testid="webhook-copy"
            onClick={() => void navigator.clipboard.writeText(hookUrlOf(trigger.token ?? "")).catch(() => undefined)}
          >
            <Copy size={12} aria-hidden="true" />
          </button>
        </>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label="删掉这个触发器"
        data-testid="trigger-remove"
        onClick={onRemove}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </span>
  );
};

const RoutineFields = ({ value, onPatch }: { value: Form; onPatch: (patch: Partial<Form>) => void }) => {
  const [name, setName] = useState(value.name);
  const [instruction, setInstruction] = useState(value.instruction);
  const [adding, setAdding] = useState(false);

  // 两个字段各看各的：名称改完一失焦就存，存回来的那条要是把两个 state 一起重置，正在写的「每次运行做什么」就没了。
  useEffect(() => setName(value.name), [value.name]);
  useEffect(() => setInstruction(value.instruction), [value.instruction]);

  const appended = (trigger: TriggerInput) => {
    setAdding(false);
    onPatch({ triggers: [...value.triggers, trigger] });
  };

  return (
    <>
      <label className="field">
        <span>名称</span>
        <input
          data-testid="routine-name-input"
          value={name}
          placeholder="每日工单早报"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== value.name && onPatch({ name })}
        />
      </label>
      <label className="field">
        <span>每次运行做什么</span>
        <textarea
          data-testid="routine-instruction-input"
          rows={5}
          value={instruction}
          placeholder="写清楚做什么、做到什么程度、什么情况要停下来等你"
          onChange={(e) => setInstruction(e.target.value)}
          onBlur={() => instruction !== value.instruction && onPatch({ instruction })}
        />
      </label>
      <div className="field">
        <span>何时运行</span>
        <div className="trigger-box">
          {value.triggers.map((trigger, at) => (
            <TriggerChip
              key={`${trigger.kind}-${at}`}
              trigger={trigger}
              onChange={(next) => onPatch({ triggers: value.triggers.map((t, i) => (i === at ? next : t)) })}
              onRemove={() => onPatch({ triggers: value.triggers.filter((_, i) => i !== at) })}
            />
          ))}
          <button type="button" className="trigger-add" data-testid="trigger-add" onClick={() => setAdding(!adding)}>
            <Plus size={14} aria-hidden="true" />
            添加触发器
          </button>
          {adding ? (
            <div className="trigger-menu" data-testid="trigger-menu">
              {CRON_PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`trigger-preset-${item.id}`}
                  onClick={() => appended({ kind: "cron", expr: cronExprOf(item.id, DEFAULT_TIME) })}
                >
                  <Clock size={16} aria-hidden="true" />
                  <span>{item.timed ? `${item.label} ${DEFAULT_TIME}` : item.label}</span>
                </button>
              ))}
              <button type="button" data-testid="trigger-preset-webhook" onClick={() => appended({ kind: "webhook" })}>
                <Globe size={16} aria-hidden="true" />
                <span>Webhook</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="field">
        <span>失败时</span>
        <div className="row-card">
          <small>比如工单系统登录过期</small>
          <select
            data-testid="routine-onfailure"
            aria-label="失败时"
            value={value.onFailure}
            onChange={(e) => onPatch({ onFailure: OnFailure.parse(e.target.value) })}
          >
            <option value="stop_and_tell">停下告诉我</option>
            <option value="retry_next_time">下次再试</option>
          </select>
        </div>
      </div>
    </>
  );
};

const Crumb = ({ count, current, onBack }: { count: number; current: string; onBack: () => void }) => (
  <div className="routine-crumb">
    <button
      type="button"
      className="icon-button"
      aria-label="返回例行任务列表"
      data-testid="routine-back"
      onClick={onBack}
    >
      <ChevronLeft size={16} aria-hidden="true" />
    </button>
    <button type="button" className="link-button" onClick={onBack}>
      全部例行任务 · {count}
    </button>
    <span>/</span>
    <b>{current}</b>
  </div>
);

const RunList = ({ runs }: { runs: RoutineRun[] }) => {
  const now = new Date();
  return (
    <div className="field">
      <span>运行记录</span>
      {runs.length === 0 ? (
        <p className="routines-empty">还没跑过</p>
      ) : (
        <ul className="run-list">
          {runs.map((run, at) => (
            <li key={`${run.startedAt}-${at}`} className="run-row" data-testid="run-row" data-status={run.status}>
              <i className="run-dot" aria-hidden="true" />
              <span>{stampOf(run.startedAt, now)}</span>
              <small>{runText(run)}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const Lockbox = () => (
  <div className="lockbox">
    <ShieldCheck size={16} aria-hidden="true" />
    <p>
      <b>例行不另开权限。</b>它跑的时候和平时一样过闸，发东西照样先问你。电脑关着的那次不补跑，等下一次。
    </p>
  </div>
);

const RoutineRow = ({ routine, bot, onOpen }: { routine: Routine; bot: Bot; onOpen: () => void }) => {
  const { actions } = useApp();
  const last = routine.runs[0];
  return (
    <div className="routine-row" data-testid="routine-row" data-routine-name={routine.name} data-bot-name={bot.name}>
      <span className="when-col" data-testid="routine-row-note">
        {routine.enabled ? describeTriggers(routine.triggers) : "已停用"}
      </span>
      <div className="routine-row-body">
        <button type="button" className="routine-open" data-testid="routine-open" onClick={onOpen}>
          <b>{routine.name}</b>
        </button>
        <span className="routine-row-meta">
          <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
          <span data-testid="routine-bot">{bot.name}</span>
        </span>
        <span className="routine-row-meta">
          {last === undefined ? null : (
            <span data-testid="routine-last">
              {stampOf(last.startedAt, new Date())} {runText(last)}
            </span>
          )}
          <span data-testid="routine-run-count">
            {routine.runs.length === 0 ? "还没跑过" : `跑过 ${routine.runs.length} 次`}
          </span>
        </span>
      </div>
      <div className="routine-row-actions">
        <button
          type="button"
          className="ghost-button"
          data-testid="routine-run"
          onClick={() => void actions.runRoutine(routine.id)}
        >
          <Play size={14} aria-hidden="true" />
          试跑
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={routine.enabled}
          aria-label={`启用 ${routine.name}`}
          className={`switch${routine.enabled ? " is-on" : ""}`}
          data-testid="routine-switch"
          onClick={() => void actions.updateRoutine(routine.id, { enabled: !routine.enabled })}
        />
      </div>
    </div>
  );
};

export const RoutinesPage = () => {
  const { state, actions } = useApp();
  const [view, setView] = useState<View>({ kind: "list" });
  const [draft, setDraft] = useState<Form>(EMPTY_FORM);
  const [draftBotId, setDraftBotId] = useState<BotId | null>(null);
  const [deleteRoutineId, setDeleteRoutineId] = useState<RoutineId | null>(null);

  const ready = state.status === "ready" ? state : null;
  const bots = ready === null ? [] : Object.values(ready.bots);
  const loaded = ready?.routines.rows[MY_ROUTINES];
  const load = ready?.loads.routines ?? "idle";

  // 在途的和拉失败的都不再自动要：前者等它回来，后者等用户点重试，免得 500 时每次重渲都打一遍。
  useEffect(() => {
    if (ready !== null && loaded === undefined && load === "idle") void actions.loadRoutines();
  });

  useEffect(() => {
    if (deleteRoutineId === null) return;
    const timeout = window.setTimeout(() => setDeleteRoutineId(null), 3_000);
    return () => window.clearTimeout(timeout);
  }, [deleteRoutineId]);

  if (ready === null) return null;

  // 例行跟着 Bot 走，Bot 删了例行也删；推送先后没对上的那一小会儿，找不到 Bot 的先不显示。
  const rows = (loaded ?? []).flatMap((routine) => {
    const bot = ready.bots[routine.botId];
    return bot === undefined ? [] : [{ routine, bot }];
  });
  const toList = () => {
    setDeleteRoutineId(null);
    setView({ kind: "list" });
  };

  if (view.kind === "draft") {
    const botId = draftBotId ?? bots[0]?.id ?? null;
    const saveable = botId !== null && draft.name.trim().length > 0 && draft.instruction.trim().length > 0;
    return (
      <main className="page routines-page" data-testid="routines-page">
        <div className="routines" data-testid="routine-editor">
          <Crumb count={rows.length} current="新的例行" onBack={toList} />
          <label className="field">
            <span>交给谁</span>
            <select
              data-testid="routine-bot-select"
              value={botId ?? ""}
              onChange={(e) => setDraftBotId(bots.find((bot) => bot.id === e.target.value)?.id ?? null)}
            >
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <RoutineFields value={draft} onPatch={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
          <div className="routine-actions">
            <button
              type="button"
              className="ghost-button"
              data-testid="routine-cancel"
              onClick={() => {
                setDraft(EMPTY_FORM);
                toList();
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              data-testid="routine-save"
              disabled={!saveable}
              // 没存成就留在编辑器里。先清草稿再退回列表的话，刚写完的一整条就没了，界面上还看着像建成了。
              onClick={() => {
                if (botId === null) return;
                void actions
                  .createRoutine(botId, { ...draft, enabled: true })
                  .then(() => {
                    setDraft(EMPTY_FORM);
                    toList();
                  })
                  .catch(() => undefined);
              }}
            >
              建好了
            </button>
          </div>
        </div>
      </main>
    );
  }

  // 正编着的这条被别的窗口删了，推送一到就查不着。退回列表，比留一个空壳编辑器强。
  const editing = view.kind === "editing" ? (rows.find((row) => row.routine.id === view.routineId) ?? null) : null;

  if (editing !== null) {
    const { routine } = editing;
    return (
      <main className="page routines-page" data-testid="routines-page">
        <div className="routines" data-testid="routine-editor">
          <Crumb count={rows.length} current={routine.name} onBack={toList} />
          <div className="routine-actions">
            <button
              type="button"
              role="switch"
              aria-checked={routine.enabled}
              aria-label="启用"
              className={`switch${routine.enabled ? " is-on" : ""}`}
              data-testid="routine-enabled-switch"
              onClick={() => void actions.updateRoutine(routine.id, { enabled: !routine.enabled })}
            />
            <b>{routine.enabled ? "已启用" : "已停用"}</b>
            <span className="routine-row-meta">
              <BotAvatar name={editing.bot.name} hue={editing.bot.hue} size="xs" />
              {editing.bot.name}
            </span>
            <span className="routine-actions-gap" />
            {deleteRoutineId === routine.id ? (
              <>
                <button
                  type="button"
                  className="ghost-button routine-delete-confirm"
                  data-testid="routine-delete-confirm"
                  onClick={() => {
                    setDeleteRoutineId(null);
                    void actions
                      .deleteRoutine(routine.id)
                      .then(toList)
                      .catch(() => undefined);
                  }}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  data-testid="routine-delete-cancel"
                  onClick={() => setDeleteRoutineId(null)}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ghost-button"
                data-testid="routine-delete"
                onClick={() => setDeleteRoutineId(routine.id)}
              >
                删除
              </button>
            )}
            <button
              type="button"
              className="ghost-button"
              data-testid="routine-run-now"
              onClick={() => void actions.runRoutine(routine.id)}
            >
              <Play size={14} aria-hidden="true" />
              试跑一次
            </button>
          </div>
          <RoutineFields value={formOf(routine)} onPatch={(patch) => void actions.updateRoutine(routine.id, patch)} />
          <RunList runs={routine.runs} />
        </div>
      </main>
    );
  }

  return (
    <main className="page routines-page" data-testid="routines-page">
      <header className="page-head">
        <div>
          <h2>例行</h2>
          <p>到点自己跑的活。走通一次的活存下来，让它定时自己跑。</p>
        </div>
        <button
          type="button"
          className="ghost-button"
          data-testid="routine-new"
          onClick={() => setView({ kind: "draft" })}
        >
          <Plus size={14} aria-hidden="true" />
          新建例行
        </button>
      </header>
      <section className="blk" data-testid="routine-list">
        <div className="blk-h">
          <h3>日常</h3>
          <span>只属于你，不挂项目</span>
        </div>
        {loaded === undefined && load === "failed" ? (
          <p className="routines-empty" role="alert" data-testid="routines-failed">
            例行没拉下来。{" "}
            <button
              type="button"
              className="ghost-button"
              data-testid="routines-retry"
              onClick={() => void actions.loadRoutines()}
            >
              重试
            </button>
          </p>
        ) : null}
        {loaded === undefined && load !== "failed" ? <p className="routines-empty">在拉例行任务…</p> : null}
        {loaded !== undefined && rows.length === 0 ? (
          <p className="routines-empty">还没有例行任务。走通一次的活可以存下来，让它定时自己跑。</p>
        ) : null}
        {rows.map(({ routine, bot }) => (
          <RoutineRow
            key={routine.id}
            routine={routine}
            bot={bot}
            onOpen={() => setView({ kind: "editing", routineId: routine.id })}
          />
        ))}
      </section>
      <Lockbox />
    </main>
  );
};
