import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { BotId } from "@baize/shared";
import { useApp } from "../state/app.js";
import { templateFromLink } from "./shareLink.js";
import { trapTab } from "./trapTab.js";

// 导入只 POST 一次。建好之后的插件同步单独成段，失败了只重试同步，Bot 已经在团队里了。
type Request =
  | { kind: "idle" }
  | { kind: "failed"; message: string }
  | { kind: "importing" }
  | { kind: "syncing"; botId: BotId }
  | { kind: "sync_failed"; botId: BotId };

export const ImportDialog = ({ onClose }: { onClose: () => void }) => {
  const { actions } = useApp();
  const [link, setLink] = useState("");
  const [request, setRequest] = useState<Request>({ kind: "idle" });
  const input = useRef<HTMLTextAreaElement>(null);
  const started = request.kind === "importing" || request.kind === "syncing" || request.kind === "sync_failed";
  const progress =
    request.kind === "importing" ? "正在导入…" : request.kind === "syncing" ? "已导入，正在同步插件…" : "";
  // 关掉之后在途的导入和同步照样落进全局状态，但不能再替这个弹窗收尾：TeamPage 的 onClose 关的是当时开着的那一个。
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (started) return;
    const reading = templateFromLink(link);
    if (reading.kind === "too_long") {
      setRequest({ kind: "failed", message: "链接太长，不像白泽的分享链接" });
      return;
    }
    if (reading.kind === "unrecognized") {
      setRequest({ kind: "failed", message: "认不出这条链接，确认是白泽分享出来的整条链接" });
      return;
    }
    setRequest({ kind: "importing" });
    let botId: BotId | undefined;
    try {
      botId = await actions.importBot(reading.template);
    } catch {
      if (alive.current) setRequest({ kind: "failed", message: "没导入成，再试一次" });
      return;
    }
    if (botId === undefined) return;
    if (reading.template.plugins.length > 0) await syncTools(botId);
    else if (alive.current) onClose();
  };

  const syncTools = async (botId: BotId) => {
    if (alive.current) setRequest({ kind: "syncing", botId });
    try {
      await actions.syncBotTools(botId);
      if (alive.current) onClose();
    } catch {
      if (alive.current) setRequest({ kind: "sync_failed", botId });
    }
  };

  return (
    <div className="scrim" data-testid="import-dialog">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="从链接导入"
        aria-busy={progress !== ""}
        tabIndex={-1}
        onSubmit={submit}
        onKeyDown={trapTab}
      >
        <header className="dialog-head">
          <span>
            <b>从链接导入</b>
            <small>导入的 Bot 先进团队，不进项目。它要用的插件得你自己再授权一次</small>
          </span>
          <button type="button" className="icon-button edit-bot-close" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <label className="field">
          <span>粘贴分享链接</span>
          <textarea
            ref={input}
            data-testid="import-link"
            rows={3}
            value={link}
            readOnly={started}
            onChange={(event) => {
              if (started) return;
              setLink(event.target.value);
              setRequest({ kind: "idle" });
            }}
          />
        </label>
        <p className="dialog-note" role="status" aria-live="polite">
          {progress}
        </p>
        {request.kind === "failed" ? (
          <p className="edit-bot-error" role="alert">
            {request.message}
          </p>
        ) : null}
        {request.kind === "sync_failed" ? (
          <p className="edit-bot-error" role="alert">
            已导入，已经在团队里了。它的插件还没同步过来，再同步一次
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            取消
          </button>
          {request.kind === "syncing" || request.kind === "sync_failed" ? (
            <button
              type="button"
              className="primary-button"
              data-testid="import-retry-tools"
              aria-disabled={request.kind === "syncing"}
              onClick={() => {
                if (request.kind === "sync_failed") void syncTools(request.botId);
              }}
            >
              同步插件
            </button>
          ) : (
            <button
              type="submit"
              className="primary-button"
              data-testid="import-go"
              disabled={!started && link.trim().length === 0}
              aria-disabled={started}
            >
              {request.kind === "importing" ? "导入中…" : "导入"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
