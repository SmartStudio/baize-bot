import { ArrowRightLeft, Hand, MessageSquare, Plus, Repeat, Settings as SettingsIcon, Sun, Users } from "lucide-react";
import { Link } from "react-router-dom";
import type { Bot, BotId, GroupId, User } from "@baize/shared";
import { activityOf } from "./messages/preview.js";
import type { Conversation, GroupTurn } from "../state/app.js";
import { pathOf, type Screen } from "../routes/screen.js";

type Team = Extract<Conversation, { kind: "team" }>;

type Props = {
  screen: Screen;
  conversations: Conversation[];
  bots: Record<BotId, Bot>;
  groupTurns: Record<GroupId, GroupTurn>;
  user: User;
  pendingCount: number;
  countsStale: boolean;
  onRetryCounts: () => void;
  onNewProject: () => void;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
};

const currentIf = (on: boolean) => (on ? ("page" as const) : undefined);

const ProjectItem = ({
  project,
  bots,
  turn,
  current,
}: {
  project: Team;
  bots: Record<BotId, Bot>;
  turn: GroupTurn | undefined;
  current: boolean;
}) => {
  const lead = project.botIds.map((botId) => bots[botId]).find((bot) => bot !== undefined);
  const handler = project.task.currentBotId === null ? undefined : bots[project.task.currentBotId];
  const working = activityOf(project.lastMessage) === "working";
  const hasBadges = project.pendingApprovals > 0 || project.pendingHandoffs > 0 || working;
  return (
    <Link
      to={pathOf({ kind: "project", groupId: project.groupId })}
      className="nav project"
      data-testid="group-item"
      data-group-title={project.task.title}
      aria-current={currentIf(current)}
    >
      <span className="dot" style={{ background: `var(--bot-${lead?.hue ?? "sky"})` }} aria-hidden="true" />
      <span className="project-body">
        <b data-testid="project-title">{project.task.title}</b>
        {hasBadges ? (
          <span className="project-badges">
            {project.pendingApprovals > 0 ? (
              <span className="badge badge-pending" data-testid="bot-pending">
                <Hand size={13} aria-hidden="true" />
                等你点头 {project.pendingApprovals}
              </span>
            ) : null}
            {/* 等 Bot 确认的不用你动手，压在「等你点头」下面一档，两个角标并排时你先看到该你做的那个。 */}
            {project.pendingHandoffs > 0 ? (
              <span className="badge badge-await-bot" data-testid="bot-handoff">
                <ArrowRightLeft size={13} aria-hidden="true" />等 Bot 确认 {project.pendingHandoffs}
              </span>
            ) : null}
            {working ? (
              <span className="badge badge-working" data-testid="bot-working">
                干活中
              </span>
            ) : null}
          </span>
        ) : null}
        <small data-testid="group-handler">
          {turn?.current
            ? `${bots[turn.current]?.name ?? turn.current}正在说`
            : handler
              ? `${handler.name} 经手`
              : "待派活"}
        </small>
      </span>
    </Link>
  );
};

export const Sidebar = ({
  screen,
  conversations,
  bots,
  groupTurns,
  user,
  pendingCount,
  countsStale,
  onRetryCounts,
  onNewProject,
  onOpenAccount,
  onOpenSettings,
}: Props) => {
  // 项目页和项目群是同一个项目，两处都点亮侧栏那一项。
  const openGroup = screen.kind === "group" || screen.kind === "project" ? screen.groupId : null;
  const assistant = conversations.find((c) => c.kind === "solo" && bots[c.botId]?.role === "assistant");
  const projects = conversations.filter((c): c is Team => c.kind === "team");
  const openSolo = conversations.find((c) => c.kind === "solo" && c.groupId === openGroup);
  // 和队员单聊是从团队页点进去的，侧栏把它算在「团队」底下，不然这时候侧栏一个亮的都没有。
  const onTeam = screen.kind === "team" || (openSolo !== undefined && openSolo !== assistant);

  return (
    <nav className="sidebar" data-testid="sidebar">
      <Link
        to={pathOf({ kind: "today" })}
        className="nav"
        data-testid="today-nav"
        aria-current={currentIf(screen.kind === "today")}
      >
        <Sun size={17} aria-hidden="true" />
        今天
        {pendingCount > 0 ? (
          <span className="count" data-testid="today-count">
            {pendingCount}
          </span>
        ) : null}
      </Link>
      {assistant === undefined ? null : (
        <Link
          to={pathOf({ kind: "group", groupId: assistant.groupId })}
          className="nav"
          data-testid="assistant-nav"
          aria-current={currentIf(openGroup === assistant.groupId)}
        >
          <MessageSquare size={17} aria-hidden="true" />
          主助理
        </Link>
      )}
      <div className="sect" data-testid="projects-label">
        <span>项目</span>
        <button type="button" className="sect-add" data-testid="new-project" aria-label="新项目" onClick={onNewProject}>
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      {projects.map((project) => (
        <ProjectItem
          key={project.groupId}
          project={project}
          bots={bots}
          turn={groupTurns[project.groupId]}
          current={openGroup === project.groupId}
        />
      ))}
      {countsStale ? (
        <p className="team-offer-error" data-testid="counts-stale" role="alert">
          待办数没刷新上，角标可能不准
          <button type="button" className="ghost-button" onClick={onRetryCounts}>
            重试
          </button>
        </p>
      ) : null}
      <div className="side-low">
        <Link
          to={pathOf({ kind: "routines" })}
          className="nav lite"
          data-testid="routines-nav"
          aria-current={currentIf(screen.kind === "routines")}
        >
          <Repeat size={16} aria-hidden="true" />
          例行
        </Link>
        <Link
          to={pathOf({ kind: "team" })}
          className="nav lite"
          data-testid="team-nav"
          aria-current={currentIf(onTeam)}
        >
          <Users size={16} aria-hidden="true" />
          团队
        </Link>
        <div className="foot">
          <button type="button" className="account-button" data-testid="account-button" onClick={onOpenAccount}>
            <span className="avatar avatar-sm avatar-user" aria-hidden="true">
              {[...user.name][0]}
            </span>
            你
          </button>
          <button
            type="button"
            className="icon-button"
            data-testid="sidebar-settings"
            aria-label="设置"
            onClick={onOpenSettings}
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  );
};
