import type { ComputerChoices, ComputerKind, Group } from "@baize/shared";
import { computerChoices, computerStatus, removedComputers, runsOnComputer } from "./store.js";

const COMPUTER_ID: Record<ComputerKind, string> = { local: "cmp_local", remote: "cmp_remote" };
const keyOf = (groupId: string, botId: string) => `${groupId}/${botId}`;

export const hasComputer = (kind: ComputerKind): boolean => !removedComputers.has(COMPUTER_ID[kind]);

const dispatchable = (kind: ComputerKind): boolean =>
  hasComputer(kind) && (computerStatus.get(COMPUTER_ID[kind]) ?? "online") === "online";

// 和控制面同一个挑法：选了就只认那台；没选过你的电脑能派就是它，派不过去才轮到云电脑。
const runKind = (groupId: string, botId: string): ComputerKind =>
  computerChoices.get(keyOf(groupId, botId)) ?? (dispatchable("local") || !dispatchable("remote") ? "local" : "remote");

export const choicesOf = (group: Group): ComputerChoices =>
  group.botIds.map((botId) => {
    const key = keyOf(group.id, botId);
    return {
      botId,
      kind: computerChoices.get(key) ?? null,
      runningOn: [...(runsOnComputer.get(key)?.values() ?? [])].at(-1) ?? null,
    };
  });

/** 值没变回 false，调用方就不落系统消息也不推。 */
export const chooseComputer = (groupId: string, botId: string, kind: ComputerKind): boolean => {
  const key = keyOf(groupId, botId);
  if (computerChoices.get(key) === kind) return false;
  computerChoices.set(key, kind);
  return true;
};

// 一轮开跑时记下在哪台上，返回收尾函数。控制面在 run_done 时写 endedAt，所以要在这一轮最后那条推送之前收。
export const startRunOn = (groupId: string, botId: string): (() => void) => {
  const key = keyOf(groupId, botId);
  const token = Symbol(key);
  const running = runsOnComputer.get(key) ?? new Map<symbol, ComputerKind>();
  running.set(token, runKind(groupId, botId));
  runsOnComputer.set(key, running);
  return () => {
    running.delete(token);
    if (running.size === 0 && runsOnComputer.get(key) === running) runsOnComputer.delete(key);
  };
};
