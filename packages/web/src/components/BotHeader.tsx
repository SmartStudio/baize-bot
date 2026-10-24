import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, PanelRight, Pencil, Share2 } from "lucide-react";
import type { Bot, BotId, Preference, Skill, SkillSource } from "@baize/shared";
import { BotAvatar, type BotAvatarState } from "./BotAvatar.js";
import { BotComputerPicker, type ComputerChoicesView } from "./ComputerPicker.js";
import { EditBotDialog } from "./EditBotDialog.js";
import { ShareDialog } from "./ShareDialog.js";
import { describeTriggers } from "./routines/cron.js";
import { useApp } from "../state/app.js";
import { useFailureToast } from "./Toasts.js";
import { MY_ROUTINES } from "../state/routines.js";
import { pathOf } from "../routes/screen.js";

const NONE: never[] = [];

// 装来的那条另带一个可点的原页面，其余来源一句话说完。taught 只剩界面教技能那条路拆掉之前存下的旧数据。
const SKILL_SOURCE: Record<Exclude<SkillSource, "installed">, string> = {
  chat: "对话里存的",
  routine: "例行里存的",
  taught: "你教的",
  template: "模板带来的",
};

const SkillSourceText = ({ skill }: { skill: Skill }) => {
  if (skill.source !== "installed") return <>{SKILL_SOURCE[skill.source]}</>;
  if (skill.origin === null) return <>装的</>;
  return (
    <>
      从{" "}
      <a href={skill.origin} rel="noreferrer" target="_blank" data-testid="bot-skill-origin">
        {new URL(skill.origin).host}
      </a>{" "}
      装的
    </>
  );
};

const SkillRow = ({ skill }: { skill: Skill }) => {
  const [open, setOpen] = useState(false);
  return (
    <li className="bot-skill" data-testid="bot-skill" data-skill-name={skill.name}>
      <button
        type="button"
        className="bot-skill-toggle"
        aria-expanded={open}
        data-testid="bot-skill-toggle"
        onClick={() => setOpen((was) => !was)}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>{skill.name}</span>
      </button>
      {open ? (
        <div className="bot-skill-detail">
          <ol className="skill-steps">
            {skill.steps.map((step, at) => (
              <li key={`${at}-${step}`} data-testid="bot-skill-step">
                {step}
              </li>
            ))}
          </ol>
          <small data-testid="bot-skill-meta">
            <SkillSourceText skill={skill} /> · 用过 {skill.useCount} 次
          </small>
        </div>
      ) : null}
    </li>
  );
};

const PreferenceRow = ({ preference, onForget }: { preference: Preference; onForget: () => Promise<void> }) => {
  const [request, setRequest] = useState<"idle" | "busy" | "failed">("idle");
  const forget = async () => {
    setRequest("busy");
    try {
      await onForget();
    } catch {
      setRequest("failed");
    }
  };
  return (
    <li className="bot-know-row" data-testid="bot-pref">
      <span data-testid="bot-pref-text">{preference.text}</span>
      {preference.private ? <em className="tag">私人</em> : null}
      {request === "failed" ? (
        <small className="bot-know-error" role="alert">
          没忘掉，再试一次
        </small>
      ) : null}
      <button
        type="button"
        className="link-button"
        data-testid="bot-pref-forget"
        disabled={request === "busy"}
        onClick={() => void forget()}
      >
        忘掉
      </button>
    </li>
  );
};

