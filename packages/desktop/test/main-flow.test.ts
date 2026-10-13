import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ComputerId } from "@baize/shared";

const sockets: FakeSocket[] = [];
const children: FakeChild[] = [];
const reapedProfiles = vi.hoisted((): string[] => []);
const electronState = vi.hoisted(() => ({ packaged: false, ready: false }));
const autoUpdater = vi.hoisted(() => ({
  on: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
}));
const appOn = vi.hoisted(() => vi.fn());
const appExit = vi.hoisted(() => vi.fn());
const showMessageBox = vi.hoisted(() => vi.fn());
const windows = vi.hoisted((): Array<{ on: MockInstance }> => []);
const fsState = vi.hoisted(() => ({ credentials: null as string | null }));
const fsWrites = vi.hoisted((): string[] => []);
const fetchState = vi.hoisted(() => ({
  meOk: false,
  localComputer: null as Promise<unknown> | null,
  urls: [] as string[],
}));
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

const fakeWindow = (): object => {
  const window = {
    webContents: { setWindowOpenHandler: vi.fn() },
    once: vi.fn(),
    on: vi.fn(),
    isDestroyed: () => false,
    hide: vi.fn(),
    loadURL: vi.fn(async () => undefined),
  };
  windows.push(window);
  return window;
};

vi.mock("electron", () => {
  return {
    app: {
      get isPackaged() {
        return electronState.packaged;
      },
      whenReady: () => (electronState.ready ? Promise.resolve() : new Promise<void>(() => undefined)),
      on: appOn,
      getPath: () => "/tmp/baize-desktop-test",
      getVersion: () => "0.1.0",
      getAppPath: () => "/tmp/baize-desktop-test/app",
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: vi.fn(),
      setAboutPanelOptions: vi.fn(),
      exit: appExit,
      quit: vi.fn(),
    },
    autoUpdater,
    BrowserWindow: vi.fn(fakeWindow),
    dialog: { showErrorBox: vi.fn(), showMessageBox },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    nativeImage: { createFromDataURL: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
    Notification: Object.assign(vi.fn(), { isSupported: () => false }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text),
      decryptString: (data: Buffer) => data.toString(),
    },
    session: {
      defaultSession: {
        webRequest: { onCompleted: vi.fn() },
        cookies: { get: vi.fn(async () => []) },
        fetch: vi.fn(async (url: string) => {
          fetchState.urls.push(url);
          if (url.endsWith("/api/me")) return { ok: fetchState.meOk };
          if (url.endsWith("/api/computers/local") && fetchState.localComputer !== null)
            return fetchState.localComputer;
          return { ok: false };
        }),
      },
    },
    Tray: vi.fn(() => ({ setToolTip: vi.fn(), on: vi.fn() })),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: async (path: string) => {
      if (path.endsWith("computer-credentials.json") && fsState.credentials !== null) return fsState.credentials;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async (path: string) => {
      fsWrites.push(path);
    },
    unlink: async () => undefined,
  };
});
vi.mock("../src/proxy.js", () => ({ startUiServer: async () => ({ origin: "http://127.0.0.1:1" }) }));
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
  windows.length = 0;
  fsWrites.length = 0;
  fetchState.urls.length = 0;
  return import("../src/main.js");
}

const credentials = { computerId: "computer-1" as ComputerId, token: "token-1" };

const agentChromeProfile = "/tmp/baize-desktop-test/bots/chrome-profile";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fakeEvent = (): { preventDefault: MockInstance } => ({ preventDefault: vi.fn() });

