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
      next: { status: "error", message: "net down" },
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
      beforeRestart: async () => {
        order.push("stopAgent");
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
    await vi.waitFor(() => expect(order).toEqual(["stopAgent", "quitAndInstall"]));
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
    expect(updater.state()).toEqual({ status: "error", message: "boom" });
  });

  it("未打包不订阅也不检查，手动检查说明开发态不更新", () => {
    const updater = createUpdater({ ...deps, packaged: false });
    updater.start();
    updater.checkNow();
    expect(source.setFeedURL).not.toHaveBeenCalled();
    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(inform).toHaveBeenCalledWith("info", DEV_TEXT);
  });
});
