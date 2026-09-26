import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type { Bot, BotHue, BotId, ChecklistItem, GroupId, Message } from "@baize/shared";
import { Sidebar } from "../components/Sidebar.js";
import { NewGroupDialog } from "../components/NewGroupDialog.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BotSettingsPanel } from "../components/BotSettingsPanel.js";
import { AccountMenu } from "../components/AccountMenu.js";
import { SettingsWindow } from "../components/SettingsWindow.js";
import { TaskPanel } from "../components/TaskPanel.js";
import { ToolInspector } from "../components/ToolInspector.js";
import { TodayPage } from "./TodayPage.js";
import { RoutinesPage } from "./RoutinesPage.js";
import { TeamPage } from "./TeamPage.js";
import { pathOf, screenOf } from "./screen.js";
import { useApp } from "../state/app.js";
import { pendingCountOf, useToday } from "../state/today.js";
import type { InspectedTool } from "../components/messages/MessageView.js";

type Overlay = "none" | "account" | "settings" | "tools" | "usage" | "new-group";

const FALLBACK: { name: string; tag: string; hue: BotHue } = { name: "Bot", tag: "", hue: "sky" };

// 历史还没拉回来时也得给 ChatPanel 一个数组。写成字面量的话每次渲染都是新身份，滚到底的 effect 会空转。
const NO_MESSAGES: Message[] = [];

