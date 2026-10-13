import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session as electronSession,
  Tray,
  autoUpdater,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type Rectangle,
  type Session,
} from "electron";
import {
  BotListResponse,
  AgentLaunch,
  ComputerTokenResponse,
  GroupListResponse,
  type ComputerId,
  type NotifyKind,
} from "@baize/shared";
import WebSocket from "ws";
import { chromeProfileDir, reapProfileChromes } from "@baize/computer-agent/chrome-process";
import {
  currentAgentChild,
  isCurrentAgent,
  shouldReportStartFailure,
  shouldRetryPush,
  type AgentState,
} from "./agent-state.js";
import { menuTemplate } from "./menu.js";
import { normalizedOrigin } from "./origin.js";
import { receiveServerPush } from "./push.js";
import { startUiServer } from "./proxy.js";
import { createUpdater, parseUpdateFeed, resolveUpdateFeed, type Updater } from "./updater.js";

const startedAt = Date.now();
const DEFAULT_CONTROL_ORIGIN = "http://localhost:3001";
const AGENT_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL"] as const;

type AppPhase = "running" | "installing" | "quitting";
type Settings = { readonly controlOrigin: string; readonly updateFeed?: string };
type CredentialFile = { readonly computerId: ComputerId; readonly encryptedToken: string };
let mainWindow: BrowserWindow | null = null;
let menubarWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentState: AgentState = { status: "none" };
let pushSocket: WebSocket | null = null;
let pushRetry: NodeJS.Timeout | null = null;
let pushGeneration = 0;
let phase: AppPhase = "running";
let provisioning: Promise<void> | null = null;
let controlOrigin = DEFAULT_CONTROL_ORIGIN;
let uiOrigin = "";
let authHookInstalled = false;
let settings: Settings = { controlOrigin: DEFAULT_CONTROL_ORIGIN };
let updater: Updater | null = null;

const logLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function desktopPaths(): { readonly agent: string; readonly web: string } {
  if (app.isPackaged) return { agent: join(process.resourcesPath, "agent.mjs"), web: join(app.getAppPath(), "web") };
  const here = dirname(fileURLToPath(import.meta.url));
  return { agent: join(here, "agent.mjs"), web: join(here, "web") };
}

const settingsPath = (): string => join(app.getPath("userData"), "desktop-settings.json");
const credentialsPath = (): string => join(app.getPath("userData"), "computer-credentials.json");

async function loadSettings(): Promise<Settings> {
  const override = process.argv
    .find((value) => value.startsWith("--control-origin="))
    ?.slice("--control-origin=".length);
  let stored: Settings = { controlOrigin: DEFAULT_CONTROL_ORIGIN };
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (typeof value === "object" && value !== null) {
      const updateFeed = "updateFeed" in value ? parseUpdateFeed(value.updateFeed) : undefined;
      stored = {
        controlOrigin:
          "controlOrigin" in value ? normalizedOrigin(String(value.controlOrigin)) : DEFAULT_CONTROL_ORIGIN,
        ...(updateFeed === undefined ? {} : { updateFeed }),
      };
    }
  } catch {
    // 首次启动没有设置文件。
  }
  return override === undefined ? stored : { ...stored, controlOrigin: normalizedOrigin(override) };
}

