import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  DEV_TEXT,
  LATEST_TEXT,
  UNSIGNED_TEXT,
  createUpdater,
  decide,
  defaultUpdateFeed,
  isSignatureError,
  parseUpdateFeed,
  resolveUpdateFeed,
  type UpdateEvent,
  type UpdateState,
  type UpdaterDeps,
} from "../src/updater.js";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function replay(from: UpdateState, events: readonly UpdateEvent[]): UpdateState {
  return events.reduce((state, event) => decide(state, event).next, from);
}

describe("更新状态机", () => {
  it("检查到无更新进 none，手动检查提示已是最新，自动检查不打扰", () => {
    const manual = decide({ status: "checking", manual: true }, { type: "not-available" });
    expect(manual).toEqual({ next: { status: "none" }, effect: { type: "inform", level: "info", text: LATEST_TEXT } });
    expect(decide({ status: "checking", manual: false }, { type: "not-available" })).toEqual({
      next: { status: "none" },
      effect: null,
    });
  });

  it("有更新经 downloading 到 ready，并要求弹重启对话框", () => {
    let state: UpdateState = { status: "idle" };
    state = decide(state, { type: "check", manual: false }).next;
    expect(state).toEqual({ status: "checking", manual: false });
    state = decide(state, { type: "available" }).next;
    expect(state).toEqual({ status: "downloading", manual: false });
    expect(decide(state, { type: "downloaded", version: "0.2.0" })).toEqual({
      next: { status: "ready", version: "0.2.0" },
      effect: { type: "ask-restart", version: "0.2.0" },
    });
  });

  it("签名类错误进 unsupported：手动检查给文案，自动检查静默", () => {
    const message = "Could not get code signature for running application";
    expect(decide({ status: "checking", manual: true }, { type: "failed", message })).toEqual({
      next: { status: "unsupported", reason: "unsigned" },
      effect: { type: "inform", level: "info", text: UNSIGNED_TEXT },
    });
    expect(decide({ status: "checking", manual: false }, { type: "failed", message })).toEqual({
      next: { status: "unsupported", reason: "unsigned" },
      effect: null,
    });
  });

  it("其他错误进 error，只在手动检查时提示，之后还能再检查", () => {
    const failed = decide({ status: "downloading", manual: true }, { type: "failed", message: "net down" });
    expect(failed).toEqual({
      next: { status: "error", message: "net down", stage: "check" },
      effect: { type: "inform", level: "error", text: "检查更新失败：net down" },
    });
    expect(decide(failed.next, { type: "check", manual: false }).effect).toEqual({ type: "start-check" });
  });

  it("检查中途手动点检查，不重复发起，但结果要提示", () => {
    const joined = decide({ status: "checking", manual: false }, { type: "check", manual: true });
    expect(joined).toEqual({ next: { status: "checking", manual: true }, effect: null });
    expect(decide(joined.next, { type: "not-available" }).effect).toEqual({
      type: "inform",
      level: "info",
      text: LATEST_TEXT,
    });
  });

  it("ready 后自动检查不动，手动检查重新弹对话框", () => {
    const ready: UpdateState = { status: "ready", version: "0.2.0" };
    expect(decide(ready, { type: "check", manual: false })).toEqual({ next: ready, effect: null });
    expect(decide(ready, { type: "check", manual: true }).effect).toEqual({ type: "ask-restart", version: "0.2.0" });
    expect(replay(ready, [{ type: "failed", message: "x" }, { type: "not-available" }])).toEqual(ready);
  });

  it("unsupported 不再发起检查，手动检查只重复文案", () => {
    expect(decide({ status: "unsupported", reason: "unsigned" }, { type: "check", manual: false })).toEqual({
      next: { status: "unsupported", reason: "unsigned" },
      effect: null,
    });
    expect(decide({ status: "unsupported", reason: "dev" }, { type: "check", manual: true }).effect).toEqual({
      type: "inform",
      level: "info",
      text: DEV_TEXT,
    });
  });

  it("确认重启后进 installing，之后的检查、下载事件都不再触发副作用", () => {
    const ready: UpdateState = { status: "ready", version: "0.2.0" };
    const installing = decide(ready, { type: "restart-confirmed" });
    expect(installing).toEqual({ next: { status: "installing", version: "0.2.0" }, effect: { type: "install" } });
    expect(decide(installing.next, { type: "restart-confirmed" })).toEqual({ next: installing.next, effect: null });
    expect(decide(installing.next, { type: "check", manual: true })).toEqual({ next: installing.next, effect: null });
    expect(decide(installing.next, { type: "downloaded", version: "0.3.0" })).toEqual({
      next: installing.next,
      effect: null,
    });
    expect(decide({ status: "none" }, { type: "restart-confirmed" }).effect).toBeNull();
  });

  it("installing 收到错误进 error 并要求提示和恢复，不论签名与否", () => {
    const installing: UpdateState = { status: "installing", version: "0.2.0" };
    expect(decide(installing, { type: "failed", message: "Failed to launch ShipIt" })).toEqual({
      next: { status: "error", message: "Failed to launch ShipIt", stage: "check" },
      effect: { type: "install-failed", message: "Failed to launch ShipIt" },
    });
    expect(decide(installing, { type: "failed", message: "code signature invalid" }).next.status).toBe("error");
  });

  it("idle 阶段收到错误按检查失败分类，且不提示", () => {
    expect(decide({ status: "idle" }, { type: "failed", message: "Could not get code signature" })).toEqual({
      next: { status: "unsupported", reason: "unsigned" },
      effect: null,
    });
    expect(decide({ status: "idle" }, { type: "failed", message: "read-only volume" })).toEqual({
      next: { status: "error", message: "read-only volume", stage: "init" },
      effect: null,
    });
  });

  it("初始化失败的 error 不发起检查：手动检查直接提示已有错误，自动检查静默", () => {
    const failedInit: UpdateState = { status: "error", message: "bad feed", stage: "init" };
    expect(decide(failedInit, { type: "check", manual: true })).toEqual({
      next: failedInit,
      effect: { type: "inform", level: "error", text: "检查更新失败：bad feed" },
    });
    expect(decide(failedInit, { type: "check", manual: false })).toEqual({ next: failedInit, effect: null });
  });

  it("retry-init 只把初始化失败的 error 放回 idle 并要求重新初始化", () => {
    expect(decide({ status: "error", message: "bad feed", stage: "init" }, { type: "retry-init" })).toEqual({
      next: { status: "idle" },
      effect: { type: "init" },
    });
    const checkFailed: UpdateState = { status: "error", message: "net down", stage: "check" };
    expect(decide(checkFailed, { type: "retry-init" })).toEqual({ next: checkFailed, effect: null });
    expect(decide({ status: "none" }, { type: "retry-init" }).effect).toBeNull();
  });

  it("stop 进入终态 stopped：之后任何事件都不改状态、不产生副作用", () => {
    const events: UpdateEvent[] = [
      { type: "check", manual: true },
      { type: "check", manual: false },
      { type: "available" },
      { type: "not-available" },
      { type: "downloaded", version: "0.2.0" },
      { type: "restart-confirmed" },
      { type: "retry-init" },
      { type: "failed", message: "Failed to launch ShipIt" },
      { type: "stop" },
    ];
    const states: UpdateState[] = [
      { status: "idle" },
      { status: "checking", manual: true },
      { status: "ready", version: "0.2.0" },
      { status: "installing", version: "0.2.0" },
      { status: "error", message: "bad feed", stage: "init" },
    ];
    for (const from of states) {
      expect(decide(from, { type: "stop" }), `${from.status} 收到 stop`).toEqual({
        next: { status: "stopped" },
        effect: null,
      });
      for (const event of events) {
        expect(decide({ status: "stopped" }, event), `stopped 收到 ${event.type}`).toEqual({
          next: { status: "stopped" },
          effect: null,
        });
      }
    }
  });

  it("只有签名类报错文案被当成签名错误", () => {
    expect(isSignatureError("Code signature at URL file:///x did not pass validation")).toBe(true);
    expect(isSignatureError("The application is not code signed")).toBe(true);
    expect(isSignatureError("A server with the specified hostname could not be found.")).toBe(false);
  });
});

