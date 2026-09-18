import { useEffect, useRef, useState } from "react";
import { Plus, SendHorizontal } from "lucide-react";
import type { Bot, GroupId, Message } from "@baize/shared";
import { MessageView, type BotLookup } from "./messages/MessageView.js";
import { BotAvatar } from "./BotAvatar.js";

type Props = {
  bot: Bot;
  groupId: GroupId;
  messages: Message[];
  lookup: BotLookup;
  onSend: (groupId: GroupId, text: string) => Promise<void>;
};

export const ChatPanel = ({ bot, groupId, messages, lookup, onSend }: Props) => {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, groupId]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0) return;
    // 发失败了得把字还给用户，所以等 onSend 落地再清。
    void onSend(groupId, text).then(() => setDraft(""));
  };

  return (
    <section className="chat" data-testid="chat">
      <header className="chat-header">
        <BotAvatar name={bot.name} hue={bot.hue} size="sm" />
        <b data-testid="chat-title">{bot.name}</b>
        {bot.tag ? <em className="tag">{bot.tag}</em> : null}
      </header>
      <div className="thread" data-testid="message-list">
        {messages.length === 0 ? <p className="empty">建好了，桌面也开好了。今天把什么活交出去？</p> : null}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} lookup={lookup} />
        ))}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        <span className="icon-button" aria-hidden="true">
          <Plus size={16} />
        </span>
        <input
          data-testid="composer-input"
          value={draft}
          placeholder={`给${bot.name}发消息`}
          aria-label="发消息"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="send-button" data-testid="composer-send" aria-label="发送">
          <SendHorizontal size={16} />
        </button>
      </form>
    </section>
  );
};
