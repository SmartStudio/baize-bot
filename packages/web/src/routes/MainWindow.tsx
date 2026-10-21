import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import type { Bot, BotHue, BotId, BotShape, ChecklistItem, GroupId, Message, MessageId } from "@baize/shared";
import type { Seq } from "../state/stamped.js";
import { Sidebar } from "../components/Sidebar.js";
import { NewProjectDialog } from "../components/NewProjectDialog.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { hasChoice, type ComputerChoicesView } from "../components/ComputerPicker.js";
import { BotSettingsPanel } from "../components/BotSettingsPanel.js";
import { AccountMenu } from "../components/AccountMenu.js";
import { SettingsWindow } from "../components/SettingsWindow.js";
import { TaskPanel } from "../components/TaskPanel.js";
import { ToolInspector } from "../components/ToolInspector.js";
import { LiveHost } from "../live/LiveHost.js";
import { TodayPage } from "./TodayPage.js";
import { PokerProjectPage } from "./PokerProjectPage.js";
import { ProjectPage } from "./ProjectPage.js";
import { TablePage } from "./TablePage.js";
import { RoutinesPage } from "./RoutinesPage.js";
import { TeamPage } from "./TeamPage.js";
import { pathOf, screenOf } from "./screen.js";
import { useApp } from "../state/app.js";
import { pokerTableOf } from "../state/poker.js";
import { MY_ROUTINES } from "../state/routines.js";
import { MESSAGE_GAP_ATTEMPTS } from "../state/types.js";
import { useToday } from "../state/today.js";
import { useProject } from "../state/project.js";
import type { InspectedTool } from "../components/messages/MessageView.js";
import { oauthNoticeText, oauthReturnOf, type OAuthReturn } from "./oauth.js";

type Overlay = "none" | "account" | "settings" | "accounts" | "tools" | "usage" | "new-project";

const FALLBACK: {
  name: string;
  tags: readonly string[];
  hue: BotHue;
  shape: BotShape;
  runState: "running";
  pendingApproval: false;
} = {
  name: "Bot",
  tags: [],
  hue: "sky",
  shape: "pillow",
  runState: "running",
  pendingApproval: false,
};

// 历史还没拉回来时也得给 ChatPanel 一个数组。写成字面量的话每次渲染都是新身份，滚到底的 effect 会空转。
const NO_MESSAGES: Message[] = [];

// 拉项目数据的 hook 只在项目页挂着时跑。
const ProjectView = (props: Omit<React.ComponentProps<typeof ProjectPage>, "project">) => {
  const project = useProject(props.conversation.groupId, props.conversation.task.checklist);
  return <ProjectPage project={project} {...props} />;
};