describe("更新源 URL", () => {
  it("settings 里有 updateFeed 就用它", () => {
    expect(
      resolveUpdateFeed({ updateFeed: "https://cdn.example.com/r.json" }, "https://baize.example.com", "arm64"),
    ).toBe("https://cdn.example.com/r.json");
  });

  it("没有就按 controlOrigin 和 arch 拼", () => {
    expect(resolveUpdateFeed({}, "https://baize.example.com", "arm64")).toBe(
      "https://baize.example.com/desktop/darwin-arm64/releases.json",
    );
    expect(defaultUpdateFeed("http://localhost:3001", "x64")).toBe(
      "http://localhost:3001/desktop/darwin-x64/releases.json",
    );
  });

  it("设置文件里的 updateFeed 只认 https 或本机 http", () => {
    expect(parseUpdateFeed("https://cdn.example.com/r.json")).toBe("https://cdn.example.com/r.json");
    expect(parseUpdateFeed("http://127.0.0.1:8000/releases.json")).toBe("http://127.0.0.1:8000/releases.json");
    expect(parseUpdateFeed("http://cdn.example.com/r.json")).toBeUndefined();
    expect(parseUpdateFeed("not a url")).toBeUndefined();
    expect(parseUpdateFeed(42)).toBeUndefined();
  });
});

