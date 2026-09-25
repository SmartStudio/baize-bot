import { useEffect, useState } from "react";
import type { Bot, BotHue, BotId, ChecklistItem, GroupId, Message } from "@baize/shared";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BotSettingsPanel } from "../components/BotSettingsPanel.js";
import { AccountMenu } from "../components/AccountMenu.js";
import { SettingsWindow } from "../components/SettingsWindow.js";
import { TaskPanel } from "../components/TaskPanel.js";
import { ToolInspector } from "../components/ToolInspector.js";
import { TodayPage } from "./TodayPage.js";
import { useApp } from "../state/app.js";
import type { InspectedTool } from "../components/messages/MessageView.js";

type Overlay = "none" | "account" | "settings" | "tools" | "usage";

const FALLBACK: { name: string; tag: string; hue: BotHue } = { name: "Bot", tag: "", hue: "sky" };

// 历史还没拉回来时也得给 ChatPanel 一个数组。写成字面量的话每次渲染都是新身份，滚到底的 effect 会空转。
const NO_MESSAGES: Message[] = [];

export const MainWindow = () => {
  const { state, actions } = useApp();
  const [overlay, setOverlay] = useState<Overlay>("none");
  // 记的是「哪个群的任务详情开着」，不是「开没开」。换了群它自己就不算开了，不用再拿 effect 去关一遍。
  const [taskOpenFor, setTaskOpenFor] = useState<GroupId | null>(null);
  const [inspectedTool, setInspectedTool] = useState<{ groupId: GroupId; tool: InspectedTool } | null>(null);

  const ready = state.status === "ready" ? state : null;
  const conversation = ready?.conversations.find((c) => c.groupId === ready.selectedGroupId) ?? null;
  const groupId = conversation?.groupId ?? null;
  const loaded = groupId !== null && ready !== null && ready.messages[groupId] !== undefined;

  useEffect(() => {
    if (groupId !== null && !loaded) void actions.loadMessages(groupId);
  }, [groupId, loaded, actions]);

  const taskOpen = groupId !== null && taskOpenFor === groupId;

  if (!ready) return null;

  const bots = ready.bots;
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
        conversations={ready.conversations}
        bots={bots}
        groupTurns={ready.groupTurns}
        selectedGroupId={ready.selectedGroupId}
        user={ready.user}
        onSelectToday={() => actions.selectGroup(null)}
        onSelect={actions.selectGroup}
        onCreateBot={() => void actions.createBot()}
        onOpenAccount={() => setOverlay(overlay === "account" ? "none" : "account")}
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
      ) : (
        <TodayPage
          userName={ready.user.name}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onOpenGroup={actions.selectGroup}
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
      {overlay === "settings" || overlay === "tools" || overlay === "usage" ? (
        <SettingsWindow
          user={ready.user}
          settings={ready.settings}
          usage={ready.usage}
          bots={bots}
          tools={ready.tools}
          initialPage={overlay === "usage" ? "usage" : overlay === "tools" ? "tools" : "general"}
          onCreateTool={actions.createTool}
          onUpdateTool={actions.updateTool}
          onDeleteTool={actions.deleteTool}
          onLoadUsage={actions.loadUsage}
          onChange={actions.updateSettings}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
    </div>
  );
};
