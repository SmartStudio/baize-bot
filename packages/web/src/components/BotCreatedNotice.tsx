import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Bot } from "@baize/shared";

const SHOWN_MS = 10_000;

type Undo = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

type Props = { bot: Bot; onUndo: () => Promise<void>; onClose: () => void };

// 点「新 Bot」不问名字直接建，建错了在这里一步撤回。撤销失败时不自动收起，免得人以为撤掉了。
export const BotCreatedNotice = ({ bot, onUndo, onClose }: Props) => {
  const [undo, setUndo] = useState<Undo>({ status: "idle" });
  const idle = undo.status === "idle";
  useEffect(() => {
    if (!idle) return;
    const timer = setTimeout(onClose, SHOWN_MS);
    return () => clearTimeout(timer);
  }, [idle, onClose]);

  const run = () => {
    setUndo({ status: "busy" });
    onUndo().catch((cause: unknown) =>
      setUndo({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
    );
  };

  return (
    <div className="oauth-notice" role="status" data-testid="bot-created-notice">
      <span>{undo.status === "failed" ? `没撤销成：${undo.message}` : `建好了 ${bot.name}`}</span>
      <button
        type="button"
        className="link-button"
        data-testid="bot-created-undo"
        disabled={undo.status === "busy"}
        onClick={run}
      >
        撤销
      </button>
      <button type="button" className="icon-button" aria-label="关掉提示" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
};
