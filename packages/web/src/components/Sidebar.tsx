import { useState } from "react";
import { Plus, Search, Settings as SettingsIcon } from "lucide-react";
import type { BotId, User } from "@baize/shared";
import type { BotListItem } from "../api/types.js";
import { BotAvatar } from "./BotAvatar.js";
import { previewOf, timeOf } from "./messages/preview.js";

type Props = {
  bots: BotListItem[];
  selectedBotId: BotId | null;
  user: User;
  onSelect: (botId: BotId) => void;
  onCreate: () => void;
  onOpenAccount: () => void;
};

export const Sidebar = ({ bots, selectedBotId, user, onSelect, onCreate, onOpenAccount }: Props) => {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? bots.filter((item) => `${item.bot.name} ${item.bot.tag} ${item.bot.description}`.toLowerCase().includes(needle))
    : bots;

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="titlebar">
        <span className="lights" aria-hidden="true">
          <i /> <i /> <i />
        </span>
        <button type="button" className="icon-button" data-testid="new-bot" onClick={onCreate} aria-label="新建 Bot">
          <Plus size={16} />
        </button>
      </header>
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
      <p className="list-label">Bot</p>
      <ul className="bot-list" data-testid="bot-list">
        {shown.map((item) => (
          <li key={item.bot.id}>
            <button
              type="button"
              className={`bot-item${item.bot.id === selectedBotId ? " is-selected" : ""}`}
              data-testid="bot-item"
              data-bot-name={item.bot.name}
              onClick={() => onSelect(item.bot.id)}
            >
              <BotAvatar name={item.bot.name} hue={item.bot.hue} />
              <span className="bot-item-body">
                <span className="bot-item-top">
                  <b>{item.bot.name}</b>
                  {item.bot.tag ? <em className="tag">{item.bot.tag}</em> : null}
                  <span className="time">{item.lastMessage ? timeOf(item.lastMessage) : "刚刚"}</span>
                </span>
                <span className="bot-item-preview">
                  {item.lastMessage ? previewOf(item.lastMessage.body) : "刚建好，还没派活。"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <footer className="sidebar-footer">
        <button type="button" className="account-button" data-testid="account-button" onClick={onOpenAccount}>
          <span className="avatar avatar-md avatar-user" aria-hidden="true">
            {[...user.name][0]}
          </span>
          <span className="account-body">
            <b>{user.name}</b>
            <small>{user.teamName}</small>
          </span>
          <SettingsIcon size={16} aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
};