describe("桌面主进程代理流程", () => {
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    fsState.credentials = null;
    fetchState.meOk = false;
    fetchState.localComputer = null;
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

  describe("启动时检查更新", () => {
    const startMain = async (packaged: boolean): Promise<void> => {
      electronState.packaged = packaged;
      electronState.ready = true;
      Object.defineProperty(process, "resourcesPath", {
        value: "/tmp/baize-desktop-test/resources",
        configurable: true,
      });
      await loadMain();
      await vi.waitFor(() => expect(appOn).toHaveBeenCalledWith("activate", expect.any(Function)));
    };

    afterEach(() => {
      Reflect.deleteProperty(process, "resourcesPath");
      electronState.packaged = false;
      electronState.ready = false;
    });

    it("打包态设置 feed 并检查一次", async () => {
      await startMain(true);

      expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
        url: `http://localhost:3001/desktop/darwin-${process.arch}/releases.json`,
        serverType: "json",
      });
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it("非打包态不设置 feed 也不检查", async () => {
      await startMain(false);

      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("更新重启", () => {
    type Handler = (...args: unknown[]) => unknown;
    const handlerOf = (spy: MockInstance, name: string): Handler => {
      const call = spy.mock.calls.find((args) => args[0] === name);
      if (call === undefined) throw new Error(`没有注册 ${name}`);
      return call[1] as Handler;
    };
    const menubarClose = (): Handler => handlerOf(windows[1]!.on, "close");
    const downloaded = (): void => {
      handlerOf(autoUpdater.on, "update-downloaded")({}, "", "0.2.0");
    };

    beforeEach(() => {
      electronState.packaged = true;
      electronState.ready = true;
      Object.defineProperty(process, "resourcesPath", {
        value: "/tmp/baize-desktop-test/resources",
        configurable: true,
      });
      showMessageBox.mockResolvedValue({ response: 0 });
      autoUpdater.quitAndInstall.mockReset();
    });

    afterEach(() => {
      Reflect.deleteProperty(process, "resourcesPath");
      electronState.packaged = false;
      electronState.ready = false;
    });

    const boot = async (): Promise<void> => {
      await loadMain();
      await vi.waitFor(() => expect(autoUpdater.checkForUpdates).toHaveBeenCalled());
      await vi.waitFor(() => expect(windows).toHaveLength(2));
    };

    it("点「现在重启」后关窗口不被菜单栏窗口拦住，随后的 before-quit 也放行，不走 app.exit", async () => {
      await boot();
      const closeEvent = fakeEvent();
      const quitEvent = fakeEvent();
      autoUpdater.quitAndInstall.mockImplementation(() => {
        menubarClose()(closeEvent);
        handlerOf(appOn, "before-quit")(quitEvent);
      });

      downloaded();
      await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));

      expect(closeEvent.preventDefault, "安装前窗口 close 放行").not.toHaveBeenCalled();
      expect(quitEvent.preventDefault, "before-quit 不拦，交给 Squirrel 退出").not.toHaveBeenCalled();
      expect(appExit).not.toHaveBeenCalled();
    });

    it("平时关菜单栏窗口只是隐藏，普通退出仍先停代理再 app.exit(0)", async () => {
      await boot();
      const closeEvent = fakeEvent();
      menubarClose()(closeEvent);
      expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);

      const quitEvent = fakeEvent();
      handlerOf(appOn, "before-quit")(quitEvent);
      expect(quitEvent.preventDefault).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
    });

    it("停代理之后在途配对返回，不再启动代理", async () => {
      const pairing = deferred<unknown>();
      fetchState.meOk = true;
      fetchState.localComputer = pairing.promise;
      await boot();
      await vi.waitFor(() => expect(fetchState.urls.some((url) => url.endsWith("/api/computers/local"))).toBe(true));

      downloaded();
      await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
      pairing.resolve({ ok: true, json: async () => ({ computerId: "computer-1", token: "token-1" }) });
      await vi.waitFor(() => expect(fsWrites.some((path) => path.endsWith("computer-credentials.json"))).toBe(true));
      await new Promise((resolve) => setImmediate(resolve));

      expect(children, "配对返回后不得再起代理").toHaveLength(0);
    });

    it("quitAndInstall 异步报错：提示失败、窗口守卫恢复、代理重新起来", async () => {
      await boot();
      downloaded();
      await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
      expect(children).toHaveLength(0);
      fsState.credentials = JSON.stringify({
        computerId: "computer-1",
        encryptedToken: Buffer.from("token-1").toString("base64"),
      });

      handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));

      await vi.waitFor(() =>
        expect(showMessageBox).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ type: "error", message: "重启安装失败：Failed to launch ShipIt" }),
        ),
      );
      await vi.waitFor(() => expect(children, "失败后恢复代理").toHaveLength(1));
      const closeEvent = fakeEvent();
      menubarClose()(closeEvent);
      expect(closeEvent.preventDefault, "失败后恢复隐藏式关窗").toHaveBeenCalledTimes(1);
    });
  });
});
