import { useEffect, useRef, useState } from "react";
import { Globe, MonitorUp } from "lucide-react";
import { liveEndActions, type ComputerKind, type LiveInput, type LiveSession, type LiveUserEnd } from "@baize/shared";
import { useApp } from "../state/app.js";
import { reconnectDelay } from "../state/reconnect.js";
import { LIVE_TEXT, PLATFORM, beforeChinese, computerName, liveEndText } from "../components/messages/content.js";
import {
  createClickCounter,
  createMoveCoalescer,
  keyInput,
  pointerInput,
  textInputs,
  wheelInput,
  type MoveCoalescer,
} from "./input.js";
import { openLiveViewer, type LiveSink, type LiveViewer } from "./viewer.js";

const IGNORE: LiveSink = { session: () => undefined, frame: () => undefined, closed: () => undefined };

// 宿主按 liveId 给 key：换了画面就是另一块面板，连接、帧、地址栏都从头来。
type Props = {
  session: LiveSession;
  // 面板该收起了：点了结束按钮，或者用户在「别处打开了」「结束了」之后点收起。结束那一句由面板自己发。
  onDismiss: () => void;
};

// connecting 是还没收到第一条报文；live 之后断网叫 reconnecting，按退避自己连回来。
// replaced 是被同一台电脑上的另一个观看者顶掉了，要人点「在这里看」才抢回来，不然两处会来回顶。
type Conn = "connecting" | "live" | "reconnecting" | "replaced" | "ended";

