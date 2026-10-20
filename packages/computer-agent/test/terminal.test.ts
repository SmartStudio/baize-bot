import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeLive, encodeLive, type LiveDown, LiveId, LiveUp } from "@baize/shared";
import { createLiveScreen } from "../src/live-screen.js";
import {
  createTerminals,
  ptySpawner,
  type PtyEvents,
  TERMINAL_BACKLOG_BYTES,
  TERMINAL_IDLE_MS,
  TERMINAL_LIMIT,
  TERMINAL_UPLINK_HIGH_BYTES,
} from "../src/terminal.js";

interface FakePty {
  readonly events: PtyEvents;
  readonly writes: string[];
  readonly resizes: Array<readonly [number, number]>;
  readonly signals: string[];
  readonly flow: string[];
}

type Spawn = Parameters<typeof createTerminals>[0]["spawn"];

function harness(options: { available?: boolean; spawn?: Spawn } = {}) {
  const ups: Array<{ header: LiveUp; payload: Uint8Array }> = [];
  let connected = true;
  let uplinkBacklog = 0;
  const ptys: FakePty[] = [];
  const terminals = createTerminals({
    uplink: (bytes) => {
      if (!connected) return false;
      const decoded = decodeLive(LiveUp, bytes);
      if (decoded === null) throw new Error("上行帧解不开");
      ups.push({ header: decoded.header, payload: new Uint8Array(decoded.payload) });
      return true;
    },
    uplinkBacklog: () => uplinkBacklog,
    log: () => {},
    available: () => options.available ?? true,
    spawn:
      options.spawn ??
      ((events) => {
        const pty: FakePty = { events, writes: [], resizes: [], signals: [], flow: [] };
        ptys.push(pty);
        return {
          write: (bytes) => pty.writes.push(Buffer.from(bytes).toString("utf8")),
          resize: (cols, rows) => pty.resizes.push([cols, rows]),
          signal: (signal) => pty.signals.push(signal),
          pause: () => pty.flow.push("pause"),
          resume: () => pty.flow.push("resume"),
        };
      }),
  });
  const kinds = () => ups.map((up) => up.header.t);
  const terms = () =>
    ups.flatMap((up) => (up.header.t === "term" && up.header.replay !== true ? [utf8(up.payload)] : []));
  const replays = () =>
    ups.flatMap((up) => (up.header.t === "term" && up.header.replay === true ? [utf8(up.payload)] : []));
  return {
    terminals,
    ups,
    ptys,
    kinds,
    terms,
    replays,
    setUplinkBacklog: (bytes: number) => {
      uplinkBacklog = bytes;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    clear: () => ups.splice(0),
  };
}

const newId = (): LiveId => LiveId.parse(randomUUID());
const text = (value: string): Uint8Array => Buffer.from(value, "utf8");
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

function opened(h: ReturnType<typeof harness>) {
  const liveId = newId();
  h.terminals.receive({ t: "terminal_open", liveId });
  const pty = h.ptys.at(-1)!;
  return { liveId, pty };
}

describe("网页终端的会话", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("不是云电脑就不起进程，直接报 closed", () => {
    const h = harness({ available: false });
    const liveId = newId();
    h.terminals.receive({ t: "terminal_open", liveId });
    expect(h.ptys).toHaveLength(0);
    expect(h.ups.map((up) => up.header)).toEqual([{ t: "closed", liveId }]);
    expect(h.terminals.owns(liveId)).toBe(false);
  });

  it("起好报 session，purpose 是 terminal、origin 是 null；同一个号再开直接忽略，不重报也不起第二个进程", () => {
    const h = harness();
    const { liveId } = opened(h);
    h.terminals.receive({ t: "terminal_open", liveId });
    expect(h.ptys).toHaveLength(1);
    const session = { t: "session", session: { liveId, purpose: { kind: "terminal" }, origin: null } };
    expect(h.ups.map((up) => up.header)).toEqual([session]);
    expect(h.terminals.owns(liveId)).toBe(true);
  });

  it("spawn 抛错、或者进程在 spawn 里就退了，都对这个号报一条 closed，不留会话", () => {
    for (const spawn of [
      (): never => {
        throw new Error("没有 python3");
      },
      (events: PtyEvents) => {
        events.exit();
        return { write: () => {}, resize: () => {}, signal: () => {}, pause: () => {}, resume: () => {} };
      },
    ]) {
      const h = harness({ spawn });
      const liveId = newId();
      h.terminals.receive({ t: "terminal_open", liveId });
      expect(h.ups.map((up) => up.header)).toEqual([{ t: "closed", liveId }]);
      expect(h.terminals.owns(liveId)).toBe(false);
    }
  });

  it(`同时最多 ${TERMINAL_LIMIT} 个，超了报 closed；关掉一个之后又能开`, () => {
    const h = harness();
    const first = opened(h);
    opened(h);
    const third = newId();
    h.terminals.receive({ t: "terminal_open", liveId: third });
    expect(h.ptys).toHaveLength(TERMINAL_LIMIT);
    expect(h.ups.at(-1)?.header).toEqual({ t: "closed", liveId: third });

    first.pty.events.exit();
    opened(h);
    expect(h.ptys).toHaveLength(TERMINAL_LIMIT + 1);
  });

  it("没人看时输出只进回滚缓冲；有人看时先发一帧 replay 的整份回滚缓冲，之后的输出不带 replay、约 16ms 合并成一帧", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    pty.events.output(text("$ "));
    pty.events.output(text("ls\r\n"));
    vi.advanceTimersByTime(100);
    expect(h.terms()).toEqual([]);
    expect(h.replays()).toEqual([]);

    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    expect(h.ups.at(-1)?.header).toEqual({ t: "term", liveId, replay: true });
    expect(h.replays()).toEqual(["$ ls\r\n"]);

    pty.events.output(text("a"));
    pty.events.output(text("b"));
    expect(h.terms()).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(h.ups.at(-1)?.header).toEqual({ t: "term", liveId });
    expect(h.terms()).toEqual(["ab"]);
  });

  it("回滚缓冲是空的也发一帧空负载的 replay，每次 attached 都发", () => {
    const h = harness();
    const { liveId } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    h.terminals.receive({ t: "viewer", liveId, state: "detached" });
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    expect(h.replays()).toEqual(["", ""]);
  });

  it(`上行积压超过 ${TERMINAL_UPLINK_HIGH_BYTES / 1024 / 1024}MB 就停读伪终端，降下去才接着读`, () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    pty.events.output(text("a"));
    vi.advanceTimersByTime(16);
    expect(pty.flow).toEqual([]);

    h.setUplinkBacklog(TERMINAL_UPLINK_HIGH_BYTES + 1);
    pty.events.output(text("b"));
    vi.advanceTimersByTime(16);
    expect(pty.flow).toEqual(["pause"]);
    pty.events.output(text("c"));
    vi.advanceTimersByTime(1_000);
    expect(pty.flow).toEqual(["pause"]);

    h.setUplinkBacklog(TERMINAL_UPLINK_HIGH_BYTES);
    vi.advanceTimersByTime(1_000);
    expect(pty.flow).toEqual(["pause", "resume"]);
    expect(h.terms()).toEqual(["a", "b", "c"]);
  });

  it("攒到 32KB 不等定时器，马上发", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    pty.events.output(text("x".repeat(20 * 1024)));
    expect(h.terms()).toEqual([]);
    pty.events.output(text("y".repeat(12 * 1024)));
    expect(h.terms()).toEqual(["x".repeat(20 * 1024) + "y".repeat(12 * 1024)]);
  });

  it("回滚缓冲只留最后 128KB，按序", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    const chunk = 50 * 1024;
    for (const letter of ["a", "b", "c", "d"]) pty.events.output(text(letter.repeat(chunk)));
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    const whole = "a".repeat(chunk) + "b".repeat(chunk) + "c".repeat(chunk) + "d".repeat(chunk);
    expect(h.replays()).toEqual([whole.slice(-TERMINAL_BACKLOG_BYTES)]);
  });

  it("人走了之后的输出不发，再来时从回滚缓冲里拿到", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    pty.events.output(text("one\r\n"));
    h.terminals.receive({ t: "viewer", liveId, state: "detached" });
    vi.advanceTimersByTime(16);
    pty.events.output(text("two\r\n"));
    vi.advanceTimersByTime(16);
    expect(h.terms()).toEqual([]);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    expect(h.replays()).toEqual(["", "one\r\ntwo\r\n"]);
  });

  it("连接不在时输出照样进回滚缓冲；重连后重报 session，看的人当作已离开，再 attached 补发", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    h.setConnected(false);
    pty.events.output(text("断线时的输出"));
    vi.advanceTimersByTime(16);
    h.setConnected(true);
    h.clear();

    h.terminals.reconnected();
    expect(h.kinds()).toEqual(["session"]);
    pty.events.output(text("。"));
    vi.advanceTimersByTime(16);
    expect(h.terms()).toEqual([]);

    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    expect(h.replays()).toEqual(["断线时的输出。"]);
  });

  it("人敲的字按 UTF-8 写进伪终端，resize 改窗口大小，别的输入不收", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    const input = (value: Extract<LiveDown, { t: "input" }>["input"]) =>
      h.terminals.receive({ t: "input", liveId, input: value });
    input({ kind: "term", data: "grok login\r" });
    input({ kind: "term", data: "\u0003" });
    input({ kind: "term", data: "中文" });
    input({ kind: "resize", cols: 120, rows: 40 });
    input({ kind: "text", text: "不该进来" });
    expect(pty.writes).toEqual(["grok login\r", "\u0003", "中文"]);
    expect(pty.resizes).toEqual([[120, 40]]);
  });

  it("点关掉先发 SIGHUP，5 秒还没退（助手自己 2 秒升级也没收掉）再 SIGKILL；退了才报 closed，之后的帧不再认", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "end", liveId, action: "abandon" });
    expect(pty.signals).toEqual([]);
    h.terminals.receive({ t: "end", liveId, action: "finish" });
    h.terminals.receive({ t: "end", liveId, action: "finish" });
    expect(pty.signals).toEqual(["SIGHUP"]);
    expect(h.kinds()).not.toContain("closed");
    vi.advanceTimersByTime(4_999);
    expect(pty.signals).toEqual(["SIGHUP"]);
    vi.advanceTimersByTime(1);
    expect(pty.signals).toEqual(["SIGHUP", "SIGKILL"]);

    pty.events.exit();
    expect(h.ups.at(-1)?.header).toEqual({ t: "closed", liveId });
    expect(h.terminals.owns(liveId)).toBe(false);
    h.terminals.receive({ t: "input", liveId, input: { kind: "term", data: "ls\r" } });
    expect(pty.writes).toEqual([]);
  });

  it("shell 自己退了：最后一截输出先发给看的人，再报 closed，不再发信号", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    pty.events.output(text("exit\r\n"));
    pty.events.exit();
    expect(h.ups.slice(-2).map((up) => up.header.t)).toEqual(["term", "closed"]);
    expect(h.terms()).toEqual(["exit\r\n"]);
    vi.advanceTimersByTime(TERMINAL_IDLE_MS);
    expect(pty.signals).toEqual([]);
  });

  it("没人看满 30 分钟收掉；有人看着不算，人走了重新计时", () => {
    const h = harness();
    const { liveId, pty } = opened(h);
    vi.advanceTimersByTime(TERMINAL_IDLE_MS - 1);
    h.terminals.receive({ t: "viewer", liveId, state: "attached" });
    vi.advanceTimersByTime(TERMINAL_IDLE_MS * 2);
    expect(pty.signals).toEqual([]);

    h.terminals.receive({ t: "viewer", liveId, state: "detached" });
    vi.advanceTimersByTime(TERMINAL_IDLE_MS - 1);
    expect(pty.signals).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pty.signals).toEqual(["SIGHUP"]);
  });

  it("代理停机直接 SIGKILL 全部终端，不报 closed", () => {
    const h = harness();
    const a = opened(h);
    const b = opened(h);
    h.clear();
    h.terminals.stop();
    expect(a.pty.signals).toEqual(["SIGKILL"]);
    expect(b.pty.signals).toEqual(["SIGKILL"]);
    a.pty.events.exit();
    expect(h.ups).toEqual([]);
    expect(h.terminals.owns(a.liveId)).toBe(false);
  });
});

