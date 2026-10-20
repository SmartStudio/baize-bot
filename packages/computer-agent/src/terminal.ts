import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TerminalSpawn } from "@baize/bot-runner";
import { encodeLive, type LiveDown, type LiveId } from "@baize/shared";

// 云电脑上的网页终端：一个伪终端里的 bash，输出按序送给正在看的人，人敲的字原样写回去。
// 和画面一样只过内存：输出和输入都不落盘、不记日志，回滚缓冲随会话一起没。

/** 伪终端里跑着的那个进程。signal 发给它整个进程组。 */
export interface PtyProcess {
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(signal: "SIGHUP" | "SIGKILL"): void;
  /** 上行积压时停读输出，伪终端写满后里面的程序自己阻塞。 */
  pause(): void;
  resume(): void;
}

export interface PtyEvents {
  output(bytes: Uint8Array): void;
  /** 只来一次：进程退了，或者根本没起来。 */
  exit(): void;
}

export type SpawnPty = (events: PtyEvents) => PtyProcess;

export interface TerminalsDeps {
  /** 同屏的上行：连接不在回 false，这时输出只进回滚缓冲。 */
  readonly uplink: (bytes: Uint8Array, sent: () => void) => boolean;
  /** 上行连接里还没发出去的字节数，连接不在算 0。 */
  readonly uplinkBacklog: () => number;
  readonly log: (line: string) => void;
  /** 云电脑、沙箱是 bwrap 才开。本机电脑上主人有自己的终端，不经网页。 */
  readonly available: () => boolean;
  readonly spawn: SpawnPty;
}

export interface Terminals {
  /** 这个 liveId 是不是一个开着的终端。屏按它把下行帧分过来。 */
  owns(liveId: LiveId): boolean;
  receive(header: LiveDown): void;
  /** welcome 之后调：重报每个终端，看的人当作已离开。 */
  reconnected(): void;
  /** 代理停机：终端全部直接杀掉，不报 closed，连接也要关了。 */
  stop(): void;
}

export const TERMINAL_LIMIT = 2;
export const TERMINAL_IDLE_MS = 30 * 60_000;
export const TERMINAL_BACKLOG_BYTES = 128 * 1024;
export const TERMINAL_UPLINK_HIGH_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 20;
const FLUSH_MS = 16;
const FLUSH_BYTES = 32 * 1024;
// shell 不理 SIGHUP 时 pty-helper.py 自己 2 秒后升级成 SIGKILL；这里只兜住助手本身卡死。
const KILL_AFTER_MS = 5_000;

interface Terminal {
  readonly liveId: LiveId;
  readonly process: PtyProcess;
  /** 最近的输出，新来的人先拿到这一份。 */
  backlog: Uint8Array[];
  backlogBytes: number;
  /** 攒着还没发给观看者的输出。 */
  outgoing: Uint8Array[];
  outgoingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  watched: boolean;
  idleTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  /** 不为 null 就是因为上行积压停着读，定时看积压降下去没有。 */
  drainTimer: NodeJS.Timeout | null;
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array =>
  chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);

const clear = (timer: NodeJS.Timeout | null): null => {
  if (timer !== null) clearTimeout(timer);
  return null;
};

