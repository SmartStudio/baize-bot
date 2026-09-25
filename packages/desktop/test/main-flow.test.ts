import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ComputerId } from "@baize/shared";

const sockets: FakeSocket[] = [];
const children: FakeChild[] = [];
const reapedProfiles = vi.hoisted((): string[] => []);
// 比任何系统的 pid_max 都大，真发出信号也落不到别人的进程上。
const FAKE_PID_BASE = 2 ** 30;

class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly readyState = FakeSocket.OPEN;
  readonly close = vi.fn(() => this.emit("close"));

  constructor() {
    super();
    sockets.push(this);
  }
}

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
    children.push(this);
  }
}

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    getPath: () => "/tmp/baize-desktop-test",
    exit: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  safeStorage: { isEncryptionAvailable: () => false },
  session: { defaultSession: {} },
  Tray: vi.fn(),
}));

vi.mock("ws", () => ({ default: FakeSocket }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(() => new FakeChild(FAKE_PID_BASE + children.length)),
    spawnSync: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
  };
});

vi.mock("@baize/computer-agent/chrome-process", async () => {
  const actual = await vi.importActual<typeof import("@baize/computer-agent/chrome-process")>(
    "@baize/computer-agent/chrome-process",
  );
  return {
    ...actual,
    reapProfileChromes: async (profileDir: string) => {
      reapedProfiles.push(profileDir);
      return [];
    },
  };
});

async function loadMain(): Promise<typeof import("../src/main.js")> {
  vi.resetModules();
  sockets.length = 0;
  children.length = 0;
  reapedProfiles.length = 0;
  return import("../src/main.js");
}

const credentials = { computerId: "computer-1" as ComputerId, token: "token-1" };

const agentChromeProfile = "/tmp/baize-desktop-test/bots/chrome-profile";

describe("桌面主进程代理流程", () => {
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockRestore();
  });

  it("第二次 connectPush 建立后，旧连接关闭不再安排重连", async () => {
    const main = await loadMain();
    const session = { cookies: { get: vi.fn(async () => []) } };

    main.connectPush(session as never, "http://127.0.0.1:3001");
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    main.connectPush(session as never, "http://127.0.0.1:3001");
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    sockets[0]?.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(sockets).toHaveLength(2);
  }, 5_000);

  it("旧代理 stopping 时 startAgent 仍启动替换代理", async () => {
    const main = await loadMain();

    const initial = main.startAgent(credentials, 1_000);
    const initialRejected = expect(initial).rejects.toBeInstanceOf(main.AgentReplacedError);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const stopping = main.stopAgent();
    await vi.waitFor(() => expect(children[0]?.stdin.writableEnded).toBe(true));

    const replacement = main.startAgent(credentials, 1_000);
    try {
      expect(children).toHaveLength(2);
      children[1]?.stdout.write('{"type":"online"}\n');
      await expect(replacement).resolves.toBeUndefined();
    } finally {
      children[0]?.emit("exit", 0, null);
      await initialRejected;
      await stopping;
      if (children[1] !== undefined) {
        const ending = main.stopAgent();
        children[1].emit("exit", 0, null);
        await ending;
      }
    }
  }, 5_000);

  it("startAgent 超时杀掉 child、回到 none，并允许下一次重新启动", async () => {
    vi.useFakeTimers();
    const main = await loadMain();

    const first = main.startAgent(credentials, 45_000);
    const firstRejected = expect(first).rejects.toThrow("45 秒");
    await vi.advanceTimersByTimeAsync(45_000);
    await firstRejected;
    expect(children).toHaveLength(1);
    expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGKILL");
    await vi.waitFor(() => expect(reapedProfiles, "超时强杀后按 profile 收助理 Chrome").toEqual([agentChromeProfile]));

    const second = main.startAgent(credentials, 45_000);
    expect(children).toHaveLength(2);
    children[1]?.stdout.write('{"type":"online"}\n');
    await expect(second).resolves.toBeUndefined();

    const ending = main.stopAgent();
    children[1]?.emit("exit", 0, null);
    await ending;
  });

  it("代理不理 SIGINT 时强杀整组，再按 profile 收助理 Chrome", async () => {
    vi.useFakeTimers();
    const main = await loadMain();
    const started = main.startAgent(credentials, 45_000);
    children[0]?.stdout.write('{"type":"online"}\n');
    await started;

    const stopping = main.stopAgent();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;

    expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT");
    expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGKILL");
    expect(reapedProfiles).toEqual([agentChromeProfile]);
  });
});