describe("屏把终端的帧分出去", () => {
  it("terminal_open 和开着的终端的 liveId 交给终端，别的 liveId 屏照旧自己认", () => {
    const received: LiveDown[] = [];
    const owned = newId();
    const screen = createLiveScreen({
      chrome: {
        connection: () => Promise.reject(new Error("用不到 Chrome")),
        reveal: async () => {},
        conceal: async () => {},
        onExit: () => () => {},
      },
      uplink: () => true,
      log: () => {},
      terminals: { owns: (liveId) => liveId === owned, receive: (header) => received.push(header) },
    });
    const fresh = newId();
    const other = newId();
    screen.receive(encodeLive({ t: "terminal_open", liveId: fresh }));
    screen.receive(encodeLive({ t: "input", liveId: owned, input: { kind: "term", data: "ls\r" } }));
    screen.receive(encodeLive({ t: "viewer", liveId: other, state: "attached" }));
    expect(received).toEqual([
      { t: "terminal_open", liveId: fresh },
      { t: "input", liveId: owned, input: { kind: "term", data: "ls\r" } },
    ]);
  });
});

const spawnShell = (script: string) => {
  let out = "";
  let exited = false;
  const pty = ptySpawner(() => ({ file: "/bin/sh", args: ["-c", script], env: { PATH: process.env["PATH"] ?? "" } }))({
    output: (bytes) => {
      out += Buffer.from(bytes).toString("utf8");
    },
    exit: () => {
      exited = true;
    },
  });
  return { pty, out: () => out, exited: () => exited };
};

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!hasPython)("pty-helper.py 真跑（不经 bwrap）", () => {
  it("伪终端往返：读得到人敲的行，resize 之后 stty 看到新大小，shell 退出后报退出", async () => {
    const shell = spawnShell("stty size; echo ready; read x; echo got:$x; stty size");
    await vi.waitFor(() => expect(shell.out()).toContain("ready"), { timeout: 5_000 });
    expect(shell.out()).toContain("24 80");
    shell.pty.resize(132, 43);
    await new Promise((resolve) => setTimeout(resolve, 100));
    shell.pty.write(Buffer.from("你好\r", "utf8"));
    await vi.waitFor(() => expect(shell.exited()).toBe(true), { timeout: 5_000 });
    expect(shell.out()).toContain("got:你好");
    expect(shell.out()).toContain("43 132");
  });

  it("SIGHUP 转给伪终端里的那一组，挂着的命令跟着收掉", async () => {
    const shell = spawnShell("echo ready; sleep 30");
    await vi.waitFor(() => expect(shell.out()).toContain("ready"), { timeout: 5_000 });
    shell.pty.signal("SIGHUP");
    await vi.waitFor(() => expect(shell.exited()).toBe(true), { timeout: 5_000 });
  });

  it("shell trap 掉 HUP 时，助手 2 秒后给那一组 SIGKILL 再自己退，里面的进程都没了", async () => {
    const shell = spawnShell("trap '' HUP; sleep 30 & echo pids:$$,$!; wait");
    await vi.waitFor(() => expect(shell.out()).toMatch(/pids:\d+,\d+/), { timeout: 5_000 });
    const pids = /pids:(\d+),(\d+)/.exec(shell.out())!.slice(1).map(Number);
    shell.pty.signal("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(shell.exited()).toBe(false);
    await vi.waitFor(() => expect(shell.exited()).toBe(true), { timeout: 5_000 });
    expect(pids.filter(alive)).toEqual([]);
  });
});
