import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ComputerId } from "@baize/shared";

process.setMaxListeners(30);

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
const appQuit = vi.hoisted(() => vi.fn());
const reapGate = vi.hoisted(() => ({ current: null as Promise<void> | null }));
const showMessageBox = vi.hoisted(() => vi.fn());
type FakeWindow = Record<string, unknown> & {
  destroyed: boolean;
  on: MockInstance;
  show: MockInstance;
  hide: MockInstance;
};
// 真窗口销毁后再调用会抛这条错，假窗口照样抛，才能抓住使用已销毁对象的缺陷。
function liveCall<T = undefined>(window: { destroyed: boolean }, value?: T): T {
  if (window.destroyed) throw new Error("Object has been destroyed");
  return value as T;
}
const windows = vi.hoisted((): FakeWindow[] => []);
const trays = vi.hoisted((): Array<{ on: MockInstance }> => []);
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
  const window: FakeWindow = {
    destroyed: false,
    webContents: { setWindowOpenHandler: vi.fn() },
    once: vi.fn(),
    on: vi.fn(),
    isDestroyed: () => window.destroyed,
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(() => liveCall(window)),
    hide: vi.fn(() => liveCall(window)),
    focus: vi.fn(() => liveCall(window)),
    isVisible: vi.fn(() => liveCall(window, false)),
    isFocused: vi.fn(() => liveCall(window, true)),
    getSize: vi.fn(() => liveCall(window, [390, 560])),
    setPosition: vi.fn(() => liveCall(window)),
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
      quit: appQuit,
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
    Tray: vi.fn(() => {
      const tray = {
        setToolTip: vi.fn(),
        setTitle: vi.fn(),
        getBounds: () => ({ x: 0, y: 0, width: 20, height: 20 }),
        on: vi.fn(),
      };
      trays.push(tray);
      return tray;
    }),
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
      await reapGate.current;
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
  trays.length = 0;
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
    reapGate.current = null;
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

  it("旧代理还在停机时又换了新代理，停止新代理也要等旧代理停完", async () => {
    const main = await loadMain();
    const first = main.startAgent(credentials, 1_000);
    const firstRejected = expect(first).rejects.toBeInstanceOf(main.AgentReplacedError);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const stoppingOld = main.stopAgent();
    await vi.waitFor(() => expect(children[0]?.stdin.writableEnded).toBe(true));
    const replacement = main.startAgent(credentials, 1_000);
    children[1]?.stdout.write('{"type":"online"}\n');
    await replacement;

    let ended = false;
    const ending = main.stopAgent().then(() => {
      ended = true;
    });
    children[1]?.emit("exit", 0, null);
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(ended, "旧代理的停机还没完成").toBe(false);

    children[0]?.emit("exit", 0, null);
    await ending;
    await stoppingOld;
    await firstRejected;
    expect(ended).toBe(true);
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

    describe("安装期间的窗口、退出与代次", () => {
      const savedCredentials = (): void => {
        fsState.credentials = JSON.stringify({
          computerId: "computer-1",
          encryptedToken: Buffer.from("token-1").toString("base64"),
        });
      };
      const bootWithOnlineAgent = async (): Promise<void> => {
        savedCredentials();
        await boot();
        await vi.waitFor(() => expect(children).toHaveLength(1));
        children[0]?.stdout.write('{"type":"online"}\n');
        await vi.waitFor(() => expect(kill).not.toHaveBeenCalled());
      };
      const squirrelClosesWindows = (): void => {
        for (const window of windows) {
          const close = window.on.mock.calls.find((args) => args[0] === "close");
          if (close !== undefined) (close[1] as Handler)(fakeEvent());
          window.destroyed = true;
          for (const args of window.on.mock.calls) if (args[0] === "closed") (args[1] as Handler)();
        }
        handlerOf(appOn, "window-all-closed")();
      };
      const trayClick = (): void => void handlerOf(trays[0]!.on, "click")();

      it("安装失败后窗口被补回：点托盘不抛错，能显示新的菜单栏窗口", async () => {
        await boot();
        autoUpdater.quitAndInstall.mockImplementation(squirrelClosesWindows);
        downloaded();
        await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
        expect(() => trayClick(), "窗口被 Squirrel 关掉后，托盘点击不碰已销毁对象").not.toThrow();

        handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
        await vi.waitFor(() => expect(windows, "恢复路径重建主窗口和菜单栏窗口").toHaveLength(4));
        expect(() => trayClick()).not.toThrow();
        expect(windows[3]!.show, "托盘点击显示的是新的菜单栏窗口").toHaveBeenCalledTimes(1);
      });

      it("安装失败恢复后 Dock 激活不再重建，也不碰已销毁的窗口", async () => {
        await boot();
        autoUpdater.quitAndInstall.mockImplementation(squirrelClosesWindows);
        downloaded();
        await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
        handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
        await vi.waitFor(() => expect(windows).toHaveLength(4));

        expect(() => handlerOf(appOn, "activate")()).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
        expect(windows, "窗口都在，不再重建").toHaveLength(4);
        expect(windows[2]!.show).toHaveBeenCalledTimes(1);
      });

      it("安装关窗触发的 window-all-closed 不退出应用，error 之后窗口补回、应用仍活着", async () => {
        await boot();
        autoUpdater.quitAndInstall.mockImplementation(squirrelClosesWindows);
        downloaded();
        await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
        expect(appQuit, "交给 Squirrel 结束进程，窗口全关不触发默认退出").not.toHaveBeenCalled();

        handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
        await vi.waitFor(() => expect(windows).toHaveLength(4));
        expect(appQuit).not.toHaveBeenCalled();
        expect(appExit).not.toHaveBeenCalled();
      });

      it("非安装期窗口全关仍保持 Electron 默认的 app.quit()", async () => {
        await boot();

        handlerOf(appOn, "window-all-closed")();

        expect(appQuit).toHaveBeenCalledTimes(1);
      });

      it("ready 时确认框未答、外部退出、确认返回 true：不安装，相位仍是 quitting", async () => {
        const answer = deferred<{ response: number }>();
        showMessageBox.mockReturnValue(answer.promise);
        await bootWithOnlineAgent();
        downloaded();
        await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1));

        handlerOf(appOn, "before-quit")(fakeEvent());
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT"));
        children[0]?.emit("exit", 0, null);
        await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
        answer.resolve({ response: 0 });
        for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

        expect(autoUpdater.quitAndInstall, "退出之后确认返回 true 也不安装").not.toHaveBeenCalled();
        expect(
          kill.mock.calls.filter(([, signal]) => signal === "SIGINT"),
          "没有第二轮停代理",
        ).toHaveLength(1);
        const closeEvent = fakeEvent();
        menubarClose()(closeEvent);
        expect(closeEvent.preventDefault, "相位仍是 quitting，关窗放行").not.toHaveBeenCalled();
      });

      it("两次停止、强杀、Chrome 回收挂起时 App 不退出，回收完成后才 exit", async () => {
        const reaping = deferred<void>();
        reapGate.current = reaping.promise;
        await bootWithOnlineAgent();
        downloaded();
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT"));

        handlerOf(appOn, "before-quit")(fakeEvent());
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGKILL"), { timeout: 4_000 });
        children[0]?.emit("exit", null, "SIGKILL");
        await vi.waitFor(() => expect(reapedProfiles).toEqual([agentChromeProfile]));
        for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

        expect(appExit, "回收还没完成，第二次停止不能先放行退出").not.toHaveBeenCalled();
        reaping.resolve();
        await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
        expect(
          kill.mock.calls.filter(([, signal]) => signal === "SIGINT"),
          "两次停止只发一次 SIGINT",
        ).toHaveLength(1);
        expect(reapedProfiles, "只回收一次").toHaveLength(1);
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
      }, 10_000);

      it("旧 blur 排队、安装关窗、恢复 running 后，延迟回调不碰已销毁的窗口", async () => {
        await boot();
        autoUpdater.quitAndInstall.mockImplementation(squirrelClosesWindows);
        const queued: Array<() => void> = [];
        const realSetTimeout = globalThis.setTimeout;
        let capturing = false;
        const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
          callback: () => void,
          delay?: number,
          ...rest: unknown[]
        ) => {
          if (capturing && delay === 0) {
            queued.push(callback);
            return 0;
          }
          return realSetTimeout(callback, delay, ...rest);
        }) as never);
        try {
          capturing = true;
          handlerOf(windows[1]!.on, "blur")();
          capturing = false;
          expect(queued).toHaveLength(1);
          downloaded();
          await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
          handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
          await vi.waitFor(() => expect(windows).toHaveLength(4));

          expect(() => queued[0]!(), "旧窗口已销毁，回调先确认再用").not.toThrow();
          expect(windows[1]!.hide).not.toHaveBeenCalled();
        } finally {
          timer.mockRestore();
        }
      });

      it("停代理等待期间 before-quit 被拦下，停机完成后退出，不再调用安装", async () => {
        await bootWithOnlineAgent();
        downloaded();
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT"));

        const quitEvent = fakeEvent();
        handlerOf(appOn, "before-quit")(quitEvent);
        expect(quitEvent.preventDefault, "准备期的外部退出不放行").toHaveBeenCalledTimes(1);
        expect(appExit, "代理还没停好，不能退出").not.toHaveBeenCalled();

        children[0]?.emit("exit", 0, null);
        await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
        await new Promise((resolve) => setImmediate(resolve));
        expect(autoUpdater.quitAndInstall, "退出之后不再安装").not.toHaveBeenCalled();
      });

      it("准备期外部退出之后到的 error 不会把相位拉回 running，也不重起代理", async () => {
        await bootWithOnlineAgent();
        downloaded();
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT"));
        handlerOf(appOn, "before-quit")(fakeEvent());

        showMessageBox.mockClear();
        handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
        children[0]?.emit("exit", 0, null);
        await vi.waitFor(() => expect(appExit).toHaveBeenCalledWith(0));
        expect(showMessageBox, "updater 已 stop，退出中不再弹安装失败").not.toHaveBeenCalled();
        expect(children, "退出中不再起代理").toHaveLength(1);
        expect(windows, "退出中不重建窗口").toHaveLength(2);
      });

      it("准备期收到 error 恢复之后，停代理完成的旧续作不再安装", async () => {
        const out = vi.spyOn(process.stdout, "write");
        try {
          await bootWithOnlineAgent();
          downloaded();
          await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-(FAKE_PID_BASE + 0), "SIGINT"));

          handlerOf(autoUpdater.on, "error")(new Error("Failed to launch ShipIt"));
          await vi.waitFor(() => expect(children, "恢复路径起了替换代理").toHaveLength(2));
          children[0]?.emit("exit", 0, null);
          await vi.waitFor(() =>
            expect(out.mock.calls.some(([chunk]) => String(chunk).includes("update-install-stale"))).toBe(true),
          );

          expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
          const closeEvent = fakeEvent();
          menubarClose()(closeEvent);
          expect(closeEvent.preventDefault, "相位回到 running，关窗只是隐藏").toHaveBeenCalledTimes(1);
        } finally {
          out.mockRestore();
        }
      });
    });
  });
});
