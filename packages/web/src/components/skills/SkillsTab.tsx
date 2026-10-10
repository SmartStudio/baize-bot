import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { CreateSkillRequest, type BotId, type Skill, type SkillId } from "@baize/shared";
import { useApp } from "../../state/app.js";
import { BotAvatar } from "../BotAvatar.js";

// 列表、还没存下来的草稿、看某一条、编某一条，四选一。picking 只在详情里存在，所以「在列表上挑复制给谁」
// 这种状态拼不出来。
type View =
  | { kind: "list" }
  | { kind: "draft" }
  | { kind: "detail"; skillId: SkillId; picking: boolean }
  | { kind: "editing"; skillId: SkillId };

// 编辑器认的那一份。步骤在界面上是一整块文本，一行一步，存下来的那条把 steps 拼回去，两边共用同一个表单。
type Form = { name: string; stepsText: string };

const EMPTY_FORM: Form = { name: "", stepsText: "" };

const stepsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const pad = (value: number) => String(value).padStart(2, "0");

const noteOf = (skill: Skill): string => {
  const at = new Date(skill.createdAt);
  const day = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${day} 存的 · 用过 ${skill.useCount} 次`;
};

const Crumb = ({ count, current, onBack }: { count: number; current: string; onBack: () => void }) => (
  <div className="skill-crumb">
    <button
      type="button"
      className="icon-button"
      aria-label="返回会做的活列表"
      data-testid="skill-back"
      onClick={onBack}
    >
      <ChevronLeft size={16} aria-hidden="true" />
    </button>
    <button type="button" className="link-button" onClick={onBack}>
      会做的活 · {count}
    </button>
    <span>/</span>
    <b>{current}</b>
  </div>
);

const SkillEditor = ({
  count,
  crumb,
  form,
  saveLabel,
  onSave,
  onBack,
}: {
  count: number;
  crumb: string;
  form: Form;
  saveLabel: string;
  onSave: (draft: CreateSkillRequest) => Promise<void>;
  onBack: () => void;
}) => {
  const [value, setValue] = useState(form);
  const steps = stepsOf(value.stepsText);
  const saveable = CreateSkillRequest.safeParse({ name: value.name.trim(), steps }).success;
  return (
    <div className="skills" data-testid="skill-editor">
      <Crumb count={count} current={crumb} onBack={onBack} />
      <label className="field">
        <span>名称</span>
        <input
          data-testid="skill-name-input"
          value={value.name}
          placeholder="Globex 报价"
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>步骤</span>
        <textarea
          data-testid="skill-steps-input"
          rows={8}
          value={value.stepsText}
          placeholder="一行一步，从第一步写起"
          onChange={(e) => setValue({ ...value, stepsText: e.target.value })}
        />
      </label>
      <div className="skill-actions">
        <button type="button" className="ghost-button" data-testid="skill-cancel" onClick={onBack}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          data-testid="skill-save"
          disabled={!saveable}
          // 没存成就留在编辑器里。先退回去的话，刚写完的一整条就没了，界面上还看着像存好了。
          onClick={() => void onSave({ name: value.name.trim(), steps }).catch(() => undefined)}
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
};

export const SkillsTab = ({ botId }: { botId: BotId }) => {
  const { state, actions } = useApp();
  const [view, setView] = useState<View>({ kind: "list" });

  const ready = state.status === "ready" ? state : null;
  const skills = ready?.skills.rows[botId];
  const status = ready?.loads[`skills:${botId}`] ?? "idle";

  // 拉失败了等用户点重试，不自己再要。
  useEffect(() => {
    if (skills === undefined && status === "idle") void actions.loadSkills(botId);
  }, [botId, skills, status, actions]);

  if (ready === null || skills === undefined)
    return status === "failed" ? (
      <p className="skills-empty" role="alert" data-testid="skills-failed">
        会做的活没拉下来。{" "}
        <button
          type="button"
          className="ghost-button"
          data-testid="skills-retry"
          onClick={() => void actions.loadSkills(botId)}
        >
          重试
        </button>
      </p>
    ) : (
      <p className="skills-empty">在拉会做的活…</p>
    );

  const toList = () => setView({ kind: "list" });

  if (view.kind === "draft") {
    return (
      <SkillEditor
        count={skills.length}
        crumb="新的活"
        form={EMPTY_FORM}
        saveLabel="存好了"
        onSave={(draft) => actions.createSkill(botId, draft).then(toList)}
        onBack={toList}
      />
    );
  }

  // 正看着或正编着的这条被别的窗口删了，推送一到就查不着。退回列表，比留一个空壳强。
  const current = view.kind === "list" ? null : (skills.find((s) => s.id === view.skillId) ?? null);

  if (current !== null && view.kind === "editing") {
    const toDetail = () => setView({ kind: "detail", skillId: current.id, picking: false });
    return (
      <SkillEditor
        count={skills.length}
        crumb={current.name}
        form={{ name: current.name, stepsText: current.steps.join("\n") }}
        saveLabel="改好了"
        onSave={(draft) => actions.updateSkill(current.id, draft).then(toDetail)}
        onBack={toDetail}
      />
    );
  }

  if (current !== null && view.kind === "detail") {
    const targets = Object.values(ready.bots).filter((bot) => bot.id !== botId);
    return (
      <div className="skills">
        <Crumb count={skills.length} current={current.name} onBack={toList} />
        <div className="skill-detail" data-testid="skill-detail">
          <div className="skill-detail-head">
            <b>{current.name}</b>
            <button
              type="button"
              className="ghost-button"
              data-testid="skill-edit"
              onClick={() => setView({ kind: "editing", skillId: current.id })}
            >
              <Pencil size={14} aria-hidden="true" />
              改一改
            </button>
            <button
              type="button"
              className="ghost-button"
              data-testid="skill-delete"
              onClick={() => {
                void actions.deleteSkill(current);
                toList();
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              删掉
            </button>
            <button
              type="button"
              className="ghost-button"
              data-testid="skill-copy"
              onClick={() => setView({ kind: "detail", skillId: current.id, picking: !view.picking })}
            >
              <Copy size={14} aria-hidden="true" />
              复制给别的 Bot
            </button>
          </div>
          <ol className="skill-steps">
            {current.steps.map((step, at) => (
              <li key={`${at}-${step}`} data-testid="skill-step">
                {step}
              </li>
            ))}
          </ol>
          {view.picking ? (
            <div className="skill-copy-menu" data-testid="skill-copy-menu">
              {targets.length === 0 ? <p className="skills-empty">你只有这一个 Bot</p> : null}
              {targets.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  className="menu-row"
                  data-testid="skill-copy-option"
                  data-bot-name={bot.name}
                  onClick={() => {
                    void actions.copySkill(current.id, bot.id);
                    setView({ kind: "detail", skillId: current.id, picking: false });
                  }}
                >
                  <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
                  {bot.name}
                </button>
              ))}
            </div>
          ) : null}
          <p className="skill-note">skill 属于这个 Bot。干过的活它会问你要不要存下来。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="skills" data-testid="skill-list">
      <div className="skills-head">
        <span className="group-label">会做的活 · {skills.length}</span>
        <button
          type="button"
          className="ghost-button"
          data-testid="skill-new"
          onClick={() => setView({ kind: "draft" })}
        >
          <Plus size={14} aria-hidden="true" />
          教它一个
        </button>
      </div>
      {skills.length === 0 ? (
        <p className="skills-empty">还没有会做的活。干过的活它会问你存不存，你也可以自己教它一个。</p>
      ) : null}
      {skills.map((skill) => (
        <div className="row-card" data-testid="skill-row" data-skill-name={skill.name} key={skill.id}>
          <button
            type="button"
            className="skill-open"
            data-testid="skill-open"
            onClick={() => setView({ kind: "detail", skillId: skill.id, picking: false })}
          >
            <b>{skill.name}</b>
            <small data-testid="skill-row-note">{noteOf(skill)}</small>
          </button>
          <ChevronRight size={16} aria-hidden="true" />
        </div>
      ))}
    </div>
  );
};