export const BotHeader = ({
  bot,
  computerChoices,
  avatarState = "idle",
  panelOpen,
  onTogglePanel,
}: {
  bot: Bot;
  avatarState?: BotAvatarState;
  panelOpen: boolean;
  onTogglePanel: () => void;
  // 没得选或这个群的选择还没拉回来时为 null，不画选择器。
  computerChoices: ComputerChoicesView | null;
}) => {
  const { state, actions } = useApp();
  const failed = useFailureToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [syncingTools, setSyncingTools] = useState<BotId | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const shareButton = useRef<HTMLButtonElement>(null);
  const closeEditor = useCallback(() => {
    setEditing(false);
    editButton.current?.focus();
  }, []);
  const closeShare = useCallback(() => {
    setSharing(false);
    shareButton.current?.focus();
  }, []);

  const ready = state.status === "ready" ? state : null;
  const preferences = ready?.preferences.rows[bot.id];
  const preferenceStatus = ready?.loads[`preferences:${bot.id}`] ?? "idle";
  const skills = ready?.skills.rows[bot.id];
  const skillStatus = ready?.loads[`skills:${bot.id}`] ?? "idle";
  const routines = ready?.routines.rows[MY_ROUTINES];
  const routineStatus = ready?.loads.routines ?? "idle";
  // 导入带来的插件还没进本地工具表，这时分享摘要会少报插件，先同步再分享。
  const toolsUnsynced = ready?.toolsUnsynced.includes(bot.id) ?? false;
  const syncTools = async () => {
    setSyncingTools(bot.id);
    try {
      await actions.syncBotTools(bot.id);
    } catch (cause) {
      // toolsUnsynced 还记着，入口留着再点。
      failed("插件没同步上，再试一次")(cause);
    } finally {
      setSyncingTools(null);
    }
  };

  // 拉失败了不自己再要，展开里给重试。
  useEffect(() => {
    if (preferences === undefined && preferenceStatus === "idle") void actions.loadPreferences(bot.id);
  }, [bot.id, preferences, preferenceStatus, actions]);
  useEffect(() => {
    if (skills === undefined && skillStatus === "idle") void actions.loadSkills(bot.id);
  }, [bot.id, skills, skillStatus, actions]);
  useEffect(() => {
    if (routines === undefined && routineStatus === "idle") void actions.loadRoutines();
  }, [routines, routineStatus, actions]);

  const projects = (ready?.conversations ?? []).flatMap((conversation) =>
    conversation.kind === "team" && conversation.botIds.includes(bot.id) ? [conversation] : [],
  );
  const mine = (routines ?? NONE).filter((routine) => routine.botId === bot.id);
  const remembered = preferences === undefined ? "…" : String(preferences.length);
  const known = skills === undefined ? "…" : String(skills.length);

  return (
    <header className="bot-header" data-testid="bot-header">
      <div className="bot-header-main">
        <BotAvatar shape={bot.shape} hue={bot.hue} state={avatarState} size="lg" />
        <div className="bot-header-text">
          <h2 data-testid="chat-title">{bot.name}</h2>
          {bot.tags.length > 0 ? (
            <div className="bot-header-tags">
              {bot.tags.map((tag) => (
                <em className="tag" key={tag}>
                  {tag}
                </em>
              ))}
            </div>
          ) : null}
          {bot.description.length > 0 ? <p data-testid="bot-header-description">{bot.description}</p> : null}
        </div>
        <div className="bot-header-actions">
          <button
            ref={editButton}
            type="button"
            className="ghost-button"
            data-testid="bot-edit"
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} aria-hidden="true" />
            编辑
          </button>
          <button
            ref={shareButton}
            type="button"
            className="ghost-button"
            data-testid="bot-share"
            disabled={skills === undefined || preferences === undefined || toolsUnsynced}
            onClick={() => setSharing(true)}
          >
            <Share2 size={14} aria-hidden="true" />
            分享
          </button>
          <button
            type="button"
            className="ghost-button"
            data-testid="bot-panel-toggle"
            aria-pressed={panelOpen}
            aria-label={panelOpen ? "收起 Bot 设置" : "打开 Bot 设置"}
            onClick={onTogglePanel}
          >
            <PanelRight size={14} aria-hidden="true" />
            设置
          </button>
        </div>
      </div>
      {computerChoices === null ? null : <BotComputerPicker view={computerChoices} botId={bot.id} />}
      {toolsUnsynced ? (
        <p className="dialog-note" data-testid="bot-tools-unsynced" role="status">
          导入时带来的插件还没同步过来，同步后才能分享
          <button
            type="button"
            className="link-button"
            data-testid="bot-sync-tools"
            disabled={syncingTools === bot.id}
            onClick={() => void syncTools()}
          >
            {syncingTools === bot.id ? "正在同步插件…" : "同步插件"}
          </button>
        </p>
      ) : null}
      <button
        type="button"
        className="bot-know-toggle"
        data-testid="bot-know-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <b>它知道的</b>
        <span>
          记住 {remembered} 条 · 会 {known} 件事 · 在 {projects.length} 个项目
        </span>
      </button>
      {open ? (
        <div className="bot-know" data-testid="bot-know">
          <section>
            <h3>记住的</h3>
            {preferences === undefined ? (
              preferenceStatus === "failed" ? (
                <p className="bot-know-empty" role="alert">
                  没拉下来。{" "}
                  <button type="button" className="link-button" onClick={() => void actions.loadPreferences(bot.id)}>
                    重试
                  </button>
                </p>
              ) : (
                <p className="bot-know-empty">正在拉…</p>
              )
            ) : preferences.length === 0 ? (
              <p className="bot-know-empty">还没记住什么。在这里跟它说「以后……」，它会记下来</p>
            ) : (
              <ul>
                {preferences.map((preference) => (
                  <PreferenceRow
                    key={preference.id}
                    preference={preference}
                    onForget={() => actions.deletePreference(preference)}
                  />
                ))}
              </ul>
            )}
          </section>
          <section data-testid="bot-know-skills">
            <h3>会做的事</h3>
            {skills === undefined ? (
              skillStatus === "failed" ? (
                <p className="bot-know-empty" role="alert" data-testid="skills-failed">
                  没拉下来。{" "}
                  <button
                    type="button"
                    className="link-button"
                    data-testid="skills-retry"
                    onClick={() => void actions.loadSkills(bot.id)}
                  >
                    重试
                  </button>
                </p>
              ) : (
                <p className="bot-know-empty">正在拉…</p>
              )
            ) : skills.length === 0 ? (
              <p className="bot-know-empty" data-testid="bot-skills-empty">
                还没存会做的事。跟它说「把刚才的做法存成技能」，或「去找个做周报的技能装上」
              </p>
            ) : (
              <>
                <ul>
                  {skills.map((skill) => (
                    <SkillRow key={skill.id} skill={skill} />
                  ))}
                </ul>
                <p className="bot-know-empty" data-testid="bot-skills-hint">
                  想加、想改、想删，直接跟它说
                </p>
              </>
            )}
          </section>
          <section data-testid="bot-know-projects">
            <h3>所在项目</h3>
            {projects.length === 0 ? (
              <p className="bot-know-empty">还没进项目</p>
            ) : (
              <ul>
                {projects.map((project) => (
                  <li className="bot-know-row" key={project.groupId}>
                    <Link to={pathOf({ kind: "project", groupId: project.groupId })}>{project.task.title}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section data-testid="bot-know-routines">
            <h3>到点做的事</h3>
            {mine.length === 0 ? (
              <p className="bot-know-empty">{routines === undefined ? "正在拉…" : "没有到点做的事"}</p>
            ) : (
              <ul>
                {mine.map((routine) => (
                  <li className="bot-know-row" key={routine.id}>
                    <span>{routine.name}</span>
                    <small>{routine.state === "on" ? describeTriggers(routine.triggers) : "已停用"}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
      {sharing && skills !== undefined && preferences !== undefined ? (
        <ShareDialog
          // 勾选、复制结果和在途导出都属于这个 Bot。换 Bot 单聊时组件不卸载，靠 key 换一个新弹窗。
          key={bot.id}
          bot={bot}
          skills={skills}
          plugins={(ready?.tools ?? NONE).filter((tool) => tool.assignedBotIds.includes(bot.id))}
          preferences={preferences}
          onClose={closeShare}
        />
      ) : null}
      {editing ? (
        <EditBotDialog bot={bot} onSave={(draft) => actions.updateBot(bot.id, draft)} onClose={closeEditor} />
      ) : null}
    </header>
  );
};
