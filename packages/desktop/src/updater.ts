import type { AutoUpdater } from "electron";
import { isSecureTransport } from "./origin.js";

export type UpdateState =
  | { readonly status: "idle" }
  | { readonly status: "checking"; readonly manual: boolean }
  | { readonly status: "downloading"; readonly manual: boolean }
  | { readonly status: "ready"; readonly version: string }
  | { readonly status: "installing"; readonly version: string }
  | { readonly status: "none" }
  | { readonly status: "unsupported"; readonly reason: "dev" | "unsigned" }
  | { readonly status: "error"; readonly message: string; readonly stage: ErrorStage };

export type ErrorStage = "init" | "check";

export type UpdateEvent =
  | { readonly type: "check"; readonly manual: boolean }
  | { readonly type: "available" }
  | { readonly type: "not-available" }
  | { readonly type: "downloaded"; readonly version: string }
  | { readonly type: "restart-confirmed" }
  | { readonly type: "retry-init" }
  | { readonly type: "failed"; readonly message: string };

export type UpdateEffect =
  | { readonly type: "init" }
  | { readonly type: "start-check" }
  | { readonly type: "ask-restart"; readonly version: string }
  | { readonly type: "install" }
  | { readonly type: "install-failed"; readonly message: string }
  | { readonly type: "inform"; readonly level: "info" | "error"; readonly text: string };

export const UNSIGNED_TEXT = "这个版本没有正式签名，不能自动更新";
export const DEV_TEXT = "开发运行的白泽不检查更新";
export const LATEST_TEXT = "当前已是最新版本";
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const SIGNATURE_ERROR = /code ?sign|signature|code requirement|not signed|unsigned/iu;

export const isSignatureError = (message: string): boolean => SIGNATURE_ERROR.test(message);

export const restartPrompt = (version: string): { readonly message: string; readonly detail: string } => ({
  message: version === "" ? "新版本已下载，重启后生效" : `新版本 ${version} 已下载，重启后生效`,
  detail: "现在重启会先停掉电脑代理，再安装更新。",
});

export function defaultUpdateFeed(controlOrigin: string, arch: string): string {
  return `${controlOrigin}/desktop/darwin-${arch}/releases.json`;
}

export function resolveUpdateFeed(
  settings: { readonly updateFeed?: string },
  controlOrigin: string,
  arch: string,
): string {
  return settings.updateFeed ?? defaultUpdateFeed(controlOrigin, arch);
}

export function parseUpdateFeed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return isSecureTransport(url) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const initialUpdateState = (packaged: boolean): UpdateState =>
  packaged ? { status: "idle" } : { status: "unsupported", reason: "dev" };

const checkFailedText = (message: string): string => `检查更新失败：${message}`;

const unsupportedText = (reason: "dev" | "unsigned"): string => (reason === "dev" ? DEV_TEXT : UNSIGNED_TEXT);

const stay = (state: UpdateState): { readonly next: UpdateState; readonly effect: null } => ({
  next: state,
  effect: null,
});

export function decide(
  state: UpdateState,
  event: UpdateEvent,
): { readonly next: UpdateState; readonly effect: UpdateEffect | null } {
  switch (event.type) {
    case "check":
      switch (state.status) {
        case "checking":
        case "downloading":
          return stay({ ...state, manual: state.manual || event.manual });
        case "ready":
          return { next: state, effect: event.manual ? { type: "ask-restart", version: state.version } : null };
        case "installing":
          return stay(state);
        case "unsupported":
          return {
            next: state,
            effect: event.manual ? { type: "inform", level: "info", text: unsupportedText(state.reason) } : null,
          };
        case "error":
          if (state.stage === "init") {
            return {
              next: state,
              effect: event.manual ? { type: "inform", level: "error", text: checkFailedText(state.message) } : null,
            };
          }
          return { next: { status: "checking", manual: event.manual }, effect: { type: "start-check" } };
        case "idle":
        case "none":
          return { next: { status: "checking", manual: event.manual }, effect: { type: "start-check" } };
      }
    case "available":
      return state.status === "checking" ? stay({ status: "downloading", manual: state.manual }) : stay(state);
    case "not-available":
      if (state.status !== "checking" && state.status !== "downloading") return stay(state);
      return {
        next: { status: "none" },
        effect: state.manual ? { type: "inform", level: "info", text: LATEST_TEXT } : null,
      };
    case "downloaded":
      if (state.status !== "checking" && state.status !== "downloading") return stay(state);
      return {
        next: { status: "ready", version: event.version },
        effect: { type: "ask-restart", version: event.version },
      };
    case "restart-confirmed":
      return state.status === "ready"
        ? { next: { status: "installing", version: state.version }, effect: { type: "install" } }
        : stay(state);
    case "retry-init":
      return state.status === "error" && state.stage === "init"
        ? { next: { status: "idle" }, effect: { type: "init" } }
        : stay(state);
    case "failed": {
      if (state.status === "installing") {
        return {
          next: { status: "error", message: event.message, stage: "check" },
          effect: { type: "install-failed", message: event.message },
        };
      }
      if (state.status !== "idle" && state.status !== "checking" && state.status !== "downloading") return stay(state);
      const manual = state.status !== "idle" && state.manual;
      if (isSignatureError(event.message)) {
        return {
          next: { status: "unsupported", reason: "unsigned" },
          effect: manual ? { type: "inform", level: "info", text: UNSIGNED_TEXT } : null,
        };
      }
      return {
        next: { status: "error", message: event.message, stage: state.status === "idle" ? "init" : "check" },
        effect: manual ? { type: "inform", level: "error", text: checkFailedText(event.message) } : null,
      };
    }
  }
}