// 收起右侧 Bot 设置是这台浏览器的偏好，换 Bot、刷新都不该又弹出来。存不了（隐私窗口、禁了站点数据）就退回默认展开。
const BOT_PANEL_KEY = "baize.botPanel";
const readBotPanelOpen = (): boolean => {
  try {
    return localStorage.getItem(BOT_PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
};
const writeBotPanelOpen = (open: boolean) => {
  try {
    localStorage.setItem(BOT_PANEL_KEY, open ? "open" : "closed");
  } catch {
    // 只影响下次打开时的默认值。
  }
};

export const MainWindow = () => {
  const { state, actions } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const screen = screenOf(location.pathname);
  const today = useToday();
  const [overlay, setOverlay] = useState<Overlay>("none");
  // 记的是「哪个群的任务详情开着」，不是「开没开」。换了群它自己就不算开了，不用再拿 effect 去关一遍。
  const [taskOpenFor, setTaskOpenFor] = useState<GroupId | null>(null);
  const [inspectedTool, setInspectedTool] = useState<{ groupId: GroupId; tool: InspectedTool } | null>(null);
  const [botPanelOpen, setBotPanelOpen] = useState(readBotPanelOpen);
  const changeBotPanel = (open: boolean) => {
    setBotPanelOpen(open);
    writeBotPanelOpen(open);
  };

  const ready = state.status === "ready" ? state : null;
  // 项目页和项目群看的是同一个群：项目页要拿最近一轮，也得把这个群的历史拉回来。
  const focusGroup = screen?.kind === "group" || screen?.kind === "project" ? screen.groupId : null;
  const focused = ready?.conversations.find((c) => c.groupId === focusGroup) ?? null;
  const conversation = screen?.kind === "group" ? focused : null;
  const projectOpen = screen?.kind === "project" && focused?.kind === "team" ? focused : null;
  const tableOpen = screen?.kind === "table" ? screen.groupId : null;
  const groupId = conversation?.groupId ?? null;
  const focusedId = focused?.groupId ?? null;
  // 推送重连过的话，之前拉的历史可能漏了断线时的推送：开着的群立刻重拉，别的群下次进来时重拉。
  const reconnectedAt = ready?.reconnectedAt ?? (0 as Seq);
  const loaded = focusedId !== null && ready !== null && (ready.messagesLoadedAt[focusedId] ?? 0) > reconnectedAt;

  useEffect(() => {
    if (focusedId !== null && !loaded) void actions.loadMessages(focusedId, reconnectedAt);
  }, [focusedId, loaded, reconnectedAt, actions]);

  // 两台电脑才有得选。打开的群每次进来、推送重连过都重拉一次：runningOn 只有列表上有，没有推送专门说它变了。
  const computers = Object.values(ready?.content.computers ?? {});
  const twoComputers = hasChoice(computers);
  useEffect(() => {
    if (groupId !== null && twoComputers)
      void actions.loadComputerChoices(groupId, reconnectedAt).catch(() => undefined);
  }, [groupId, reconnectedAt, twoComputers, actions]);

  // 打开群页或项目页算看过（D3），首页扫到不算。项目页进同一个项目群还是这个群，不再记一次。
  useEffect(() => {
    if (focusedId !== null) void actions.markSeen(focusedId).catch(() => undefined);
  }, [focusedId, actions]);

  // 侧栏要知道有没有例行自己停了，例行不等进例行页才拉。在途和拉失败的不自动再要，失败等例行页上点重试。
  const routinesLoaded = ready?.routines.rows[MY_ROUTINES];
  const routinesLoad = ready?.loads.routines ?? "idle";
  useEffect(() => {
    if (ready !== null && routinesLoaded === undefined && routinesLoad === "idle") void actions.loadRoutines();
  }, [ready, routinesLoaded, routinesLoad, actions]);

  // 流式 delta 漏了版本的消息不论在哪个群都单独拉回来，侧栏的最近一条也靠它补齐。连着失败到上限的先不拉。
  const messageGaps = ready?.messageGaps;
  useEffect(() => {
    for (const [messageId, gap] of Object.entries(messageGaps ?? {}))
      if (gap.attempts < MESSAGE_GAP_ATTEMPTS) void actions.loadMessage(messageId as MessageId, gap.seq);
  }, [messageGaps, actions]);

  // 今天页原来每次切回来都重新挂载、重新拉一遍。清单提到主窗口给侧栏数待办之后不再重挂，切回来时补拉这一下。
  const onToday = screen?.kind === "today";
  const wasOnToday = useRef(onToday);
  const refreshToday = today.refresh;
  useEffect(() => {
    if (onToday && !wasOnToday.current) void refreshToday();
    wasOnToday.current = onToday;
  }, [onToday, refreshToday]);

  // 授权回跳是整页 302 回来的，主窗口挂上那一刻读一次；读完把查询串从地址栏换掉，刷新不再提示。
  const [oauth, setOauth] = useState<OAuthReturn | null>(() => oauthReturnOf(new URLSearchParams(location.search)));
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("oauth") && !params.has("result")) return;
    params.delete("oauth");
    params.delete("result");
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest === "" ? "" : `?${rest}` }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const taskOpen = groupId !== null && taskOpenFor === groupId;

  // 牌桌的项目页要整份牌桌视图，还没拉到的这段时间不画普通项目页，免得先闪一下再换。
  const projectGroupId = projectOpen?.groupId ?? null;
  const pokerTable = ready === null || projectGroupId === null ? undefined : pokerTableOf(ready, projectGroupId);
  const awaitingTable = projectOpen?.poker === true && pokerTable === undefined;
  useEffect(() => {
    if (!awaitingTable || projectGroupId === null) return;
    void actions.loadPokerTable(projectGroupId).catch(() => undefined);
  }, [actions, awaitingTable, projectGroupId]);

  if (!ready) return null;
  if (
    screen === null ||
    (screen.kind === "group" && conversation === null) ||
    (screen.kind === "project" && projectOpen === null)
  )
    return <Navigate to="/" replace />;

  const openGroupPage = (target: GroupId | undefined) => {
    if (target !== undefined) navigate(pathOf({ kind: "group", groupId: target }));
  };
  const openProjectPage = (target: GroupId | undefined) => {
    if (target !== undefined) navigate(pathOf({ kind: "project", groupId: target }));
  };
  const openTablePage = (target: GroupId) => navigate(pathOf({ kind: "table", groupId: target }));

  const bots = ready.bots;
  const assistantGroupId = today.data?.assistantGroupId ?? null;
  const projectNames: Record<GroupId, string> = Object.fromEntries(
    ready.conversations.flatMap((item) => {
      if (item.kind === "team") return [[item.groupId, item.task.title]];
      const bot = bots[item.botId];
      return bot === undefined ? [] : [[item.groupId, bot.name]];
    }),
  );
  const lookup = (botId: BotId) => {
    const found = bots[botId];
    return found
      ? {
          name: found.name,
          tags: found.tags,
          hue: found.hue,
          shape: found.shape,
          runState: found.runState,
          pendingApproval: Object.values(ready.approvals).some(
            (approval) => approval.botId === found.id && approval.status === "pending",
          ),
        }
      : FALLBACK;
  };
  const contentActions = {
    decideDraft: actions.decideDraft,
    approvePlan: actions.approvePlan,
    returnPlan: actions.returnPlan,
    loginAccount: actions.loginAccount,
    openTakeover: actions.openTakeover,
  };
  const soloBot: Bot | null = conversation?.kind === "solo" ? (bots[conversation.botId] ?? null) : null;
  const team = conversation?.kind === "team" ? conversation : null;
  const inspected = inspectedTool?.groupId === groupId ? inspectedTool.tool : null;
  const choices = groupId === null ? undefined : ready.computerChoices.rows[groupId];
  const computerChoices: ComputerChoicesView | null =
    groupId === null || !twoComputers || choices === undefined
      ? null
      : {
          groupId,
          computers,
          choices,
          onChoose: (botId, kind) => actions.chooseComputer(groupId, botId, kind),
        };
  // 检查器临时占用右栏；关掉后回到 Bot 设置（没收起的话）或任务详情。没有右栏内容时，对话区把这一栏吃掉。
  const hasPanel = inspected !== null || (soloBot !== null && botPanelOpen) || (team !== null && taskOpen);

  return (
    <div className={`window${hasPanel ? "" : " is-wide"}`} data-testid="main-window">
      <Sidebar
        screen={screen}
        conversations={ready.conversations}
        bots={bots}
        groupTurns={ready.groupTurns}
        poker={ready.poker}
        user={ready.user}
        pendingCount={today.data === null ? 0 : today.data.pending.length}
        countsStale={ready.loads.counts === "failed"}
        onRetryCounts={() => void actions.loadPendingCounts().catch(() => undefined)}
        routinesStopped={(routinesLoaded ?? []).some((routine) => routine.state === "auto_paused")}
        onNewProject={() => setOverlay("new-project")}
        onOpenAccount={() => setOverlay(overlay === "account" ? "none" : "account")}
        onOpenSettings={() => setOverlay("settings")}
      />
      {conversation !== null ? (
        <ChatPanel
          conversation={conversation}
          bots={bots}
          turn={ready.groupTurns[conversation.groupId]}
          messages={ready.messages.rows[conversation.groupId] ?? NO_MESSAGES}
          history={ready.loads[`messages:${conversation.groupId}`] ?? "idle"}
          onRetryHistory={() => void actions.loadMessages(conversation.groupId, reconnectedAt)}
          lookup={lookup}
          approvals={ready.approvals}
          handoffs={ready.handoffs}
          skills={ready.skills.rows}
          content={ready.content}
          contentActions={contentActions}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onDecideSkillOffer={actions.decideSkillOffer}
          onDecidePreferenceOffer={actions.decidePreferenceOffer}
          onDecideProjectOffer={(messageId, request) =>
            actions.decideProjectOffer(messageId, request).then(openProjectPage)
          }
          onOpenProject={openProjectPage}
          onInspectTool={(view) => {
            if (groupId !== null) setInspectedTool({ groupId, tool: view });
          }}
          inspectedToolId={inspected?.messageId ?? null}
          onLoadSkills={actions.loadSkills}
          onToggleChecklist={async (checklist: ChecklistItem[]) => {
            if (team !== null) await actions.setChecklist(team.task, checklist);
          }}
          onOpenTask={() => setTaskOpenFor(groupId)}
          computerChoices={computerChoices}
          botPanelOpen={botPanelOpen}
          onToggleBotPanel={() => {
            // 主动要看设置，就把占着右栏的检查器让出来。
            if (!botPanelOpen) setInspectedTool(null);
            changeBotPanel(!botPanelOpen);
          }}
        />
      ) : tableOpen !== null ? (
        <TablePage
          groupId={tableOpen}
          title={projectNames[tableOpen] ?? null}
          table={pokerTableOf(ready, tableOpen) ?? null}
        />
      ) : projectOpen !== null && pokerTable !== undefined ? (
        <PokerProjectPage
          table={pokerTable}
          title={projectOpen.task.title}
          onOpenTable={openTablePage}
          onStartHand={actions.startPokerHand}
          onSwapSeat={actions.swapPokerSeat}
          onArchive={actions.archiveGroup}
        />
      ) : awaitingTable ? (
        <main className="today-page today-loading" data-testid="poker-project-loading">
          正在整理这个项目
        </main>
      ) : projectOpen !== null ? (
        <ProjectView
          conversation={projectOpen}
          bots={bots}
          messages={ready.messages.rows[projectOpen.groupId] ?? NO_MESSAGES}
          lookup={lookup}
          cards={{ content: ready.content, actions: contentActions, lookup }}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onOpenGroup={openGroupPage}
          onArchive={actions.archiveGroup}
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
          cards={{ content: ready.content, actions: contentActions, lookup }}
          onSend={actions.sendMessage}
          onDecide={actions.decideApproval}
          onOpenGroup={openGroupPage}
          onOpenAccounts={() => setOverlay("accounts")}
        />
      )}
      {inspected !== null ? (
        <ToolInspector tool={inspected} onClose={() => setInspectedTool(null)} />
      ) : soloBot !== null && botPanelOpen ? (
        <BotSettingsPanel
          bot={soloBot}
          onChange={actions.updateBot}
          onPause={actions.pauseBot}
          onResume={actions.resumeBot}
          onClose={() => changeBotPanel(false)}
        />
      ) : null}
      {oauth !== null ? (
        <div className="oauth-notice" role="status" data-testid="oauth-notice" data-result={oauth.result}>
          <span>{oauthNoticeText(oauth)}</span>
          {oauth.result === "connected" ? (
            <button
              type="button"
              className="link-button"
              data-testid="oauth-notice-accounts"
              onClick={() => {
                setOauth(null);
                setOverlay("accounts");
              }}
            >
              看账号
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="关掉提示"
            data-testid="oauth-notice-close"
            onClick={() => setOauth(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
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
      {overlay === "new-project" ? (
        <NewProjectDialog
          canSend={assistantGroupId !== null}
          onSend={async (text) => {
            if (assistantGroupId === null) return;
            await actions.sendMessage(assistantGroupId, text);
            setOverlay("none");
            openGroupPage(assistantGroupId);
          }}
          onCreateTable={async (requestId) => {
            const created = await actions.createPokerTable(requestId);
            setOverlay("none");
            openProjectPage(created);
          }}
          onClose={() => setOverlay("none")}
        />
      ) : null}
      {overlay === "settings" || overlay === "accounts" || overlay === "tools" || overlay === "usage" ? (
        <SettingsWindow
          user={ready.user}
          settings={ready.settings}
          usage={ready.usage}
          bots={bots}
          tools={ready.tools}
          grants={ready.grants}
          projectNames={projectNames}
          accounts={Object.values(ready.content.accounts)}
          computers={ready.content.computers}
          grantsVersion={ready.todayVersion}
          initialPage={overlay === "settings" ? "general" : overlay}
          onCreateTool={actions.createTool}
          onUpdateTool={actions.updateTool}
          onDeleteTool={actions.deleteTool}
          onLoadUsage={actions.loadUsage}
          onLoadGrants={actions.loadGrants}
          onRevokeGrant={actions.deleteGrant}
          onLoadAccounts={actions.loadAccounts}
          onLoadComputers={actions.loadComputers}
          onChangeTier={actions.updateAccountTier}
          onChange={actions.updateSettings}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
      <LiveHost />
    </div>
  );
};
