import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, SendHorizontal, Sparkles, Users } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Bot, BotId, ChecklistItem, GroupId, Message, MessageId, Skill } from "@baize/shared";
import {
  TurnView,
  type ApprovalTable,
  type BotLookup,
  type DecideApproval,
  type DecidePreferenceOffer,
  type DecideSkillOffer,
  type HandoffTable,
  type InspectTool,
  type ToggleTools,
} from "./messages/MessageView.js";
import { turnsOf, type Turn } from "./messages/turns.js";
import { BotAvatar, resolveBotAvatarState } from "./BotAvatar.js";
import { BotHeader } from "./BotHeader.js";
import { TeamComputerNotes, TeamComputers, type ComputerChoicesView } from "./ComputerPicker.js";
import { TaskCard } from "./TaskCard.js";
import { memberIdsOf, type Conversation, type GroupTurn } from "../state/app.js";
import { prefillOf } from "./routines/prefill.js";
import { setDraft, useComposerDraft } from "../state/composer-drafts.js";
import { ComposerTextarea } from "./ComposerTextarea.js";
import { useFailureToast } from "./Toasts.js";
import type { ContentBook, LoadStatus, MessageEdge } from "../state/types.js";
import type { ContentActions } from "./messages/DraftCards.js";
import type { ProjectOfferActions } from "./messages/ProjectOfferCard.js";

type Props = {
  conversation: Conversation;
  turn: GroupTurn | undefined;
  bots: Record<BotId, Bot>;
  messages: Message[];
  history: LoadStatus;
  onRetryHistory: () => void;
  edge: MessageEdge | undefined;
  older: LoadStatus;
  onLoadOlder: (groupId: GroupId, before: MessageId) => Promise<void>;
  lookup: BotLookup;
  approvals: ApprovalTable;
  handoffs: HandoffTable;
  content: ContentBook;
  contentActions: ContentActions;
  skills: Record<BotId, Skill[]>;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: DecideApproval;
  onDecideSkillOffer: DecideSkillOffer;
  onDecidePreferenceOffer: DecidePreferenceOffer;
  onDecideProjectOffer: ProjectOfferActions["decide"];
  onOpenProject: (groupId: GroupId) => void;
  onInspectTool: InspectTool;
  inspectedToolId: MessageId | null;
  onLoadSkills: (botId: BotId) => Promise<void>;
  onToggleChecklist: (checklist: ChecklistItem[]) => Promise<void>;
  onOpenTask: () => void;
  computerChoices: ComputerChoicesView | null;
  botPanelOpen: boolean;
  onToggleBotPanel: () => void;
};

// 单 Bot 群没有清单。写成字面量的话每次渲染都是新身份，白让回合组件重画一遍。
const NO_CHECKLIST: ChecklistItem[] = [];
const NO_OPEN_TOOLS: ReadonlySet<MessageId> = new Set();

// 正在打的那个 @。光标永远在末尾，所以只认结尾这一段：@ 之后还没打空格的字。
const MENTION = /@([^\s@]*)$/;

// 斜杠得贴着行首或一个空白，不然 `@/x` 会同时算成两个菜单。
const SLASH = /(^|\s)\/([^\s/]*)$/;

// 输入框底下同一时刻只有一个菜单。写成联合而不是两个各自为政的变量，「@ 和 / 的菜单一起弹出来」
// 就拼不出来。
type Picker = { kind: "mention"; typing: string } | { kind: "slash"; typing: string } | null;

const pickerOf = (draft: string): Picker => {
  const slash = SLASH.exec(draft);
  if (slash !== null) return { kind: "slash", typing: slash[2] ?? "" };
  const mention = MENTION.exec(draft);
  return mention === null ? null : { kind: "mention", typing: mention[1] ?? "" };
};

const LOAD_OLDER_PX = 200;