export function createTerminals(deps: TerminalsDeps): Terminals {
  const { uplink, log } = deps;
  const terminals = new Map<LiveId, Terminal>();

  const announce = (liveId: LiveId): void => {
    uplink(encodeLive({ t: "session", session: { liveId, purpose: { kind: "terminal" }, origin: null } }), () => {});
  };

  const drain = (terminal: Terminal): void => {
    terminal.drainTimer = setTimeout(() => {
      if (deps.uplinkBacklog() > TERMINAL_UPLINK_HIGH_BYTES) return drain(terminal);
      terminal.drainTimer = null;
      terminal.process.resume();
    }, DRAIN_POLL_MS);
  };

  const throttle = (terminal: Terminal): void => {
    if (terminal.drainTimer !== null || deps.uplinkBacklog() <= TERMINAL_UPLINK_HIGH_BYTES) return;
    terminal.process.pause();
    drain(terminal);
  };

  const sendTerm = (terminal: Terminal, chunks: readonly Uint8Array[]): void => {
    if (chunks.length === 0) return;
    uplink(encodeLive({ t: "term", liveId: terminal.liveId }, concat(chunks)), () => {});
    throttle(terminal);
  };

  const sendReplay = (terminal: Terminal): void => {
    uplink(encodeLive({ t: "term", liveId: terminal.liveId, replay: true }, concat(terminal.backlog)), () => {});
    throttle(terminal);
  };

  const flush = (terminal: Terminal): void => {
    terminal.flushTimer = clear(terminal.flushTimer);
    const chunks = terminal.outgoing;
    terminal.outgoing = [];
    terminal.outgoingBytes = 0;
    sendTerm(terminal, chunks);
  };

  const dropOutgoing = (terminal: Terminal): void => {
    terminal.flushTimer = clear(terminal.flushTimer);
    terminal.outgoing = [];
    terminal.outgoingBytes = 0;
  };

  const hangUp = (terminal: Terminal): void => {
    if (terminal.killTimer !== null) return;
    terminal.process.signal("SIGHUP");
    terminal.killTimer = setTimeout(() => terminal.process.signal("SIGKILL"), KILL_AFTER_MS);
  };

  const idle = (terminal: Terminal): void => {
    terminal.idleTimer ??= setTimeout(() => {
      log("终端没人看超过 30 分钟，收掉");
      hangUp(terminal);
    }, TERMINAL_IDLE_MS);
  };

  const output = (liveId: LiveId, bytes: Uint8Array): void => {
    const terminal = terminals.get(liveId);
    if (terminal === undefined || bytes.length === 0) return;
    terminal.backlog.push(bytes);
    terminal.backlogBytes += bytes.length;
    while (terminal.backlogBytes - terminal.backlog[0]!.length >= TERMINAL_BACKLOG_BYTES) {
      terminal.backlogBytes -= terminal.backlog.shift()!.length;
    }
    if (terminal.backlogBytes > TERMINAL_BACKLOG_BYTES) {
      const cut = terminal.backlogBytes - TERMINAL_BACKLOG_BYTES;
      terminal.backlog[0] = terminal.backlog[0]!.subarray(cut);
      terminal.backlogBytes -= cut;
    }
    if (!terminal.watched) return;
    terminal.outgoing.push(bytes);
    terminal.outgoingBytes += bytes.length;
    if (terminal.outgoingBytes >= FLUSH_BYTES) flush(terminal);
    else terminal.flushTimer ??= setTimeout(() => flush(terminal), FLUSH_MS);
  };

  const exited = (liveId: LiveId): void => {
    const terminal = terminals.get(liveId);
    if (terminal === undefined) return;
    terminals.delete(liveId);
    if (terminal.watched) flush(terminal);
    else dropOutgoing(terminal);
    terminal.idleTimer = clear(terminal.idleTimer);
    terminal.killTimer = clear(terminal.killTimer);
    terminal.drainTimer = clear(terminal.drainTimer);
    uplink(encodeLive({ t: "closed", liveId }), () => {});
  };

  const open = (liveId: LiveId): void => {
    // 控制面每次开都给新号，撞上开着的号只可能是重发，不动现有的会话。
    if (terminals.has(liveId)) return log("终端号已经开着，忽略这次开");
    const refuse = (why: string): void => {
      log(why);
      uplink(encodeLive({ t: "closed", liveId }), () => {});
    };
    if (!deps.available()) return refuse("这台电脑不是云电脑，不开终端");
    if (terminals.size >= TERMINAL_LIMIT) return refuse(`已经开着 ${TERMINAL_LIMIT} 个终端，不再开`);
    let pty: PtyProcess;
    let exitedEarly = false;
    try {
      pty = deps.spawn({
        output: (bytes) => output(liveId, bytes),
        exit: () => {
          if (terminals.has(liveId)) exited(liveId);
          else exitedEarly = true;
        },
      });
    } catch (error) {
      return refuse(`终端没起来：${error instanceof Error ? error.message : String(error)}`);
    }
    if (exitedEarly) return refuse("终端没起来：进程一启动就退了");
    const terminal: Terminal = {
      liveId,
      process: pty,
      backlog: [],
      backlogBytes: 0,
      outgoing: [],
      outgoingBytes: 0,
      flushTimer: null,
      watched: false,
      idleTimer: null,
      killTimer: null,
      drainTimer: null,
    };
    terminals.set(liveId, terminal);
    idle(terminal);
    announce(liveId);
  };

  const receive = (header: LiveDown): void => {
    if (header.t === "terminal_open") {
      open(header.liveId);
      return;
    }
    const terminal = terminals.get(header.liveId);
    if (terminal === undefined) return;
    switch (header.t) {
      case "viewer":
        if (header.state === "attached") {
          terminal.watched = true;
          terminal.idleTimer = clear(terminal.idleTimer);
          // 攒着的那些已经在回滚缓冲里，再发一遍就重了。
          dropOutgoing(terminal);
          sendReplay(terminal);
        } else {
          terminal.watched = false;
          dropOutgoing(terminal);
          idle(terminal);
        }
        return;
      case "input":
        if (header.input.kind === "term") terminal.process.write(Buffer.from(header.input.data, "utf8"));
        else if (header.input.kind === "resize") terminal.process.resize(header.input.cols, header.input.rows);
        return;
      case "end":
        if (header.action === "finish") hangUp(terminal);
        return;
      case "reveal":
        return;
      default: {
        const exhaustive: never = header;
        return exhaustive;
      }
    }
  };

  const reconnected = (): void => {
    for (const terminal of terminals.values()) {
      terminal.watched = false;
      dropOutgoing(terminal);
      idle(terminal);
      announce(terminal.liveId);
    }
  };

  const stop = (): void => {
    for (const terminal of terminals.values()) {
      dropOutgoing(terminal);
      terminal.idleTimer = clear(terminal.idleTimer);
      terminal.killTimer = clear(terminal.killTimer);
      terminal.drainTimer = clear(terminal.drainTimer);
      terminal.process.signal("SIGKILL");
    }
    terminals.clear();
  };

  return { owns: (liveId) => terminals.has(liveId), receive, reconnected, stop };
}