async function saveSettings(next: Settings): Promise<void> {
  await writeFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

async function saveCredentials(value: { readonly computerId: ComputerId; readonly token: string }): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，不能安全保存电脑 token");
  const stored: CredentialFile = {
    computerId: value.computerId,
    encryptedToken: safeStorage.encryptString(value.token).toString("base64"),
  };
  await writeFile(credentialsPath(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

async function loadCredentials(): Promise<{ readonly computerId: ComputerId; readonly token: string } | null> {
  let rawText: string;
  try {
    rawText = await readFile(credentialsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，无法读取电脑 token");
  try {
    const raw: unknown = JSON.parse(rawText);
    if (typeof raw !== "object" || raw === null || !("computerId" in raw) || !("encryptedToken" in raw)) return null;
    return ComputerTokenResponse.parse({
      computerId: raw.computerId,
      token: safeStorage.decryptString(Buffer.from(String(raw.encryptedToken), "base64")),
    });
  } catch {
    return null;
  }
}

function agentEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of AGENT_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function agentUrl(origin: string): string {
  const url = new URL("/agent", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class AgentReplacedError extends Error {}

const agentDataDir = (): string => join(app.getPath("userData"), "bots");

// 助理 Chrome 是 open 起的，挂在 launchd 下，不在代理的进程组里。强杀代理时它来不及收，这里按 profile 收。
async function reapAgentChrome(): Promise<void> {
  try {
    const reaped = await reapProfileChromes(chromeProfileDir(agentDataDir()));
    if (reaped.length > 0) logLine(`agent-chrome-reaped ${reaped.join(",")}`);
  } catch (error) {
    logLine(`agent-chrome-reap-failed ${String(error)}`);
  }
}

export function startAgent(
  credentials: { readonly computerId: ComputerId; readonly token: string },
  timeoutMs = 45_000,
): Promise<void> {
  if (agentState.status === "starting" || agentState.status === "online") return Promise.resolve();
  // 安装更新或退出已经开始，晚到的配对不能再把代理拉起来。
  if (phase !== "running") return Promise.reject(new AgentReplacedError());
  const launch = AgentLaunch.parse({
    url: agentUrl(controlOrigin),
    computerId: credentials.computerId,
    token: credentials.token,
    dataDir: agentDataDir(),
  });
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [desktopPaths().agent], {
      detached: true,
      env: agentEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.reject(error);
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (child.pid === undefined || stdin === null || stdout === null || stderr === null) {
    return Promise.reject(new Error("电脑代理没有起来"));
  }
  agentState = { status: "starting", child };
  logLine(`agent-pid ${child.pid}`);
  return new Promise((resolve, reject) => {
    let pending = "";
    let online = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isCurrentAgent(agentState, child)) agentState = { status: "none" };
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      void reapAgentChrome();
      reject(new Error(`电脑代理 ${Math.round(timeoutMs / 1_000)} 秒内没有被控制面接纳`));
    }, timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const collect = (chunk: Buffer, fromStderr: boolean): void => {
      const text = chunk.toString();
      process[fromStderr ? "stderr" : "stdout"].write(text);
      if (fromStderr) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const value: unknown = JSON.parse(line.trim());
          if (
            !online &&
            typeof value === "object" &&
            value !== null &&
            "type" in value &&
            value.type === "online" &&
            isCurrentAgent(agentState, child)
          ) {
            online = true;
            agentState = { status: "online", child };
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              logLine(`agent-online ${Date.now() - startedAt}`);
              resolve();
            }
          }
        } catch {
          // 代理的 stdout 允许包含诊断日志，只有完整 JSON 行才是上线标记。
        }
      }
    };
    const onError = (error: Error): void => {
      const reportFailure = shouldReportStartFailure(agentState, child);
      if (isCurrentAgent(agentState, child)) agentState = { status: "none" };
      if (!reportFailure) {
        fail(new AgentReplacedError());
        return;
      }
      fail(error);
    };
    child.once("error", onError);
    stdin.on("error", () => undefined);
    stdout.on("data", (chunk: Buffer) => collect(chunk, false));
    stderr.on("data", (chunk: Buffer) => collect(chunk, true));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const reportFailure = shouldReportStartFailure(agentState, child);
      const current = isCurrentAgent(agentState, child);
      if (current) agentState = { status: "none" };
      logLine(`agent-exit ${code ?? ""} ${signal ?? ""}`.trim());
      if (online || settled) return;
      fail(reportFailure ? new Error("电脑代理在控制面接纳前退出") : new AgentReplacedError());
    });
    stdin.write(`${JSON.stringify(launch)}\n`, (error: Error | null | undefined) => {
      if (error !== undefined && error !== null) onError(error);
    });
  });
}

function descendantPids(rootPid: number): number[] {
  const output = spawnSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout;
  const rows = output
    .trim()
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]) }));
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid);
        changed = true;
      }
    }
  }
  return [...found].filter((pid) => pid !== rootPid);
}