// 电脑上一页的实时画面。会话在 ContentBook.live 里就挂着，不在就由宿主卸掉；socket 只活在这个组件里。
export const LivePanel = ({ session, onDismiss }: Props) => {
  const { state } = useApp();
  const computer = state.status === "ready" ? state.content.computers[session.computerId] : undefined;
  // 查不到电脑按远程算：不给「到本机窗口操作」，修饰键按 Linux 换。
  const target: ComputerKind = computer?.kind ?? "remote";

  const [conn, setConn] = useState<Conn>("connecting");
  const [generation, setGeneration] = useState(0);
  // 地址栏取两路里后到的那个：画面连接上的会话头，和推送更新的会话。
  const [origin, setOrigin] = useState(session.origin);
  const [pushedOrigin, setPushedOrigin] = useState(session.origin);
  if (pushedOrigin !== session.origin) {
    setPushedOrigin(session.origin);
    setOrigin(session.origin);
  }
  const [hasFrame, setHasFrame] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const viewerRef = useRef<LiveViewer | null>(null);
  const movesRef = useRef<MoveCoalescer | null>(null);
  const [countClicks] = useState(() => createClickCounter());
  const pressClicks = useRef(1);

  const sendInput = (input: LiveInput) => viewerRef.current?.send({ t: "input", input });

  useEffect(() => {
    movesRef.current = createMoveCoalescer((input) => viewerRef.current?.send({ t: "input", input }));
    return () => {
      movesRef.current = null;
    };
  }, []);

  useEffect(() => {
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let latest: Blob | null = null;
    let drawing = false;
    // 只画最新一帧：解码慢于来帧时，中间的帧直接跳过。
    const pump = () => {
      const blob = latest;
      latest = null;
      if (blob === null) return;
      drawing = true;
      createImageBitmap(blob)
        .then((bitmap) => {
          const canvas = canvasRef.current;
          if (canvas === null) return bitmap.close();
          if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
          if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          setHasFrame(true);
        })
        .catch(() => undefined)
        .finally(() => {
          drawing = false;
          pump();
        });
    };
    const connect = () => {
      viewerRef.current = openLiveViewer(session.liveId, {
        session: (next) => {
          failures = 0;
          setConn("live");
          setOrigin(next.origin);
        },
        frame: (jpeg) => {
          failures = 0;
          setConn("live");
          latest = jpeg;
          if (!drawing) pump();
        },
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // React 的 onWheel 是被动监听，拦不住页面跟着滚，只能自己挂。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      movesRef.current?.flush();
      viewerRef.current?.send({ t: "input", input: wheelInput(event, canvas, target) });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [target]);

  useEffect(() => keysRef.current?.focus(), []);

  const pointer = (phase: "move" | "down" | "up", event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    if (phase === "move") return movesRef.current?.move(pointerInput("move", event.nativeEvent, canvas, target));
    // 后退、前进这类侧键协议里没有，不发。
    if (event.button > 2) return;
    movesRef.current?.flush();
    if (phase === "down") {
      event.preventDefault();
      keysRef.current?.focus();
      canvas.setPointerCapture(event.pointerId);
      pressClicks.current = countClicks(event);
    }
    sendInput(pointerInput(phase, event.nativeEvent, canvas, target, pressClicks.current));
  };

  const key = (phase: "down" | "up", event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const input = keyInput(phase, event.nativeEvent, target);
    if (input === null) return;
    event.preventDefault();
    movesRef.current?.flush();
    sendInput(input);
  };

  const typeText = (text: string) => {
    movesRef.current?.flush();
    for (const input of textInputs(text)) sendInput(input);
  };

  // 断线重连的间隙里点结束，也得送到电脑：临时连一条把这一句发完就关，不然电脑那页要等到自己超时才收。
  const end = (action: LiveUserEnd) => {
    const viewer = viewerRef.current ?? openLiveViewer(session.liveId, IGNORE);
    viewer.send({ t: "end", action });
    if (viewer !== viewerRef.current) viewer.close();
    onDismiss();
  };

  // 抢回来会把另一处顶成 replaced，所以只在人点了之后做。
  const reclaim = () => {
    setConn("connecting");
    setGeneration((current) => current + 1);
  };

  const purpose = session.purpose;
  const title =
    purpose.kind === "login"
      ? `登录${PLATFORM[purpose.platform]}`
      : LIVE_TEXT.takeover(state.status === "ready" ? state.bots[purpose.botId]?.name : undefined);
  const where = computer === undefined ? "电脑" : computerName(computer);
  const note =
    purpose.kind === "login"
      ? `扫码或输入都直接发到${beforeChinese(where)}上的这一页，密码不经过 Bot。`
      : purpose.reason;
  const notice =
    conn === "replaced"
      ? LIVE_TEXT.replaced
      : conn === "ended"
        ? LIVE_TEXT.ended
        : conn === "reconnecting"
          ? LIVE_TEXT.reconnecting
          : conn === "connecting" || !hasFrame
            ? LIVE_TEXT.connecting
            : null;
  const attached = conn !== "replaced" && conn !== "ended";

  return (
    <div className="scrim live-scrim">
      <section
        className="dialog live-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="live-panel"
        data-purpose={purpose.kind}
        data-live-id={session.liveId}
        data-state={conn}
      >
        <header className="dialog-head">
          <MonitorUp size={20} aria-hidden="true" />
          <span>
            <b>{title}</b>
            <small>{note}</small>
          </span>
        </header>
        <div className="live-origin" data-testid="live-origin">
          <Globe size={14} aria-hidden="true" />
          <span>{origin ?? LIVE_TEXT.noOrigin}</span>
        </div>
        <div className="live-screen">
          <canvas
            ref={canvasRef}
            className={!hasFrame ? "live-canvas is-blank" : conn === "live" ? "live-canvas" : "live-canvas is-stale"}
            data-testid="live-canvas"
            onPointerDown={(event) => pointer("down", event)}
            onPointerMove={(event) => pointer("move", event)}
            onPointerUp={(event) => pointer("up", event)}
            onPointerCancel={(event) => pointer("up", event)}
            onContextMenu={(event) => event.preventDefault()}
          />
          {notice === null ? null : (
            <p className="live-notice" data-testid="live-notice" role="status">
              {notice}
            </p>
          )}
          <textarea
            ref={keysRef}
            className="live-keys"
            data-testid="live-keys"
            aria-label="发到画面上的键盘输入"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={(event) => key("down", event)}
            onKeyUp={(event) => key("up", event)}
            onCompositionEnd={(event) => {
              typeText(event.data);
              event.currentTarget.value = "";
            }}
            onPaste={(event) => {
              event.preventDefault();
              typeText(event.clipboardData.getData("text/plain"));
            }}
            // 组字上屏和粘贴已经整段发了，框里留着的字只会让下一次组字带上旧字。组字途中不能清，清了候选就没了。
            onInput={(event) => {
              if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = "";
            }}
          />
        </div>
        <div className="dialog-actions">
          {attached ? (
            <>
              {target === "local" ? (
                <button
                  type="button"
                  className="ghost-button live-reveal"
                  data-testid="live-reveal"
                  onClick={() => viewerRef.current?.send({ t: "reveal" })}
                >
                  {LIVE_TEXT.reveal}
                </button>
              ) : null}
              {liveEndActions(purpose).map((action) => (
                <button
                  key={action}
                  type="button"
                  className={action === "finish" ? "primary-button" : "ghost-button"}
                  data-testid="live-end"
                  data-action={action}
                  onClick={() => end(action)}
                >
                  {liveEndText(purpose.kind, action)}
                </button>
              ))}
            </>
          ) : (
            <>
              <button type="button" className="ghost-button" data-testid="live-hide" onClick={onDismiss}>
                {LIVE_TEXT.hide}
              </button>
              {conn === "replaced" ? (
                <button type="button" className="primary-button" data-testid="live-reclaim" onClick={reclaim}>
                  {LIVE_TEXT.reclaim}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
};
