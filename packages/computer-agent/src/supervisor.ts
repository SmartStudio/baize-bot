import { spawn, type ChildProcess } from "node:child_process";
import { backoffDelay, type BackoffOptions, defaultBackoff } from "./backoff.js";
import { takeLaunchFile } from "./launch-file.js";

/** 启动配置只走启动文件和代理的 stdin，这四个名字在看护进程和代理的环境里都不许出现。 */
export const FORBIDDEN_ENV = ["COMPUTER_ID", "AGENT_TOKEN", "CONTROL_PLANE_AGENT_URL", "BAIZE_DATA_DIR"] as const;

// 和桌面壳传给代理的一样，外加远程电脑上 Chrome 要画到的 Xvfb。
const AGENT_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  "DISPLAY",
] as const;

const STABLE_MS = 30_000;
const STOP_GRACE_MS = 15_000;

export interface SupervisorOptions {
  readonly launchFile: string;
  /** 看护进程自己的环境。代理的环境从这里按白名单挑。 */
  readonly env: NodeJS.ProcessEnv;
  readonly agentCommand: readonly [string, ...string[]];
  readonly backoff?: BackoffOptions;
  /** 启动文件还没放进来时多久看一次。 */
  readonly pollMs?: number;
  readonly log?: (line: string) => void;
}

export interface SupervisorHandle {
  stop(): Promise<void>;
}

type AgentSlot =
  | { readonly phase: "running"; readonly child: ChildProcess }
  | { readonly phase: "waiting"; readonly timer: NodeJS.Timeout }
  | { readonly phase: "stopped" };

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function agentEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * 等启动文件出现，读完即删，然后像桌面壳一样起电脑代理、把启动 JSON 写进它的 stdin 并一直开着。
 * 代理退出就按退避重起，每次写同一份。环境里有那四个名字、启动文件检查不过，都直接 reject。
 */
export async function supervise(options: SupervisorOptions): Promise<SupervisorHandle> {
  const log = options.log ?? ((line: string) => console.log(`[supervisor] ${line}`));
  const backoff = options.backoff ?? defaultBackoff;
  const present = FORBIDDEN_ENV.filter((key) => Object.hasOwn(options.env, key));
  if (present.length > 0) {
    throw new Error(`环境变量 ${present.join("、")} 不允许出现在看护进程里，启动配置只从启动文件读`);
  }

  let announced = false;
  let taken = await takeLaunchFile(options.launchFile);
  while (taken.kind === "absent") {
    if (!announced) log(`等启动文件 ${options.launchFile}`);
    announced = true;
    await delay(options.pollMs ?? 1_000);
    taken = await takeLaunchFile(options.launchFile);
  }
  log("启动文件已读取并删除");
  const launchLine = `${JSON.stringify(taken.launch)}\n`;
  const env = agentEnv(options.env);
  const [file, ...args] = options.agentCommand;

  let slot: AgentSlot = { phase: "stopped" };
  let attempt = 0;

  const start = (): void => {
    const child = spawn(file, args, { env, stdio: ["pipe", "inherit", "inherit"] });
    slot = { phase: "running", child };
    log(`电脑代理已起，PID ${child.pid ?? "无"}`);
    const stable = setTimeout(() => {
      attempt = 0;
    }, STABLE_MS);
    stable.unref();
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(launchLine);

    let ended = false;
    const onEnd = (reason: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(stable);
      if (slot.phase !== "running" || slot.child !== child) return;
      const wait = backoffDelay(attempt, backoff);
      attempt += 1;
      log(`电脑代理${reason}，${wait}ms 后重起，第 ${attempt} 次`);
      slot = { phase: "waiting", timer: setTimeout(start, wait) };
    };
    child.once("error", (error) => onEnd(`起不来（${error.message}）`));
    child.once("exit", (code, signal) => onEnd(`退出（${String(code ?? signal)}）`));
  };
  start();

  return {
    async stop() {
      const current = slot;
      slot = { phase: "stopped" };
      if (current.phase === "waiting") clearTimeout(current.timer);
      if (current.phase !== "running") return;
      const { child } = current;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin?.end();
      child.kill("SIGTERM");
      const graceful = await Promise.race([exited.then(() => true), delay(STOP_GRACE_MS).then(() => false)]);
      if (graceful) return;
      child.kill("SIGKILL");
      await exited;
    },
  };
}