export async function stopAgent(): Promise<void> {
  const child = currentAgentChild(agentState);
  if (child === null || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    agentState = { status: "none" };
    return;
  }
  agentState = { status: "stopping", child };
  child.stdin?.end();
  try {
    process.kill(-child.pid, "SIGINT");
  } catch {
    child.kill("SIGINT");
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
  ]);
  if (graceful) return;
  const descendants = child.pid === undefined ? [] : descendantPids(child.pid);
  for (const pid of descendants.toReversed()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 进程可能已经自行退出。
      }
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  await reapAgentChrome();
}

async function postLocalComputer(
  session: Session,
): Promise<{ readonly computerId: ComputerId; readonly token: string }> {
  const response = await session.fetch(`${uiOrigin}/api/computers/local`, { method: "POST" });
  if (!response.ok) throw new Error(`申请电脑 token 失败（${response.status}）`);
  return ComputerTokenResponse.parse(await response.json());
}

async function provision(session: Session): Promise<void> {
  if (provisioning !== null) return provisioning;
  provisioning = (async () => {
    await stopAgent();
    const credentials = await postLocalComputer(session);
    await saveCredentials(credentials);
    try {
      await startAgent(credentials);
    } catch (error) {
      if (!(error instanceof AgentReplacedError)) throw error;
      return;
    }
    await refreshPending(session);
    connectPush(session);
  })().finally(() => {
    provisioning = null;
  });
  return provisioning;
}

async function refreshPending(session: Session): Promise<void> {
  try {
    const [botsResponse, groupsResponse] = await Promise.all([
      session.fetch(`${uiOrigin}/api/bots`),
      session.fetch(`${uiOrigin}/api/groups`),
    ]);
    if (!botsResponse.ok || !groupsResponse.ok) return;
    const bots = BotListResponse.parse(await botsResponse.json());
    const groups = GroupListResponse.parse(await groupsResponse.json());
    const count = [...bots.items, ...groups.items].reduce((sum, item) => sum + item.pendingApprovals, 0);
    tray?.setTitle(count === 0 ? "" : String(count));
    tray?.setToolTip(count === 0 ? "白泽" : `白泽 · ${count} 件等你确认`);
    logLine(`pending-count ${count}`);
  } catch (error) {
    logLine(`pending-refresh-failed ${errorText(error)}`);
  }
}

export function connectPush(session: Session, origin = uiOrigin): void {
  const generation = ++pushGeneration;
  if (pushRetry !== null) clearTimeout(pushRetry);
  pushRetry = null;
  const previous = pushSocket;
  pushSocket = null;
  previous?.close();
  void session.cookies.get({ url: origin }).then((cookies) => {
    if (phase !== "running" || generation !== pushGeneration) return;
    const url = new URL("/api/ws", origin);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: { cookie: cookies.map((item) => `${item.name}=${item.value}`).join("; ") },
    });
    pushSocket = socket;
    socket.on("message", (data) => {
      receiveServerPush(data.toString(), {
        notify: showNotice,
        refreshPending: () => void refreshPending(session),
      });
    });
    socket.on("close", () => {
      if (!shouldRetryPush(phase !== "running", pushSocket, socket)) return;
      pushSocket = null;
      pushRetry = setTimeout(() => connectPush(session, origin), 1_000);
    });
    socket.on("error", () => undefined);
  });
}