/**
 * 真的伪终端：python3 标准库的 pty 包着 launch 给的命令（云电脑上是 bwrap 里的 bash），不引原生模块。
 * 助手自成一个进程组，信号发给整组；助手转给伪终端里的那一组 SIGHUP，bwrap 的 --die-with-parent 兜底收掉里面剩下的。
 */
export function ptySpawner(launch: () => TerminalSpawn): SpawnPty {
  return (events) => {
    const { file, args, env } = launch();
    const helper = fileURLToPath(new URL("./pty-helper.py", import.meta.url));
    const child = spawn("python3", ["-I", helper, file, ...args], {
      env,
      stdio: ["pipe", "pipe", "ignore", "pipe"],
      detached: true,
    });
    let done = false;
    const exit = (): void => {
      if (done) return;
      done = true;
      events.exit();
    };
    child.on("error", exit);
    child.on("close", exit);
    child.stdout?.on("data", (chunk: Buffer) => events.output(chunk));
    const control = child.stdio[3] as Writable;
    child.stdin?.on("error", () => {});
    control.on("error", () => {});
    return {
      write: (bytes) => {
        child.stdin?.write(bytes);
      },
      resize: (cols, rows) => {
        control.write(`${cols} ${rows}\n`);
      },
      pause: () => {
        child.stdout?.pause();
      },
      resume: () => {
        child.stdout?.resume();
      },
      signal: (signal) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // 已经退了
        }
      },
    };
  };
}
