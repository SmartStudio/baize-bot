import { useEffect, useRef, useState } from "react";
import { ArrowDown, Plus, SendHorizontal, Sparkles, Users } from "lucide-react";
import type { Bot, BotId, ChecklistItem, GroupId, Message, MessageId, Skill } from "@baize/shared";
import {
  TurnView,
  type ApprovalTable,
  type BotLookup,
  type DecideApproval,
  type DecideSkillOffer,
  type HandoffTable,
  type InspectTool,
} from "./messages/MessageView.js";
import { turnsOf, type Turn } from "./messages/turns.js";
import { BotAvatar } from "./BotAvatar.js";
import { TaskCard } from "./TaskCard.js";
import { memberIdsOf, type Conversation, type GroupTurn } from "../state/app.js";
import type { ContentBook } from "../state/types.js";
import type { ContentActions } from "./messages/DraftCards.js";

type Props = {
  conversation: Conversation;
  turn: GroupTurn | undefined;
  bots: Record<BotId, Bot>;
  messages: Message[];
  lookup: BotLookup;
  approvals: ApprovalTable;
  handoffs: HandoffTable;
  content: ContentBook;
  contentActions: ContentActions;
  skills: Record<BotId, Skill[]>;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: DecideApproval;
  onDecideSkillOffer: DecideSkillOffer;
  onInspectTool: InspectTool;
  inspectedToolId: MessageId | null;
  onLoadSkills: (botId: BotId) => Promise<void>;
  onToggleChecklist: (checklist: ChecklistItem[]) => void;
  onOpenTask: () => void;
};

// 单 Bot 群没有清单。写成字面量的话每次渲染都是新身份，白让回合组件重画一遍。
const NO_CHECKLIST: ChecklistItem[] = [];

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
  lookup,
  approvals,
  handoffs,
  content,
  contentActions,
  skills,
  onSend,
  onDecide,
  onDecideSkillOffer,
  onInspectTool,
  inspectedToolId,
  onLoadSkills,
  onToggleChecklist,
  onOpenTask,
}: Props) => {
  const [draft, setDraft] = useState("");
  const [pickerOff, setPickerOff] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showScroll, setShowScroll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const groupId = conversation.groupId;
  const team = conversation.kind === "team";
  // 交接卡上的清单指针要指出那一项的正文。单 Bot 群没有任务卡，也就没有清单可指。
  const checklist = conversation.kind === "team" ? conversation.task.checklist : NO_CHECKLIST;
  const members = memberIdsOf(conversation)
    .map((botId) => bots[botId])
    .filter((bot): bot is Bot => bot !== undefined);
  const lead = members[0];
  const turns = turnsOf(messages);

  useEffect(() => {
    atBottom.current = true;
    setShowScroll(false);
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [groupId]);

  // 流式回复只让最后一条变长，条数不变；用户向上读历史时不能抢走滚动位置。
  useEffect(() => {
    if (thread.current && atBottom.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages, groupId]);

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
    setDraft(draft.replace(MENTION, `@${name} `));
    input.current?.focus();
  };

  const insertSkill = (name: string) => {
    setDraft(draft.replace(SLASH, (_full, head: string) => `${head}/${name} `));
    input.current?.focus();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    // 发失败了把字还回去，别让用户重打一遍。
    void onSend(groupId, text).catch(() => setDraft(text));
  };

  return (
    <section className="chat" data-testid="chat">
      <header className={`chat-header${team ? " chat-header-team" : ""}`}>
        {team ? (
          <>
            <div className="chat-heading">
              <Users size={16} aria-hidden="true" />
              <b data-testid="chat-title">{conversation.task.title}</b>
              <span className="chat-sub" data-testid="chat-subtitle">
                你 + {members.length} 个 Bot
              </span>
            </div>
            <div className="chat-members" data-testid="chat-members">
              {members.map((bot) => (
                <span className="chat-member" data-testid="chat-member" key={bot.id}>
                  <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
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
          </>
        ) : (
          <>
            <BotAvatar name={lead?.name ?? "Bot"} hue={lead?.hue ?? "sky"} size="sm" />
            <b data-testid="chat-title">{lead?.name ?? "Bot"}</b>
            {lead?.tag ? <em className="tag">{lead.tag}</em> : null}
          </>
        )}
      </header>
      {conversation.kind === "team" ? (
        <TaskCard
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
          }}
        >
          {messages.length === 0 ? (
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
                lookup={lookup}
                approvals={approvals}
                handoffs={handoffs}
                content={content}
                contentActions={contentActions}
                checklist={checklist}
                onDecide={onDecide}
                onDecideSkillOffer={onDecideSkillOffer}
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
                <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
                {bot.name}
                {bot.tag ? <span className="menu-trail">{bot.tag}</span> : null}
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
          <span className="icon-button" aria-hidden="true">
            <Plus size={16} />
          </span>
          <input
            ref={input}
            data-testid="composer-input"
            value={draft}
            placeholder={team ? `给 ${conversation.task.title} 发消息` : `给 ${lead?.name ?? "Bot"} 发消息`}
            aria-label="发消息"
            onChange={(e) => {
              setPickerOff(false);
              setDraft(e.target.value);
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
