import { useEffect, useState } from "react";
import type { BotHue, BotId } from "@baize/shared";
import { Sidebar } from "../components/Sidebar.js";
import { ChatPanel } from "../components/ChatPanel.js";
import { BotSettingsPanel } from "../components/BotSettingsPanel.js";
import { AccountMenu } from "../components/AccountMenu.js";
import { SettingsWindow } from "../components/SettingsWindow.js";
import { useApp } from "../state/app.js";

type Overlay = "none" | "account" | "settings";

const FALLBACK: { name: string; tag: string; hue: BotHue } = { name: "Bot", tag: "", hue: "sky" };

export const MainWindow = () => {
  const { state, actions } = useApp();
  const [overlay, setOverlay] = useState<Overlay>("none");

  const ready = state.status === "ready" ? state : null;
  const selected = ready?.bots.find((item) => item.bot.id === ready.selectedBotId) ?? null;
  const groupId = selected?.groupId ?? null;
  const loaded = groupId !== null && ready !== null && ready.messages[groupId] !== undefined;

  useEffect(() => {
    if (groupId !== null && !loaded) void actions.loadMessages(groupId);
  }, [groupId, loaded, actions]);

  if (!ready) return null;

  const lookup = (botId: BotId) => {
    const found = ready.bots.find((item) => item.bot.id === botId);
    return found ? { name: found.bot.name, tag: found.bot.tag, hue: found.bot.hue } : FALLBACK;
  };

  return (
    <div className="window" data-testid="main-window">
      <Sidebar
        bots={ready.bots}
        selectedBotId={ready.selectedBotId}
        user={ready.user}
        onSelect={(botId: BotId) => actions.selectBot(botId)}
        onCreate={() => void actions.createBot()}
        onOpenAccount={() => setOverlay(overlay === "account" ? "none" : "account")}
      />
      {selected && groupId !== null ? (
        <>
          <ChatPanel
            bot={selected.bot}
            groupId={groupId}
            messages={ready.messages[groupId] ?? []}
            lookup={lookup}
            onSend={actions.sendMessage}
          />
          <BotSettingsPanel bot={selected.bot} onChange={actions.updateBot} />
        </>
      ) : (
        <section className="chat">
          <p className="empty">今天把什么活交出去？先建一个 Bot。</p>
        </section>
      )}
      {overlay === "account" ? (
        <AccountMenu
          user={ready.user}
          onOpenSettings={() => setOverlay("settings")}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
      {overlay === "settings" ? (
        <SettingsWindow
          user={ready.user}
          settings={ready.settings}
          onChange={actions.updateSettings}
          onLogout={() => void actions.logout()}
          onClose={() => setOverlay("none")}
        />
      ) : null}
    </div>
  );
};