// 用户正看着的那一条：可见区最上面那条消息，和它离列表顶的距离。锚到单条消息而不是回合：更早的一页
// 以同一个 Bot 的话结尾时会并进打头的回合，打头的审批、交接卡也会并进去，回合的边界和 id 都会变，
// 单条消息的 id 和它自己的框不会。
type Mark = { id: string; offset: number };
// marks 是可见区从上往下的前几条，头一条被藏起来或卸掉了就按顺序退到下一条。scrollTop 是记下时的滚动位置，
// 用来认出「用户刚滚过、滚动事件还没到」。
type Anchor = { scrollTop: number; marks: Mark[] };

const SHOWN = "[data-message-id]:not([hidden])";
const MARKS = 5;

// 消息在列表里从上往下排，底边随文档顺序递增，二分找第一条底边过了可见区顶的。每次渲染都要找一遍，长会话里不逐条量。
const anchorOf = (list: HTMLElement): Anchor => {
  const top = list.getBoundingClientRect().top;
  const shown = list.querySelectorAll<HTMLElement>(SHOWN);
  let low = 0;
  let high = shown.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((shown[mid]?.getBoundingClientRect().bottom ?? top) > top) high = mid;
    else low = mid + 1;
  }
  const marks: Mark[] = [];
  for (let at = low; at < Math.min(low + MARKS, shown.length); at += 1) {
    const message = shown[at];
    if (message !== undefined)
      marks.push({ id: message.dataset.messageId ?? "", offset: message.getBoundingClientRect().top - top });
  }
  return { scrollTop: list.scrollTop, marks };
};

// 滚动位置和记下的不一样就是人滚过，只有一种例外：上面的内容变矮，浏览器把滚动位置往回夹到了底。
const scrolledSince = (list: HTMLElement, anchor: Anchor): boolean => {
  if (list.scrollTop === anchor.scrollTop) return false;
  const clamped = list.scrollTop < anchor.scrollTop && list.scrollTop >= list.scrollHeight - list.clientHeight - 1;
  return !clamped;
};

const keepInPlace = (list: HTMLElement, anchor: Anchor) => {
  const top = list.getBoundingClientRect().top;
  for (const mark of anchor.marks) {
    const message = list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mark.id)}"]`);
    if (message === null || message.getClientRects().length === 0) continue;
    const shift = message.getBoundingClientRect().top - top - mark.offset;
    if (Math.abs(shift) >= 0.5) list.scrollTop += shift;
    return;
  }
};

const firstAt = (turn: Turn): string =>
  turn.kind === "bot" ? (turn.items[0]?.createdAt ?? "") : turn.message.createdAt;
const lastAt = (turn: Turn): string =>
  turn.kind === "bot" ? (turn.items.at(-1)?.createdAt ?? "") : turn.message.createdAt;

