import { execFile } from "node:child_process";
import { join } from "node:path";

const CHROME_EXECUTABLE = "/Google Chrome.app/Contents/MacOS/Google Chrome ";

export function chromeProfileDir(dataDir: string): string {
  return join(dataDir, "chrome-profile");
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForExit(pid: number): Promise<void> {
  while (isAlive(pid)) await delay(100);
}

export async function terminate(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) await delay(50);
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitForExit(pid);
}

function listProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
      if (error) reject(error);
      else resolve(out);
    });
  });
}

// ps 把 argv 用空格拼起来，profile 路径里本身可能有空格（Application Support），
// 所以只能按「前面是空格、后面是空格或行尾」认整个参数，子串会把 chrome-profile-old 也认进来。
function usesProfile(command: string, profileDir: string): boolean {
  const argument = ` --user-data-dir=${profileDir}`;
  return command.includes(`${argument} `) || command.endsWith(argument);
}

/** 用这个 profile 的 Chrome 主进程，按 PID 升序。渲染器等子进程带 --type=，随主进程退出，不算。 */
export async function profileChromePids(profileDir: string): Promise<number[]> {
  const pids: number[] = [];
  for (const line of (await listProcesses()).split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/u.exec(line);
    if (match === null) continue;
    const command = match[2] ?? "";
    if (!command.includes(CHROME_EXECUTABLE) || command.includes(" --type=")) continue;
    if (!usesProfile(command, profileDir)) continue;
    pids.push(Number(match[1]));
  }
  return pids.toSorted((left, right) => left - right);
}

/** 收掉用这个 profile 的全部 Chrome 主进程，回收掉的 PID。 */
export async function reapProfileChromes(profileDir: string): Promise<number[]> {
  const pids = await profileChromePids(profileDir);
  await Promise.all(pids.map((pid) => terminate(pid)));
  return pids;
}