export const MainWindow = () => {
  const { state, actions } = useApp();
  const navigate = useNavigate();
  const screen = screenOf(useLocation().pathname);
  const today = useToday();
  const [overlay, setOverlay] = useState<Overlay>("none");
  // 记的是「哪个群的任务详情开着」，不是「开没开」。换了群它自己就不算开了，不用再拿 effect 去关一遍。
  const [taskOpenFor, setTaskOpenFor] = useState<GroupId | null>(null);
  const [inspectedTool, setInspectedTool] = useState<{ groupId: GroupId; tool: InspectedTool } | null>(null);

  const ready = state.status === "ready" ? state : null;
  const openGroup = screen?.kind === "group" ? screen.groupId : null;
  const conversation = ready?.conversations.find((c) => c.groupId === openGroup) ?? null;
  const groupId = conversation?.groupId ?? null;
  const loaded = groupId !== null && ready !== null && ready.messages[groupId] !== undefined;

  useEffect(() => {
    if (groupId !== null && !loaded) void actions.loadMessages(groupId);
  }, [groupId, loaded, actions]);

  // 今天页原来每次切回来都重新挂载、重新拉一遍。清单提到主窗口给侧栏数待办之后不再重挂，切回来时补拉这一下。
  const onToday = screen?.kind === "today";
  const wasOnToday = useRef(onToday);
  const refreshToday = today.refresh;
  useEffect(() => {
    if (onToday && !wasOnToday.current) void refreshToday();
    wasOnToday.current = onToday;
  }, [onToday, refreshToday]);

  const taskOpen = groupId !== null && taskOpenFor === groupId;

  if (!ready) return null;
  if (screen === null || (screen.kind === "group" && conversation === null)) return <Navigate to="/" replace />;

  const openGroupPage = (target: GroupId | undefined) => {
    if (target !== undefined) navigate(pathOf({ kind: "group", groupId: target }));
  };

  const bots = ready.bots;
  const projectNames: Record<GroupId, string> = Object.fromEntries(
    ready.conversations.flatMap((item) => {
      if (item.kind === "team") return [[item.groupId, item.task.title]];
      const bot = bots[item.botId];
      return bot === undefined ? [] : [[item.groupId, bot.name]];
    }),
  );
  const lookup = (botId: BotId) => {
    const found = bots[botId];
    return found ? { name: found.name, tag: found.tag, hue: found.hue } : FALLBACK;
  };
  const soloBot: Bot | null = conversation?.kind === "solo" ? (bots[conversation.botId] ?? null) : null;
  const team = conversation?.kind === "team" ? conversation : null;
  const inspected = inspectedTool?.groupId === groupId ? inspectedTool.tool : null;
  // 检查器临时占用右栏；关掉后回到 Bot 设置或任务详情。没有右栏内容时，对话区把这一栏吃掉。
  const hasPanel = inspected !== null || soloBot !== null || (team !== null && taskOpen);

  return (
    <div className={`window${hasPanel ? "" : " is-wide"}`} data-testid="main-window">
      <Sidebar
        screen={screen}
        conversations={ready.conversations}
        bots={bots}
        groupTurns={ready.groupTurns}
        user={ready.user}
        pendingCount={today.data === null ? 0 : pendingCountOf(today.data)}
        onNewProject={() => setOverlay("new-group")}
        onOpenAccount={() => setOverlay(overlay === "account" ? "none" : "account")}
        onOpenSettings={() => setOverlay("settings")}
      />
      {conversation !== null ? (
        <ChatPanel
          conversation={conversation}
          bots={bots}
          turn={ready.groupTurns[conversation.groupId]}
          messages={ready.messages[conversation.groupId] ?? NO_MESSAGES}
          lookup={lookup}
          approvals={ready.approvals}
          handoffs={ready.handoffs}
          skills={ready.skills}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onDecideSkillOffer={actions.decideSkillOffer}
          onInspectTool={(view) => {
            if (groupId !== null) setInspectedTool({ groupId, tool: view });
          }}
          inspectedToolId={inspected?.messageId ?? null}
          onLoadSkills={actions.loadSkills}
          onToggleChecklist={(checklist: ChecklistItem[]) => {
            if (team !== null) void actions.setChecklist(team.task, checklist);
          }}
          onOpenTask={() => setTaskOpenFor(groupId)}
        />
      ) : screen.kind === "routines" ? (
        <RoutinesPage />
      ) : screen.kind === "team" ? (
        <TeamPage
          bots={bots}
          conversations={ready.conversations}
          onCreateBot={() => void actions.createBot().then(openGroupPage)}
        />
      ) : (
        <TodayPage
          today={today}
          userName={ready.user.name}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onOpenGroup={openGroupPage}
          onOpenSettings={() => setOverlay("settings")}
        />
      )}
      {inspected !== null ? (
        <ToolInspector tool={inspected} onClose={() => setInspectedTool(null)} />
      ) : soloBot !== null ? (
        <BotSettingsPanel
          bot={soloBot}
          tools={ready.tools}
          onChange={actions.updateBot}
          onPause={actions.pauseBot}
          onResume={actions.resumeBot}
          onOpenTools={() => setOverlay("tools")}
        />
      ) : null}
      {inspected === null && team !== null && taskOpen ? (
        <TaskPanel task={team.task} memberIds={team.botIds} bots={bots} onClose={() => setTaskOpenFor(null)} />
      ) : null}
      {overlay === "account" ? (
        <AccountMenu
          user={ready.user}
          usageTotal={ready.usage.total}
          onOpenUsage={() => setOverlay("usage")}
          onOpenSettings={() => setOverlay("settings")}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
      {overlay === "new-group" ? (
        <NewGroupDialog
          bots={Object.values(bots).filter((bot) => bot.role === "member")}
          onCreate={(draft) => actions.createGroup(draft).then(openGroupPage)}
          onClose={() => setOverlay("none")}
        />
      ) : null}
      {overlay === "settings" || overlay === "tools" || overlay === "usage" ? (
        <SettingsWindow
          user={ready.user}
          settings={ready.settings}
          usage={ready.usage}
          bots={bots}
          tools={ready.tools}
          grants={ready.grants}
          projectNames={projectNames}
          grantsVersion={ready.todayVersion}
          initialPage={overlay === "usage" ? "usage" : overlay === "tools" ? "tools" : "general"}
          onCreateTool={actions.createTool}
          onUpdateTool={actions.updateTool}
          onDeleteTool={actions.deleteTool}
          onLoadUsage={actions.loadUsage}
          onLoadGrants={actions.loadGrants}
          onRevokeGrant={actions.deleteGrant}
          onChange={actions.updateSettings}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
    </div>
  );
};
