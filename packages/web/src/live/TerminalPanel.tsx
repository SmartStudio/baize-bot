import { useEffect, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { liveEndActions, type LiveInput, type LiveSession, type LiveUserEnd } from "@baize/shared";
import { reconnectDelay } from "../state/reconnect.js";
import { LIVE_TEXT, TERMINAL_TEXT, liveEndText } from "../components/messages/content.js";
import { resizeInput, termInputs } from "./term-input.js";
import { IGNORE, openLiveViewer, type LiveViewer } from "./viewer.js";

type Props = {
  session: LiveSession;
  // 收起面板，终端在电脑上接着跑；点了「关掉终端」也走这里，结束那一句由面板自己发。
  onDismiss: () => void;
};

// 状态和画面面板同一套：replaced 要人点「在这里看」才抢回来，network 断了按退避自己连。
type Conn = "connecting" | "live" | "reconnecting" | "replaced" | "ended";

const NOTICE: Record<Conn, string | null> = {
  connecting: TERMINAL_TEXT.connecting,
  live: null,
  reconnecting: TERMINAL_TEXT.reconnecting,
  replaced: TERMINAL_TEXT.replaced,
  ended: TERMINAL_TEXT.ended,
};

// xterm 只认具体颜色，从令牌上取当下算出来的值；取不到（测试环境、令牌没加载）就让 xterm 用它自己的默认色。
const themeOf = (host: HTMLElement) => {
  const style = getComputedStyle(host);
  const token = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined;
  const background = token("--code-bg");
  const foreground = token("--code-fg");
  const cursor = token("--accent");
  const selectionBackground = token("--accent-soft");
  return {
    ...(background === undefined ? {} : { background }),
    ...(foreground === undefined ? {} : { foreground }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(selectionBackground === undefined ? {} : { selectionBackground }),
  };
};

// 云电脑上的网页终端。字节只过这条 socket 和 xterm，不进 store、不进日志；电脑上留着最近一段输出，每次（重）连上整份补发。
export const TerminalPanel = ({ session, onDismiss }: Props) => {
  const [conn, setConn] = useState<Conn>("connecting");
  const [generation, setGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const viewerRef = useRef<LiveViewer | null>(null);

  const sendInput = (input: LiveInput) => viewerRef.current?.send({ t: "input", input });
  const sendSize = () => {
    const term = termRef.current;
    const input = term === null ? null : resizeInput(term.cols, term.rows);
    if (input !== null) sendInput(input);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(host).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: themeOf(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    const typed = term.onData((data) => {
      for (const input of termInputs(data)) sendInput(input);
    });
    const resized = term.onResize(({ cols, rows }) => {
      const input = resizeInput(cols, rows);
      if (input !== null) sendInput(input);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);
    term.focus();
    return () => {
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      viewerRef.current = openLiveViewer(session.liveId, {
        session: () => {
          failures = 0;
          setConn("live");
          sendSize();
        },
        // 整份回滚缓冲先清屏再写，不然重连一次屏上就叠一份旧输出。
        term: (bytes, replay) => {
          if (replay) termRef.current?.reset();
          termRef.current?.write(bytes);
        },
        frame: () => undefined,
        closed: (why) => {
          viewerRef.current = null;
          if (why === "replaced") return setConn("replaced");
          if (why !== "network") return setConn("ended");
          setConn("reconnecting");
          retry = setTimeout(connect, reconnectDelay(failures));
          failures += 1;
        },
      });
    };
    connect();
    return () => {
      if (retry !== null) clearTimeout(retry);
      viewerRef.current?.close();
      viewerRef.current = null;
    };
  }, [session.liveId, generation]);

  const attached = conn !== "replaced" && conn !== "ended";

  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.disableStdin = !attached;
    if (attached) term.focus();
  }, [attached]);

  // 断线重连的间隙里点关掉，也得送到电脑：临时连一条把这一句发完就关，不然终端要等到没人看的超时才收。
  const end = (action: LiveUserEnd) => {
    const viewer = viewerRef.current ?? openLiveViewer(session.liveId, IGNORE);
    viewer.send({ t: "end", action });
    if (viewer !== viewerRef.current) viewer.close();
    onDismiss();
  };

  const reclaim = () => {
    setConn("connecting");
    setGeneration((current) => current + 1);
  };

  const notice = NOTICE[conn];

  return (
    <div className="scrim live-scrim">
      <section
        className="dialog live-panel terminal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={TERMINAL_TEXT.title}
        data-testid="terminal-panel"
        data-live-id={session.liveId}
        data-state={conn}
      >
        <header className="dialog-head">
          <SquareTerminal size={20} aria-hidden="true" />
          <span>
            <b>{TERMINAL_TEXT.title}</b>
            <small>{TERMINAL_TEXT.note}</small>
          </span>
        </header>
        <div className={attached ? "terminal-screen" : "terminal-screen is-stale"}>
          <div ref={hostRef} className="terminal-host" data-testid="terminal-host" />
          {notice === null ? null : (
            <p className="live-notice" data-testid="terminal-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" data-testid="terminal-hide" onClick={onDismiss}>
            {LIVE_TEXT.hide}
          </button>
          {attached ? (
            liveEndActions(session.purpose).map((action) => (
              <button
                key={action}
                type="button"
                className="primary-button"
                data-testid="terminal-end"
                data-action={action}
                onClick={() => end(action)}
              >
                {liveEndText(session.purpose.kind, action)}
              </button>
            ))
          ) : conn === "replaced" ? (
            <button type="button" className="primary-button" data-testid="terminal-reclaim" onClick={reclaim}>
              {LIVE_TEXT.reclaim}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
};
