import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBashToolDefinition, type BashSpawnContext, type BashSpawnHook } from "@earendil-works/pi-coding-agent";
import { forbiddenPathPrefixes, realpathExisting, type GateAccess } from "./gate.js";

const ENV_ALLOW = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"] as const;
const MACH_LOOKUP_NAMES = [
  "com.apple.system.logger",
  "com.apple.system.opendirectoryd",
  "com.apple.system.DirectoryService",
  "com.apple.cfprefsd.daemon",
  "com.apple.SecurityServer",
  "com.apple.trustd",
  "com.apple.lsd.mapdb",
  "com.apple.diagnosticd",
  "com.apple.system.notification_center",
  "com.apple.runningboard",
] as const;

const shSingleQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const seatbeltString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function whitelistEnv(env: NodeJS.ProcessEnv, cwd: string, tmpDir: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { PWD: cwd, TMPDIR: tmpDir };
  for (const key of ENV_ALLOW) {
    const value = env[key];
    if (value !== undefined) next[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("PI_") && value !== undefined) next[key] = value;
  }
  return next;
}

export function sandboxProfile(workDir: string, access: GateAccess): string {
  const work = realpathExisting(workDir);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal)",
    "(allow sysctl-read)",
    ...MACH_LOOKUP_NAMES.map((name) => `(allow mach-lookup (global-name ${seatbeltString(name)}))`),
    "(allow ipc-posix-shm*)",
    "(allow system-socket)",
    "(allow file-ioctl)",
    "(allow file-map-executable)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${seatbeltString(work)}))`,
    ...access.writePaths.flatMap((path) => {
      const real = realpathExisting(path);
      return [`(allow file-write* (subpath ${seatbeltString(real)}))`];
    }),
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/stdout"))',
    '(allow file-write* (literal "/dev/stderr"))',
    '(allow file-write* (literal "/dev/fd/1"))',
    '(allow file-write* (literal "/dev/fd/2"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
    ...(access.network
      ? ["(allow network-outbound)", "(allow network-inbound)", "(allow network-bind)"]
      : ["(deny network*)"]),
    ...forbiddenPathPrefixes(workDir).flatMap((prefix) => {
      const real = seatbeltString(realpathExisting(prefix));
      return [`(deny file-read* (subpath ${real}))`, `(deny file-write* (subpath ${real}))`];
    }),
  ];
  return lines.join("\n");
}

const spawnHook = (workDir: string, tmpDir: string, access: GateAccess): BashSpawnHook => {
  if (process.platform !== "darwin") {
    return (ctx: BashSpawnContext) => ({
      command: ctx.command,
      cwd: workDir,
      env: whitelistEnv(ctx.env, workDir, tmpDir),
    });
  }
  const profile = sandboxProfile(workDir, access);
  return (ctx: BashSpawnContext) => ({
    command: `/usr/bin/sandbox-exec -p ${shSingleQuote(profile)} /bin/bash -c ${shSingleQuote(ctx.command)}`,
    cwd: workDir,
    env: whitelistEnv(ctx.env, workDir, tmpDir),
  });
};

export interface BashSandbox {
  readonly tool: ReturnType<typeof createBashToolDefinition>;
  allow(runId: string, callId: string, access: GateAccess): void;
  clearRun(runId: string): void;
}

export function createSandboxedBash(workDir: string, activeRunId: () => string | null = () => null): BashSandbox {
  const tmpDir = join(workDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const accessByRun = new Map<string, Map<string, GateAccess>>();
  const base = createBashToolDefinition(workDir);
  const tool = {
    ...base,
    executionMode: "sequential",
    execute: async (...args: Parameters<typeof base.execute>) => {
      const [callId] = args;
      const runId = activeRunId();
      const runAccess = runId === null ? undefined : accessByRun.get(runId);
      const access = runAccess?.get(callId) ?? { network: false, writePaths: [] };
      runAccess?.delete(callId);
      if (runId !== null && runAccess?.size === 0) accessByRun.delete(runId);
      const scoped = createBashToolDefinition(workDir, { spawnHook: spawnHook(workDir, tmpDir, access) });
      return scoped.execute(...args);
    },
  } satisfies typeof base;
  return {
    tool,
    allow: (runId, callId, access) => {
      if (!access.network && access.writePaths.length === 0) {
        accessByRun.get(runId)?.delete(callId);
        if (accessByRun.get(runId)?.size === 0) accessByRun.delete(runId);
        return;
      }
      const runAccess = accessByRun.get(runId) ?? new Map<string, GateAccess>();
      runAccess.set(callId, access);
      accessByRun.set(runId, runAccess);
    },
    clearRun: (runId) => {
      accessByRun.delete(runId);
    },
  };
}
