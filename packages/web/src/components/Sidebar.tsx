import { useState } from "react";
import { ArrowRightLeft, Hand, Plus, Search, Settings as SettingsIcon, Sun } from "lucide-react";
import type { Bot, BotId, GroupId, User } from "@baize/shared";
import { BotAvatar } from "./BotAvatar.js";
import { activityOf, previewOf, timeOf } from "./messages/preview.js";
import { memberIdsOf, type Conversation, type GroupTurn } from "../state/app.js";

type Props = {
  conversations: Conversation[];
  bots: Record<BotId, Bot>;
  groupTurns: Record<GroupId, GroupTurn>;
  selectedGroupId: GroupId | null;
  user: User;
  onSelectToday: () => void;
  onSelect: (groupId: GroupId) => void;
  onCreateBot: () => void;
  onOpenAccount: () => void;
};

const membersOf = (conversation: Conversation, bots: Record<BotId, Bot>): Bot[] =>
  memberIdsOf(conversation)
    .map((botId) => bots[botId])
    .filter((bot): bot is Bot => bot !== undefined);

const ConversationItem = ({
  conversation,
  bots,
  turn,
  selected,
  onSelect,
}: {
  conversation: Conversation;
  bots: Record<BotId, Bot>;
  turn: GroupTurn | undefined;
  selected: boolean;
  onSelect: (groupId: GroupId) => void;
}) => {
  const members = membersOf(conversation, bots);
  const lead = members[0];
  const team = conversation.kind === "team";
  const title = team ? conversation.task.title : (lead?.name ?? "Bot");
  const current = team && conversation.task.currentBotId !== null ? bots[conversation.task.currentBotId] : undefined;
  const working = activityOf(conversation.lastMessage) === "working";
  const hasBadges = conversation.pendingApprovals > 0 || conversation.pendingHandoffs > 0 || working;
  return (
    <li>
      <button
        type="button"
        className={`bot-item${selected ? " is-selected" : ""}`}
        data-testid={team ? "group-item" : "bot-item"}
        data-bot-name={team ? undefined : lead?.name}
        data-group-title={team ? title : undefined}
        onClick={() => onSelect(conversation.groupId)}
      >
        {team ? (
          <span className="avatar-stack" aria-hidden="true">
            {members.slice(0, 2).map((bot) => (
              <BotAvatar key={bot.id} name={bot.name} hue={bot.hue} size="sm" />
            ))}
          </span>
        ) : (
          <BotAvatar name={lead?.name ?? "Bot"} hue={lead?.hue ?? "sky"} />
        )}
        <span className="bot-item-body">
          <span className="bot-item-top">
            <b>{title}</b>
            {!team && lead?.tag ? <em className="tag">{lead.tag}</em> : null}
            <span className="time">{conversation.lastMessage ? timeOf(conversation.lastMessage) : "刚刚"}</span>
          </span>
          {hasBadges ? (
            <span className="bot-item-badges">
              {conversation.pendingApprovals > 0 ? (
                <span className="badge badge-pending" data-testid="bot-pending">
                  <Hand size={13} aria-hidden="true" />
                  等你点头 {conversation.pendingApprovals}
                </span>
              ) : null}
              {/* 等 Bot 确认的不用你动手，压在「等你点头」下面一档，两个角标并排时你先看到该你做的那个。 */}
              {conversation.pendingHandoffs > 0 ? (
                <span className="badge badge-await-bot" data-testid="bot-handoff">
                  <ArrowRightLeft size={13} aria-hidden="true" />等 Bot 确认 {conversation.pendingHandoffs}
                </span>
              ) : null}
              {working ? (
                <span className="badge badge-working" data-testid="bot-working">
                  干活中
                </span>
              ) : null}
            </span>
          ) : null}
          {team ? (
            <span className="bot-item-sub" data-testid="group-handler">
              {turn?.current
                ? `${bots[turn.current]?.name ?? turn.current}正在说`
                : current
                  ? `${current.name} 经手`
                  : "待派活"}
            </span>
          ) : null}
          <span className="bot-item-preview">
            {conversation.lastMessage
              ? previewOf(conversation.lastMessage.body)
              : team
                ? "群建好了，还没派活。"
                : "刚建好，还没派活。"}
          </span>
        </span>
      </button>
    </li>
  );
};

export const Sidebar = ({
  conversations,
  bots,
  groupTurns,
  selectedGroupId,
  user,
  onSelectToday,
  onSelect,
  onCreateBot,
  onOpenAccount,
}: Props) => {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  // 搜的是一条对话的全部可见文字：单 Bot 群是那个 Bot，多 Bot 群是标题和所有成员。
  const haystackOf = (conversation: Conversation): string => {
    const members = membersOf(conversation, bots)
      .map((bot) => `${bot.name} ${bot.tag} ${bot.description}`)
      .join(" ");
    return conversation.kind === "team" ? `${conversation.task.title} ${members}` : members;
  };
  const shown = needle ? conversations.filter((c) => haystackOf(c).toLowerCase().includes(needle)) : conversations;
  const solo = shown.filter((c) => c.kind === "solo");
  const team = shown.filter((c) => c.kind === "team");

  const item = (conversation: Conversation) => (
    <ConversationItem
      key={conversation.groupId}
      conversation={conversation}
      bots={bots}
      turn={groupTurns[conversation.groupId]}
      selected={conversation.groupId === selectedGroupId}
      onSelect={onSelect}
    />
  );

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="titlebar">
        <span className="lights" aria-hidden="true">
          <i /> <i /> <i />
        </span>
        <button
          type="button"
          className="icon-button"
          data-testid="new-menu"
          aria-label="新建"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Plus size={16} />
        </button>
      </header>
      {menuOpen ? (
        <>
          <button type="button" className="menu-scrim" aria-label="关掉菜单" onClick={() => setMenuOpen(false)} />
          <div className="new-menu" data-testid="new-menu-popup">
            <button
              type="button"
              className="menu-row"
              data-testid="new-bot"
              onClick={() => {
                setMenuOpen(false);
                onCreateBot();
              }}
            >
              <Plus size={16} aria-hidden="true" />
              新建 Bot
            </button>
          </div>
        </>
      ) : null}
      <div className="search">
        <Search size={16} aria-hidden="true" />
        <input
          data-testid="sidebar-search"
          value={query}
          placeholder="搜索"
          aria-label="搜索 Bot"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <button
        type="button"
        className={`today-nav${selectedGroupId === null ? " is-selected" : ""}`}
        data-testid="today-nav"
        aria-current={selectedGroupId === null ? "page" : undefined}
        onClick={onSelectToday}
      >
        <Sun size={17} aria-hidden="true" />
        今天
      </button>
      <div className="conversation-lists">
        <p className="list-label">Bot</p>
        <ul className="bot-list" data-testid="bot-list">
          {solo.map(item)}
        </ul>
        {team.length > 0 ? (
          <>
            <p className="list-label">群</p>
            <ul className="bot-list" data-testid="group-list">
              {team.map(item)}
            </ul>
          </>
        ) : null}
      </div>
      <footer className="sidebar-footer">
        <button type="button" className="account-button" data-testid="account-button" onClick={onOpenAccount}>
          <span className="avatar avatar-md avatar-user" aria-hidden="true">
            {[...user.name][0]}
          </span>
          <span className="account-body">
            <b>{user.name}</b>
            <small>{user.email}</small>
          </span>
          <SettingsIcon size={16} aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
};