export type UpdaterSource = Pick<AutoUpdater, "setFeedURL" | "checkForUpdates" | "quitAndInstall" | "on">;

export type UpdaterDeps = {
  readonly packaged: boolean;
  readonly feedUrl: string;
  readonly source: UpdaterSource;
  readonly askRestart: (prompt: { readonly message: string; readonly detail: string }) => Promise<boolean>;
  readonly inform: (level: "info" | "error", text: string) => void;
  readonly prepareInstall: () => Promise<void>;
  readonly commitInstall: () => void;
  readonly resumeAfterFailedInstall: () => void;
  readonly log: (line: string) => void;
};

export type Updater = {
  readonly start: () => void;
  readonly checkNow: () => void;
  readonly stop: () => void;
  readonly state: () => UpdateState;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createUpdater(deps: UpdaterDeps): Updater {
  let state = initialUpdateState(deps.packaged);
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  let installRound = 0;

  const initialize = (): void => {
    try {
      deps.source.setFeedURL({ url: deps.feedUrl, serverType: "json" });
    } catch (error) {
      dispatch({ type: "failed", message: messageOf(error) });
    }
    if (state.status === "idle" && timer === null) {
      timer = setInterval(() => dispatch({ type: "check", manual: false }), CHECK_INTERVAL_MS);
    }
  };

  const install = (): void => {
    const round = ++installRound;
    const current = (): boolean => round === installRound && state.status === "installing";
    deps
      .prepareInstall()
      .then(() => {
        if (!current()) {
          deps.log("update-install-stale");
          return;
        }
        deps.commitInstall();
        deps.source.quitAndInstall();
      })
      .catch((error: unknown) => {
        if (current()) dispatch({ type: "failed", message: messageOf(error) });
        else deps.log(`update-install-stale ${messageOf(error)}`);
      });
  };

  const run = (effect: UpdateEffect): void => {
    switch (effect.type) {
      case "init":
        initialize();
        return;
      case "start-check":
        try {
          deps.source.checkForUpdates();
        } catch (error) {
          dispatch({ type: "failed", message: messageOf(error) });
        }
        return;
      case "inform":
        deps.inform(effect.level, effect.text);
        return;
      case "ask-restart":
        void deps
          .askRestart(restartPrompt(effect.version))
          .then((confirmed) => (confirmed ? dispatch({ type: "restart-confirmed" }) : undefined))
          .catch((error: unknown) => {
            deps.log(`update-restart-failed ${messageOf(error)}`);
            deps.inform("error", `重启安装失败：${messageOf(error)}`);
          });
        return;
      case "install":
        install();
        return;
      case "install-failed":
        deps.inform("error", `重启安装失败：${effect.message}`);
        deps.resumeAfterFailedInstall();
        return;
    }
  };

  function dispatch(event: UpdateEvent): void {
    const { next, effect } = decide(state, event);
    if (next.status !== state.status) deps.log(`update-state ${state.status} -> ${next.status} (${event.type})`);
    if (event.type === "failed") deps.log(`update-error ${event.message}`);
    state = next;
    if (effect !== null) run(effect);
  }

  const start = (): void => {
    if (!deps.packaged || started) return;
    started = true;
    const { source } = deps;
    source.on("update-available", () => dispatch({ type: "available" }));
    source.on("update-not-available", () => dispatch({ type: "not-available" }));
    source.on("update-downloaded", (_event, _notes, name) => dispatch({ type: "downloaded", version: name }));
    source.on("error", (error) => dispatch({ type: "failed", message: error.message }));
    initialize();
    if (state.status === "idle") dispatch({ type: "check", manual: false });
  };

  return {
    start,
    checkNow: () => {
      dispatch({ type: "retry-init" });
      dispatch({ type: "check", manual: true });
    },
    stop: () => {
      installRound += 1;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    state: () => state,
  };
}