function showNotice(notice: { readonly kind: NotifyKind; readonly text: string }): void {
  if (!Notification.isSupported()) return;
  const titles: Record<NotifyKind, string> = {
    confirm: "白泽要你确认",
    result: "白泽做完了",
    stuck: "白泽卡住了",
    failed: "白泽没办成",
  };
  const notification = new Notification({
    title: titles[notice.kind],
    body: notice.text,
  });
  const open = (): void => showMenubar();
  notification.on("click", open);
  notification.show();
  logLine(`native-notify ${notice.kind} ${notice.text}`);
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M3 2h8.2c2.4 0 3.8 1.2 3.8 3 0 1.2-.6 2.1-1.7 2.6 1.4.4 2.2 1.5 2.2 3 0 2.2-1.7 3.4-4.6 3.4H3V2Zm3 2.5v2.2h4.6c.9 0 1.4-.4 1.4-1.1s-.5-1.1-1.4-1.1H6Zm0 4.6v2.4h4.9c1 0 1.6-.4 1.6-1.2 0-.8-.6-1.2-1.6-1.2H6Z"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

function placeMenubar(bounds: Rectangle): void {
  if (menubarWindow === null) return;
  const width = menubarWindow.getSize()[0] ?? 390;
  menubarWindow.setPosition(Math.round(bounds.x + bounds.width / 2 - width / 2), bounds.y + bounds.height + 4, false);
}

function showMenubar(): void {
  if (menubarWindow === null || tray === null) return;
  placeMenubar(tray.getBounds());
  menubarWindow.show();
  menubarWindow.focus();
}

async function createWindows(session: Session): Promise<void> {
  // 登录页一加载完就能提交，钩子晚于 loadURL 装上会漏掉这次登录，代理就永远不启动。
  if (!authHookInstalled) {
    authHookInstalled = true;
    session.webRequest.onCompleted({ urls: [`${uiOrigin}/api/auth/login`, `${uiOrigin}/api/register`] }, (details) => {
      if (details.statusCode >= 200 && details.statusCode < 300) {
        void provision(session).catch((error: unknown) => {
          if (!(error instanceof AgentReplacedError)) void dialog.showErrorBox("电脑代理启动失败", errorText(error));
        });
      }
    });
  }

  if (mainWindow === null) {
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: "白泽",
      titleBarStyle: "default",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    mainWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      window.show();
      logLine(`window-shown ${Date.now() - startedAt}`);
    });
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    await window.loadURL(uiOrigin);
  }

  if (menubarWindow === null) {
    const window = new BrowserWindow({
      width: 390,
      height: 560,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    menubarWindow = window;
    window.on("blur", () => {
      setTimeout(() => {
        if (phase === "running" && !window.isFocused()) window.hide();
      }, 0);
    });
    window.on("close", (event) => {
      if (phase === "running") {
        event.preventDefault();
        window.hide();
      }
    });
    await window.loadURL(`${uiOrigin}/menubar`);
  }
}

function settingsHtml(current: string): string {
  return `<!doctype html><html><meta charset="utf-8"><title>白泽设置</title><style>
    :root{--bg:#f5f4ef;--fg:#17212b;--muted:#66717c;--accent:#176b72;--line:#d6d8d5;--white:#fff}
    body{margin:0;padding:28px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
    h1{margin:0 0 8px;font-size:20px}p{margin:0 0 20px;color:var(--muted)}label{display:block;font-weight:600}
    input{box-sizing:border-box;width:100%;margin:8px 0 20px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--white);font:inherit}
    button{border:0;border-radius:8px;padding:10px 18px;background:var(--accent);color:var(--white);font:600 14px inherit;cursor:pointer}
  </style><body><h1>控制面地址</h1><p>保存后白泽会重启并连接新地址。</p><form><label>地址<input type="url" required value=${JSON.stringify(current)}></label><button>保存并重启</button></form>
  <script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();location.href='baize-settings://save?origin='+encodeURIComponent(document.querySelector('input').value)})</script></body></html>`;
}

function openSettings(): void {
  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({ width: 520, height: 300, resizable: false, title: "白泽设置" });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  settingsWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith("baize-settings://save")) return;
    event.preventDefault();
    void (async () => {
      const next = normalizedOrigin(new URL(target).searchParams.get("origin") ?? "");
      await saveSettings({ ...settings, controlOrigin: next });
      await unlink(credentialsPath()).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      app.relaunch();
      app.quit();
    })().catch((error: unknown) => {
      const window = settingsWindow;
      if (window !== null && !window.isDestroyed())
        void dialog.showMessageBox(window, { type: "error", message: errorText(error) });
      else void dialog.showErrorBox("设置保存失败", errorText(error));
    });
  });
  void settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsHtml(controlOrigin))}`);
}

function installMenu(checkForUpdates: () => void): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        packaged: app.isPackaged,
        version: app.getVersion(),
        openAtLogin: () => app.getLoginItemSettings().openAtLogin,
        setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
        checkForUpdates,
        openSettings,
      }),
    ),
  );
}

function showBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  return mainWindow !== null && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function stopPush(): void {
  if (pushRetry !== null) clearTimeout(pushRetry);
  pushGeneration += 1;
  pushSocket?.close();
}

// quitAndInstall 先关全部窗口，这条路径不经过 before-quit，所以相位要在这里切走。
async function prepareInstall(): Promise<void> {
  phase = "installing";
  stopPush();
  await stopAgent();
}

function resumeAfterFailedInstall(): void {
  phase = "running";
  const session = electronSession.defaultSession;
  void loadCredentials()
    .then((credentials) => (credentials === null ? undefined : launchSavedAgent(session, credentials)))
    .catch((error: unknown) => void dialog.showErrorBox("电脑代理不可用", errorText(error)));
}

function launchSavedAgent(
  session: Session,
  credentials: { readonly computerId: ComputerId; readonly token: string },
): void {
  void startAgent(credentials).catch((error: unknown) => {
    if (!(error instanceof AgentReplacedError)) void dialog.showErrorBox("电脑代理启动失败", errorText(error));
  });
  void refreshPending(session);
  connectPush(session);
}

function createAppUpdater(): Updater {
  return createUpdater({
    packaged: app.isPackaged,
    feedUrl: resolveUpdateFeed(settings, controlOrigin, process.arch),
    source: autoUpdater,
    askRestart: async ({ message, detail }) => {
      const { response } = await showBox({
        type: "info",
        message,
        detail,
        buttons: ["现在重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      return response === 0;
    },
    inform: (level, text) => void showBox({ type: level, message: text }),
    prepareInstall,
    resumeAfterFailedInstall,
    log: logLine,
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  settings = await loadSettings();
  ({ controlOrigin } = settings);
  const uiServer = await startUiServer(desktopPaths().web, controlOrigin);
  uiOrigin = uiServer.origin;
  const session = electronSession.defaultSession;
  tray = new Tray(trayImage());
  tray.setToolTip("白泽");
  tray.on("click", () => (menubarWindow?.isVisible() ? menubarWindow.hide() : showMenubar()));
  const appUpdater = createAppUpdater();
  updater = appUpdater;
  app.setAboutPanelOptions({ applicationName: "白泽", applicationVersion: app.getVersion() });
  installMenu(appUpdater.checkNow);
  await createWindows(session);
  let credentials: { readonly computerId: ComputerId; readonly token: string } | null = null;
  try {
    credentials = await loadCredentials();
  } catch (error) {
    void dialog.showErrorBox("电脑代理不可用", errorText(error));
  }
  if (credentials !== null) {
    launchSavedAgent(session, credentials);
  } else {
    void session
      .fetch(`${uiOrigin}/api/me`)
      .then((response) => (response.ok ? provision(session) : undefined))
      .catch((error: unknown) => {
        logLine(`电脑代理自动配置失败 ${errorText(error)}`);
        void dialog.showErrorBox("电脑代理启动失败", errorText(error));
      });
  }
  app.on("activate", () => {
    if (mainWindow === null) void createWindows(session);
    else mainWindow.show();
  });
  appUpdater.start();
}

app.on("before-quit", (event) => {
  // 更新安装时代理已停，退出交给 Squirrel，不拦也不 app.exit。
  if (phase === "installing") return;
  event.preventDefault();
  if (phase === "quitting") return;
  phase = "quitting";
  updater?.stop();
  stopPush();
  void stopAgent().finally(() => app.exit(0));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

void main().catch((error: unknown) => {
  const message = errorText(error);
  process.stderr.write(`白泽启动失败：${message}\n`);
  dialog.showErrorBox("白泽启动失败", message);
  app.exit(1);
});