describe("更新器接线", () => {
  class FakeSource extends EventEmitter {
    readonly setFeedURL = vi.fn();
    readonly checkForUpdates = vi.fn();
    readonly quitAndInstall = vi.fn();
  }

  let source: FakeSource;
  let order: string[];
  let deps: UpdaterDeps;
  const askRestart = vi.fn<UpdaterDeps["askRestart"]>();
  const inform = vi.fn<UpdaterDeps["inform"]>();

  beforeEach(() => {
    vi.useFakeTimers();
    source = new FakeSource();
    order = [];
    askRestart.mockReset().mockResolvedValue(true);
    inform.mockReset();
    source.quitAndInstall.mockImplementation(() => order.push("quitAndInstall"));
    deps = {
      packaged: true,
      feedUrl: "http://localhost:3001/desktop/darwin-arm64/releases.json",
      source: source as never,
      askRestart,
      inform,
      prepareInstall: async () => {
        order.push("stopAgent");
      },
      commitInstall: () => {
        order.push("commit");
      },
      resumeAfterFailedInstall: () => {
        order.push("resume");
      },
      log: () => undefined,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动时设置 feed 并检查一次，之后每 6 小时一次", () => {
    const updater = createUpdater(deps);
    updater.start();
    expect(source.setFeedURL).toHaveBeenCalledWith({ url: deps.feedUrl, serverType: "json" });
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1);
    source.emit("update-not-available");
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(source.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.stop();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(source.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("下载完弹对话框，点「现在重启」先停代理再 quitAndInstall", async () => {
    createUpdater(deps).start();
    source.emit("update-available");
    source.emit("update-downloaded", {}, "notes", "0.2.0", new Date(), "url");
    expect(askRestart).toHaveBeenCalledWith({
      message: "新版本 0.2.0 已下载，重启后生效",
      detail: expect.any(String),
    });
    await vi.waitFor(() => expect(order).toEqual(["stopAgent", "commit", "quitAndInstall"]));
  });

  it("点「稍后」不停代理也不安装", async () => {
    askRestart.mockResolvedValue(false);
    createUpdater(deps).start();
    source.emit("update-downloaded", {}, "", "0.2.0");
    await vi.waitFor(() => expect(askRestart).toHaveBeenCalled());
    await Promise.resolve();
    expect(order).toEqual([]);
  });

  it("ad-hoc 签名的包：自动检查失败静默，手动检查弹没有正式签名", () => {
    const updater = createUpdater(deps);
    updater.start();
    source.emit("error", new Error("Could not get code signature for running application"));
    expect(inform).not.toHaveBeenCalled();
    expect(updater.state()).toEqual({ status: "unsupported", reason: "unsigned" });

    updater.checkNow();
    expect(inform).toHaveBeenCalledWith("info", UNSIGNED_TEXT);
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("手动检查时 Squirrel 报签名错误，直接弹没有正式签名", () => {
    const updater = createUpdater(deps);
    updater.start();
    source.emit("update-not-available");
    updater.checkNow();
    source.emit("error", new Error("Code signature at URL file:///x did not pass validation"));
    expect(inform).toHaveBeenCalledWith("info", UNSIGNED_TEXT);
  });

  it("checkForUpdates 同步抛错也走失败分支，不崩", () => {
    source.checkForUpdates.mockImplementation(() => {
      throw new Error("boom");
    });
    const updater = createUpdater(deps);
    updater.start();
    expect(updater.state()).toEqual({ status: "error", message: "boom", stage: "check" });
  });

  it("未打包不订阅也不检查，手动检查说明开发态不更新", () => {
    const updater = createUpdater({ ...deps, packaged: false });
    updater.start();
    updater.checkNow();
    expect(source.setFeedURL).not.toHaveBeenCalled();
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(inform).toHaveBeenCalledWith("info", DEV_TEXT);
  });

  it("初始化 setFeedURL 时同步报签名错误：进 unsupported，不检查，手动检查弹没有正式签名", () => {
    source.setFeedURL.mockImplementation(() => {
      source.emit("error", new Error("Could not get code signature for running application"));
    });
    const updater = createUpdater(deps);
    updater.start();
    expect(updater.state()).toEqual({ status: "unsupported", reason: "unsigned" });
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(inform).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(source.checkForUpdates, "初始化失败后定时检查也不发起").not.toHaveBeenCalled();
    updater.checkNow();
    expect(inform).toHaveBeenCalledWith("info", UNSIGNED_TEXT);
    expect(source.checkForUpdates).not.toHaveBeenCalled();
  });

  it("setFeedURL 抛异常按同一条路径处理", () => {
    source.setFeedURL.mockImplementation(() => {
      throw new Error("bad feed");
    });
    const updater = createUpdater(deps);
    updater.start();
    expect(updater.state()).toEqual({ status: "error", message: "bad feed", stage: "init" });
    expect(source.checkForUpdates).not.toHaveBeenCalled();
  });

  it("安装阶段 quitAndInstall 异步报错：提示失败并恢复代理，状态不停在 ready", async () => {
    const updater = createUpdater(deps);
    updater.start();
    source.emit("update-downloaded", {}, "", "0.2.0");
    await vi.waitFor(() => expect(order).toEqual(["stopAgent", "commit", "quitAndInstall"]));
    expect(updater.state()).toEqual({ status: "installing", version: "0.2.0" });

    source.emit("error", new Error("Failed to launch ShipIt"));
    expect(updater.state()).toEqual({ status: "error", message: "Failed to launch ShipIt", stage: "check" });
    expect(inform).toHaveBeenCalledWith("error", "重启安装失败：Failed to launch ShipIt");
    expect(order).toEqual(["stopAgent", "commit", "quitAndInstall", "resume"]);
  });

  it("停代理失败也算安装失败：不调 quitAndInstall，提示并恢复", async () => {
    deps = {
      ...deps,
      prepareInstall: async () => {
        throw new Error("stop failed");
      },
    };
    const updater = createUpdater(deps);
    updater.start();
    source.emit("update-downloaded", {}, "", "0.2.0");
    await vi.waitFor(() => expect(inform).toHaveBeenCalledWith("error", "重启安装失败：stop failed"));
    expect(source.quitAndInstall).not.toHaveBeenCalled();
    expect(order).toEqual(["resume"]);
  });

  it("停代理等待期间再次手动检查，安装流程只进一次", async () => {
    const gate = deferred<void>();
    const prepare = vi.fn(() => gate.promise);
    const updater = createUpdater({ ...deps, prepareInstall: prepare });
    updater.start();
    source.emit("update-downloaded", {}, "", "0.2.0");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));

    updater.checkNow();
    await Promise.resolve();
    expect(askRestart, "安装中不再弹第二张确认").toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.waitFor(() => expect(source.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it("两张重启对话框先后确认，只安装一次", async () => {
    const answers: Array<(value: boolean) => void> = [];
    askRestart.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const updater = createUpdater(deps);
    updater.start();
    source.emit("update-downloaded", {}, "", "0.2.0");
    updater.checkNow();
    expect(answers).toHaveLength(2);
    answers[0]?.(true);
    await vi.waitFor(() => expect(source.quitAndInstall).toHaveBeenCalledTimes(1));
    answers[1]?.(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(order.filter((item) => item === "stopAgent")).toHaveLength(1);
  });

  describe("安装代次", () => {
    const confirm = (): void => {
      source.emit("update-downloaded", {}, "", "0.2.0");
    };

    it("准备期收到 error 恢复之后，旧的准备完成不再 commit 也不 quitAndInstall", async () => {
      const gate = deferred<void>();
      const updater = createUpdater({ ...deps, prepareInstall: () => gate.promise });
      updater.start();
      confirm();
      await vi.waitFor(() => expect(updater.state().status).toBe("installing"));

      source.emit("error", new Error("Failed to launch ShipIt"));
      expect(order, "error 立刻提示并恢复").toEqual(["resume"]);
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(order, "旧续作不再 commit").toEqual(["resume"]);
      expect(source.quitAndInstall).not.toHaveBeenCalled();
      expect(updater.state().status).toBe("error");
    });

    it("失败后又开了新一轮安装，旧续作仍不能抢先安装", async () => {
      const gates = [deferred<void>(), deferred<void>()];
      const prepare = vi
        .fn<UpdaterDeps["prepareInstall"]>()
        .mockImplementation(() => gates[prepare.mock.calls.length - 1]!.promise);
      const updater = createUpdater({ ...deps, prepareInstall: prepare });
      updater.start();
      confirm();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      source.emit("error", new Error("first round failed"));

      updater.checkNow();
      confirm();
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
      expect(updater.state().status).toBe("installing");

      gates[0]!.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(source.quitAndInstall, "旧代次不能替新一轮安装").not.toHaveBeenCalled();

      gates[1]!.resolve();
      await vi.waitFor(() => expect(source.quitAndInstall).toHaveBeenCalledTimes(1));
    });

    it("stop() 之后准备期的续作作废，退出路径不会再调用安装", async () => {
      const gate = deferred<void>();
      const updater = createUpdater({ ...deps, prepareInstall: () => gate.promise });
      updater.start();
      confirm();
      await vi.waitFor(() => expect(updater.state().status).toBe("installing"));

      updater.stop();
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(source.quitAndInstall).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });

    it("ready 时确认框未答、stop 之后确认返回 true：不开新一轮安装，状态仍是 stopped", async () => {
      const answer = deferred<boolean>();
      const prepare = vi.fn(async () => undefined);
      const updater = createUpdater({ ...deps, askRestart: () => answer.promise, prepareInstall: prepare });
      updater.start();
      confirm();
      expect(updater.state()).toEqual({ status: "ready", version: "0.2.0" });

      updater.stop();
      answer.resolve(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(prepare, "停止后确认结果不能开出新一轮安装").not.toHaveBeenCalled();
      expect(source.quitAndInstall).not.toHaveBeenCalled();
      expect(updater.state()).toEqual({ status: "stopped" });
    });

    it("stop 之后迟到的 downloaded、error 和手动检查都不动状态", () => {
      const updater = createUpdater(deps);
      updater.start();
      updater.stop();
      inform.mockClear();

      source.emit("update-downloaded", {}, "", "0.2.0");
      source.emit("error", new Error("late failure"));
      updater.checkNow();

      expect(updater.state()).toEqual({ status: "stopped" });
      expect(askRestart).not.toHaveBeenCalled();
      expect(inform).not.toHaveBeenCalled();
      expect(source.checkForUpdates, "只有启动那一次").toHaveBeenCalledTimes(1);
    });

    it("过期的准备失败不会把别的状态拖进 error", async () => {
      const gate = deferred<void>();
      const rejecting = vi.fn(async () => {
        await gate.promise;
        throw new Error("late stop failure");
      });
      const updater = createUpdater({ ...deps, prepareInstall: rejecting });
      updater.start();
      confirm();
      await vi.waitFor(() => expect(rejecting).toHaveBeenCalled());
      source.emit("error", new Error("Failed to launch ShipIt"));
      source.emit("update-not-available");
      updater.checkNow();
      expect(updater.state()).toEqual({ status: "checking", manual: true });

      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(updater.state()).toEqual({ status: "checking", manual: true });
    });
  });

  describe("初始化失败", () => {
    it("非签名的初始化异常后，手动检查重试一次初始化，成功就正常检查", () => {
      source.setFeedURL.mockImplementationOnce(() => {
        throw new Error("bad feed");
      });
      const updater = createUpdater(deps);
      updater.start();
      expect(updater.state()).toEqual({ status: "error", message: "bad feed", stage: "init" });
      expect(source.checkForUpdates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);
      expect(source.checkForUpdates, "初始化失败时没有定时检查").not.toHaveBeenCalled();

      updater.checkNow();
      expect(source.setFeedURL).toHaveBeenCalledTimes(2);
      expect(source.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(updater.state()).toEqual({ status: "checking", manual: true });
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);
      expect(source.checkForUpdates, "重试成功后恢复定时检查").toHaveBeenCalledTimes(1);
      source.emit("update-not-available");
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);
      expect(source.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it("重试仍失败：直接提示已有错误，不进 checking，也不发起检查", () => {
      source.setFeedURL.mockImplementation(() => {
        throw new Error("bad feed");
      });
      const updater = createUpdater(deps);
      updater.start();
      expect(inform).not.toHaveBeenCalled();

      updater.checkNow();
      expect(updater.state()).toEqual({ status: "error", message: "bad feed", stage: "init" });
      expect(inform).toHaveBeenCalledTimes(1);
      expect(inform).toHaveBeenCalledWith("error", "检查更新失败：bad feed");
      expect(source.checkForUpdates).not.toHaveBeenCalled();
    });

    it("初始化失败后 stop，再手动检查：不重试初始化也不建 6 小时定时器", () => {
      source.setFeedURL.mockImplementationOnce(() => {
        throw new Error("bad feed");
      });
      const updater = createUpdater(deps);
      updater.start();
      updater.stop();

      updater.checkNow();

      expect(source.setFeedURL, "stop 之后不再初始化").toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount(), "stop 之后不再有定时器").toBe(0);
      vi.advanceTimersByTime(CHECK_INTERVAL_MS);
      expect(source.checkForUpdates).not.toHaveBeenCalled();
      expect(updater.state()).toEqual({ status: "stopped" });
    });

    it("stop 之后才 start：不订阅、不初始化", () => {
      const updater = createUpdater(deps);
      updater.stop();
      updater.start();

      expect(source.setFeedURL).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("重试时才暴露签名错误：按 unsupported 弹没有正式签名", () => {
      source.setFeedURL.mockImplementationOnce(() => {
        throw new Error("bad feed");
      });
      const updater = createUpdater(deps);
      updater.start();
      source.setFeedURL.mockImplementationOnce(() => {
        source.emit("error", new Error("Could not get code signature for running application"));
      });

      updater.checkNow();
      expect(updater.state()).toEqual({ status: "unsupported", reason: "unsigned" });
      expect(inform).toHaveBeenCalledWith("info", UNSIGNED_TEXT);
      expect(source.checkForUpdates).not.toHaveBeenCalled();
    });
  });
});