const timeLabel = (at: string): string => {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return `今天 ${clock}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
};

const needsTimeDivider = (turn: Turn, before: Turn | undefined): boolean => {
  if (before === undefined) return true;
  const start = new Date(firstAt(turn));
  const previous = new Date(lastAt(before));
  return start.toDateString() !== previous.toDateString() || start.getTime() - previous.getTime() > 5 * 60_000;
};

export const ChatPanel = ({
  conversation,
  turn,
  bots,
  messages,
  history,
  onRetryHistory,
  edge,
  older,
  onLoadOlder,
  lookup,
  approvals,
  handoffs,
  content,
  contentActions,
  skills,
  onSend,
  onDecide,
  onDecideSkillOffer,
  onDecidePreferenceOffer,
  onDecideProjectOffer,
  onOpenProject,
  onInspectTool,
  inspectedToolId,
  onLoadSkills,
  onToggleChecklist,
  onOpenTask,
  computerChoices,
  botPanelOpen,
  onToggleBotPanel,
}: Props) => {
  const groupId = conversation.groupId;
  const draft = useComposerDraft(groupId);
  const failed = useFailureToast();
  const [pickerOff, setPickerOff] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showScroll, setShowScroll] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const team = conversation.kind === "team";
  // 交接卡上的清单指针要指出那一项的正文。单 Bot 群没有任务卡，也就没有清单可指。
  const checklist = conversation.kind === "team" ? conversation.task.checklist : NO_CHECKLIST;
  const members = memberIdsOf(conversation)
    .map((botId) => bots[botId])
    .filter((bot): bot is Bot => bot !== undefined);
  const lead = members[0];
  const avatarStateOf = (bot: Bot) =>
    resolveBotAvatarState({
      paused: bot.runState === "paused",
      pendingApproval:
        (conversation.kind === "solo" && conversation.pendingApprovals > 0) ||
        Object.values(approvals).some(
          (approval) => approval.groupId === groupId && approval.botId === bot.id && approval.status === "pending",
        ),
      working:
        turn?.current === bot.id ||
        messages.some(
          (message) => message.body.kind === "bot" && message.body.botId === bot.id && message.body.streaming,
        ),
    });
  const turns = turnsOf(messages);

  const anchor = useRef<Anchor | null>(null);
  const [expanded, setExpanded] = useState<{ groupId: GroupId; ids: ReadonlySet<MessageId> }>({
    groupId,
    ids: NO_OPEN_TOOLS,
  });
  // 换群就清空，切回来时全部收起。
  if (expanded.groupId !== groupId) setExpanded({ groupId, ids: NO_OPEN_TOOLS });
  const toggleTools: ToggleTools = (ids, open) =>
    setExpanded((current) => {
      const next = new Set(current.ids);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return { groupId: current.groupId, ids: next };
    });
  const oldest = edge?.oldest ?? null;
  const canLoadOlder = edge?.hasMore === true && older === "idle" && oldest !== null;
  const loadOlder = () => {
    if (oldest !== null) void onLoadOlder(groupId, oldest);
  };

  useLayoutEffect(() => {
    atBottom.current = true;
    setShowScroll(false);
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [groupId]);

  // 例行页的「改」和「新建」带着一句话跳过来。读完就把这次跳转的 state 换掉，刷新或后退回来都不再填一遍。
  const location = useLocation();
  const navigate = useNavigate();
  const prefill = prefillOf(location.state);
  useEffect(() => {
    if (prefill === null) return;
    setDraft(groupId, prefill);
    input.current?.focus();
    navigate(location.pathname, { replace: true, state: null });
  }, [prefill, groupId, location.pathname, navigate]);

  // 不列依赖、每次渲染都钉一遍：审批、交接推回来改的是卡片的高度，消息列表没变。用户刚滚过、滚动事件还没到时
  // 钉回去就把人拽回滚之前，这时只重记。
  useLayoutEffect(() => {
    const list = thread.current;
    if (list === null) return;
    if (anchor.current === null || !scrolledSince(list, anchor.current)) {
      if (atBottom.current) list.scrollTop = list.scrollHeight;
      else if (anchor.current !== null) keepInPlace(list, anchor.current);
    }
    anchor.current = anchorOf(list);
  });

  useEffect(() => {
    const list = thread.current;
    if (list !== null && canLoadOlder && list.scrollHeight <= list.clientHeight) void onLoadOlder(groupId, oldest);
  }, [messages, canLoadOlder, onLoadOlder, groupId, oldest]);

  // 群里每来一条消息 conversation 就换一次身份，这个 effect 也就跟着再跑一遍。不记一笔的话，拉取还在
  // 飞的那会儿同一个 Bot 会被问上好几遍。
  const asked = useRef(new Set<BotId>());
  useEffect(() => {
    for (const botId of memberIdsOf(conversation)) {
      if (skills[botId] !== undefined || asked.current.has(botId)) continue;
      asked.current.add(botId);
      void onLoadSkills(botId);
    }
  }, [conversation, skills, onLoadSkills]);

  const picker = pickerOff ? null : pickerOf(draft);
  // @ 是在多 Bot 群里点名派活，单 Bot 群里只有一个人会接，这个菜单就是噪音。
  const mentioned = picker?.kind === "mention" && team ? members.filter((bot) => bot.name.includes(picker.typing)) : [];
  // `/` 列的是这个群里全部成员会做的活，单 Bot 群也要出。
  const offered =
    picker?.kind === "slash"
      ? members
          .flatMap((bot) => (skills[bot.id] ?? []).map((skill) => ({ bot, skill })))
          .filter(({ skill }) => skill.name.includes(picker.typing))
      : [];

  const mention = (name: string) => {
    setDraft(groupId, draft.replace(MENTION, `@${name} `));
    input.current?.focus();
  };

  const insertSkill = (name: string) => {
    setDraft(
      groupId,
      draft.replace(SLASH, (_full, head: string) => `${head}/${name} `),
    );
    input.current?.focus();
  };

  const projectOfferActions: ProjectOfferActions = {
    decide: onDecideProjectOffer,
    revise: () => {
      setDraft(groupId, "改一下：");
      input.current?.focus();
    },
    open: onOpenProject,
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft(groupId, "");
    // 发失败了把字还回去，别让用户重打一遍。
    void onSend(groupId, text).catch((cause: unknown) => {
      setDraft(groupId, text);
      failed("消息没发出去，再试一次")(cause);
    });
  };

  return (
    <section className="chat" data-testid="chat">
      {team || lead === undefined ? (
        <header className={`chat-header${team ? " chat-header-team" : ""}`}>
          {team ? (
            <>
              <div className="chat-heading">
                <Users size={16} aria-hidden="true" />
                <b data-testid="chat-title">{conversation.task.title}</b>
                <span className="chat-sub" data-testid="chat-subtitle">
                  你 + {members.length} 个 Bot
                </span>
                {computerChoices === null ? null : <TeamComputers view={computerChoices} members={members} />}
              </div>
              <div className="chat-members" data-testid="chat-members">
                {members.map((bot) => (
                  <span className="chat-member" data-testid="chat-member" key={bot.id}>
                    <BotAvatar shape={bot.shape} hue={bot.hue} state={avatarStateOf(bot)} size="xs" />
                    {bot.name}
                    {conversation.chiefBotId === bot.id ? <em className="tag">首席</em> : null}
                    {conversation.task.currentBotId === bot.id ? <em className="tag">经手</em> : null}
                  </span>
                ))}
                {turn?.current ? (
                  <span className="chat-turn" data-testid="group-turn">
                    轮到 {bots[turn.current]?.name ?? turn.current}
                    {turn.next.length > 0 ? `，接着 ${turn.next.map((id) => bots[id]?.name ?? id).join("、")}` : null}
                  </span>
                ) : null}
              </div>
              {computerChoices === null ? null : <TeamComputerNotes view={computerChoices} members={members} />}
            </>
          ) : (
            <b data-testid="chat-title">Bot</b>
          )}
        </header>
      ) : (
        <BotHeader
          bot={lead}
          computerChoices={computerChoices}
          avatarState={avatarStateOf(lead)}
          panelOpen={botPanelOpen}
          onTogglePanel={onToggleBotPanel}
        />
      )}
      {conversation.kind === "team" ? (
        <TaskCard
          key={conversation.task.id}
          task={conversation.task}
          memberIds={conversation.botIds}
          bots={bots}
          onToggle={onToggleChecklist}
          onOpenDetail={onOpenTask}
        />
      ) : null}
      <div className="thread-shell">
        <div
          className="thread"
          data-testid="message-list"
          ref={thread}
          onScroll={() => {
            const list = thread.current;
            if (list === null) return;
            const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
            atBottom.current = distance < 24;
            setShowScroll(distance > list.clientHeight);
            anchor.current = anchorOf(list);
            if (canLoadOlder && list.scrollTop < LOAD_OLDER_PX) loadOlder();
          }}
        >
          {edge === undefined || messages.length === 0 ? null : older === "loading" ? (
            <p className="history-edge" data-testid="older-loading">
              正在加载更早的消息…
            </p>
          ) : older === "failed" ? (
            <p className="history-edge" role="alert" data-testid="older-failed">
              更早的消息没拉下来。{" "}
              <button type="button" className="ghost-button" data-testid="older-retry" onClick={loadOlder}>
                重试
              </button>
            </p>
          ) : edge.hasMore ? null : (
            <p className="history-edge" data-testid="history-start">
              已经是最早的消息了
            </p>
          )}
          {history === "failed" ? (
            <p className="empty" role="alert" data-testid="history-failed">
              历史消息没拉下来。{" "}
              <button type="button" className="ghost-button" data-testid="history-retry" onClick={onRetryHistory}>
                重试
              </button>
            </p>
          ) : messages.length === 0 && edge === undefined ? (
            <p className="empty" data-testid="history-loading">
              正在加载消息…
            </p>
          ) : messages.length === 0 ? (
            <p className="empty">
              {team ? "群建好了。直接说话大家轮流答，@ 谁就只派给谁。" : "建好了。今天把什么活交出去？"}
            </p>
          ) : null}
          {turns.map((turn, at) => (
            <div className="turn-group" key={turn.kind === "bot" ? (turn.items[0]?.id ?? turn.botId) : turn.message.id}>
              {needsTimeDivider(turn, turns[at - 1]) ? (
                <div className="time-divider" data-testid="time-divider">
                  {timeLabel(firstAt(turn))}
                </div>
              ) : null}
              <TurnView
                turn={turn}
                openTools={expanded.ids}
                onToggleTools={toggleTools}
                lookup={lookup}
                approvals={approvals}
                handoffs={handoffs}
                content={content}
                contentActions={contentActions}
                checklist={checklist}
                onDecide={onDecide}
                onDecideSkillOffer={onDecideSkillOffer}
                onDecidePreferenceOffer={onDecidePreferenceOffer}
                projectOfferActions={projectOfferActions}
                onInspectTool={onInspectTool}
                selectedToolId={inspectedToolId}
                showSource={team}
              />
            </div>
          ))}
        </div>
        {showScroll ? (
          <button
            type="button"
            className="scroll-to-bottom"
            data-testid="scroll-to-bottom"
            aria-label="回到底部"
            onClick={() => {
              const list = thread.current;
              if (list === null) return;
              list.scrollTop = list.scrollHeight;
              atBottom.current = true;
              setShowScroll(false);
            }}
          >
            <ArrowDown size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <form className="composer-area" onSubmit={submit}>
        {mentioned.length > 0 ? (
          <div className="mention-menu" data-testid="mention-menu">
            {mentioned.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className="menu-row"
                data-testid="mention-option"
                data-bot-name={bot.name}
                onClick={() => mention(bot.name)}
              >
                <BotAvatar shape={bot.shape} hue={bot.hue} size="xs" />
                {bot.name}
                {bot.tags.length > 0 ? <span className="menu-trail">{bot.tags.join("、")}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {offered.length > 0 ? (
          <div className="mention-menu" data-testid="skill-menu">
            {offered.map(({ bot, skill }) => (
              <button
                key={skill.id}
                type="button"
                className="menu-row"
                data-testid="skill-option"
                data-skill-name={skill.name}
                onClick={() => insertSkill(skill.name)}
              >
                <Sparkles size={14} aria-hidden="true" />
                {skill.name}
                {team ? <span className="menu-trail">{bot.name}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="composer">
          <ComposerTextarea
            inputRef={input}
            data-testid="composer-input"
            value={draft}
            placeholder={team ? `给 ${conversation.task.title} 发消息` : `给 ${lead?.name ?? "Bot"} 发消息`}
            aria-label="发消息"
            onChange={(e) => {
              setPickerOff(false);
              setDraft(groupId, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPickerOff(true);
            }}
          />
          <button type="submit" className="send-button" data-testid="composer-send" aria-label="发送">
            <SendHorizontal size={16} />
          </button>
        </div>
      </form>
    </section>
  );
};
