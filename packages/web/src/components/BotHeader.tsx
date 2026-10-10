import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Pencil, Share2 } from "lucide-react";
import type { Bot, Preference } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import { EditBotDialog } from "./EditBotDialog.js";
import { describeTriggers } from "./routines/cron.js";
import { useApp } from "../state/app.js";
import { MY_ROUTINES } from "../state/routines.js";
import { pathOf } from "../routes/screen.js";

const NONE: never[] = [];

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

export const BotHeader = ({ bot }: { bot: Bot }) => {
  const { state, actions } = useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const closeEditor = useCallback(() => {
    setEditing(false);
    editButton.current?.focus();
  }, []);

  const ready = state.status === "ready" ? state : null;
  const preferences = ready?.preferences.rows[bot.id];
  const preferenceStatus = ready?.loads[`preferences:${bot.id}`] ?? "idle";
  const skills = ready?.skills.rows[bot.id];
  const skillStatus = ready?.loads[`skills:${bot.id}`] ?? "idle";
  const routines = ready?.routines.rows[MY_ROUTINES];
  const routineStatus = ready?.loads.routines ?? "idle";

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
        <BotAvatar name={bot.name} hue={bot.hue} size="lg" />
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
          <button type="button" className="ghost-button" data-testid="bot-share" disabled title="分享稍后接上">
            <Share2 size={14} aria-hidden="true" />
            分享
          </button>
        </div>
      </div>
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
            {skills === undefined || skills.length === 0 ? (
              <p className="bot-know-empty">{skills === undefined ? "正在拉…" : "还没存会做的事"}</p>
            ) : (
              <ul>
                {skills.map((skill) => (
                  <li className="bot-know-row" key={skill.id}>
                    {skill.name}
                  </li>
                ))}
              </ul>
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
      {editing ? (
        <EditBotDialog bot={bot} onSave={(draft) => actions.updateBot(bot.id, draft)} onClose={closeEditor} />
      ) : null}
    </header>
  );
};
