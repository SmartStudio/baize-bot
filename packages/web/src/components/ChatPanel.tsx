import { useEffect, useRef, useState } from "react";
import { Plus, SendHorizontal, Sparkles, Users } from "lucide-react";
import type { Bot, BotId, ChecklistItem, GroupId, Message, Skill } from "@baize/shared";
import {
  MessageView,
  type ApprovalTable,
  type BotLookup,
  type DecideApproval,
  type DecideSkillOffer,
  type HandoffTable,
} from "./messages/MessageView.js";
import { BotAvatar } from "./BotAvatar.js";
import { TaskCard } from "./TaskCard.js";
import { memberIdsOf, type Conversation } from "../state/app.js";

type Props = {
  conversation: Conversation;
  bots: Record<BotId, Bot>;
  messages: Message[];
  lookup: BotLookup;
  approvals: ApprovalTable;
  handoffs: HandoffTable;
  skills: Record<BotId, Skill[]>;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
  onDecide: DecideApproval;
  onDecideSkillOffer: DecideSkillOffer;
  onLoadSkills: (botId: BotId) => Promise<void>;
  onToggleChecklist: (checklist: ChecklistItem[]) => void;
  onOpenTask: () => void;
};

// 单 Bot 群没有清单。写成字面量的话每次渲染都是新身份，白让 MessageView 重画一遍。
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

export const ChatPanel = ({
  conversation,
  bots,
  messages,
  lookup,
  approvals,
  handoffs,
  skills,
  onSend,
  onDecide,
  onDecideSkillOffer,
  onLoadSkills,
  onToggleChecklist,
  onOpenTask,
}: Props) => {
  const [draft, setDraft] = useState("");
  const [pickerOff, setPickerOff] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const groupId = conversation.groupId;
  const team = conversation.kind === "team";
  // 交接卡上的清单指针要指出那一项的正文。单 Bot 群没有任务卡，也就没有清单可指。
  const checklist = conversation.kind === "team" ? conversation.task.checklist : NO_CHECKLIST;
  const members = memberIdsOf(conversation)
    .map((botId) => bots[botId])
    .filter((bot): bot is Bot => bot !== undefined);
  const lead = members[0];

  // 盯的是数组本身而不是条数：流式回复只让最后一条变长，条数一直不变，盯条数就跟不住。
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
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
      <header className="chat-header">
        {team ? (
          <>
            <Users size={16} aria-hidden="true" />
            <b data-testid="chat-title">{conversation.task.title}</b>
            <span className="chat-sub" data-testid="chat-subtitle">
              主题任务 {conversation.task.number} · 你 + {members.length} 个 Bot
            </span>
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
      <div className="thread" data-testid="message-list">
        {messages.length === 0 ? (
          <p className="empty">
            {team ? "群建好了。@ 一个 Bot 把这件事交出去。" : "建好了，桌面也开好了。今天把什么活交出去？"}
          </p>
        ) : null}
        {messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            lookup={lookup}
            approvals={approvals}
            handoffs={handoffs}
            checklist={checklist}
            onDecide={onDecide}
            onDecideSkillOffer={onDecideSkillOffer}
            showSource={team}
          />
        ))}
        <div ref={bottom} />
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
            placeholder={team ? "在群里说话，@ 一个 Bot 派活" : `给${lead?.name ?? "Bot"}发消息`}
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
