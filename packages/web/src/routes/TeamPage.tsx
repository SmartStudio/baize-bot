import { useCallback, useRef, useState } from "react";
import { ArrowRightLeft, BookOpen, Download, Hand, MessageSquare, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import type { Bot, BotId } from "@baize/shared";
import { BotAvatar } from "../components/BotAvatar.js";
import { BrandBookOpener } from "../components/BrandBookDialog.js";
import { ImportDialog } from "../components/ImportDialog.js";
import { activityOf, previewOf } from "../components/messages/preview.js";
import type { Conversation } from "../state/app.js";
import { pathOf } from "./screen.js";

type Solo = Extract<Conversation, { kind: "solo" }>;

type Props = {
  bots: Record<BotId, Bot>;
  conversations: Conversation[];
  onCreateBot: () => void;
};

const BotCard = ({ bot, solo, projects }: { bot: Bot; solo: Solo | undefined; projects: string[] }) => {
  const working = activityOf(solo?.lastMessage ?? null) === "working";
  const pendingApprovals = solo?.pendingApprovals ?? 0;
  const pendingHandoffs = solo?.pendingHandoffs ?? 0;
  const hasBadges = pendingApprovals > 0 || pendingHandoffs > 0 || working;
  return (
    <article className="team-bot" data-testid="team-bot" data-bot-name={bot.name}>
      <div className="team-bot-head">
        <BotAvatar name={bot.name} hue={bot.hue} />
        <span className="team-bot-who">
          <b>{bot.name}</b>
          <small>{projects.length > 0 ? `在 ${projects.join("、")}` : "还没进项目"}</small>
        </span>
      </div>
      {bot.description.length > 0 ? <p className="team-bot-desc">{bot.description}</p> : null}
      {bot.tags.length > 0 ? (
        <div className="team-bot-tags">
          {bot.tags.map((tag) => (
            <em className="tag" key={tag}>
              {tag}
            </em>
          ))}
        </div>
      ) : null}
      {hasBadges ? (
        <div className="project-badges">
          {pendingApprovals > 0 ? (
            <span className="badge badge-pending" data-testid="bot-pending">
              <Hand size={13} aria-hidden="true" />
              等你点头 {pendingApprovals}
            </span>
          ) : null}
          {pendingHandoffs > 0 ? (
            <span className="badge badge-await-bot" data-testid="bot-handoff">
              <ArrowRightLeft size={13} aria-hidden="true" />等 Bot 确认 {pendingHandoffs}
            </span>
          ) : null}
          {working ? (
            <span className="badge badge-working" data-testid="bot-working">
              干活中
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="team-bot-foot">
        <small className="team-bot-preview">
          {solo?.lastMessage ? previewOf(solo.lastMessage.body) : "刚建好，还没派活。"}
        </small>
        {solo === undefined ? null : (
          <Link
            to={pathOf({ kind: "group", groupId: solo.groupId })}
            className="ghost-button"
            data-testid="team-bot-chat"
          >
            <MessageSquare size={14} aria-hidden="true" />
            单聊
          </Link>
        )}
      </div>
    </article>
  );
};

export const TeamPage = ({ bots, conversations, onCreateBot }: Props) => {
  const [importing, setImporting] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const closeImport = useCallback(() => {
    setImporting(false);
    importButton.current?.focus();
  }, []);
  const members = Object.values(bots).filter((bot) => bot.role === "member");
  const projectsOf = (botId: BotId): string[] =>
    conversations.flatMap((c) => (c.kind === "team" && c.botIds.includes(botId) ? [c.task.title] : []));
  return (
    <main className="page" data-testid="team-page">
      <header className="page-head">
        <div>
          <h2>团队</h2>
          <p>派活你不用管。点开一个 Bot 就是和它单聊，想让它以后怎么做，说一句就行。</p>
        </div>
        <BrandBookOpener className="ghost-button" testId="brand-open">
          <BookOpen size={14} aria-hidden="true" />
          品牌手册
        </BrandBookOpener>
        <button
          ref={importButton}
          type="button"
          className="ghost-button"
          data-testid="import-bot"
          onClick={() => setImporting(true)}
        >
          <Download size={14} aria-hidden="true" />
          从链接导入
        </button>
        <button type="button" className="ghost-button" data-testid="new-bot" onClick={onCreateBot}>
          <Plus size={14} aria-hidden="true" />新 Bot
        </button>
      </header>
      <section className="blk">
        <div className="blk-h">
          <h3>常驻队员</h3>
          <span>{members.length} 个</span>
        </div>
        <div className="team-bots">
          {members.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              solo={conversations.find((c): c is Solo => c.kind === "solo" && c.botId === bot.id)}
              projects={projectsOf(bot.id)}
            />
          ))}
        </div>
      </section>
      {importing ? <ImportDialog onClose={closeImport} /> : null}
    </main>
  );
};
