import type { AccountConfig, ComputerKind } from "@baize/shared";
import type { ComputerRecord } from "../repo/rows.js";
import type { ComputerAvailability } from "./computer-availability.js";

export type ComputerCandidate = {
  readonly computer: ComputerRecord;
  readonly accounts: readonly AccountConfig[];
};

export type SelectionFailure =
  | "no_computer_online"
  | "config_rejected"
  | "all_computers_offline"
  | "required_account_not_found"
  | "accounts_on_multiple_computers"
  | "required_computer_offline"
  | "chosen_local_offline"
  | "chosen_remote_offline";

export type ComputerSelection =
  | { readonly kind: "selected"; readonly computer: ComputerRecord }
  | { readonly kind: "failed"; readonly reason: SelectionFailure };

/** `why` 同时进群里那句、例行的运行记录和 stuck 通知，`next` 只在群里说，告诉用户接下来怎么办。 */
export const SELECTION_FAILURE: Readonly<Record<SelectionFailure, { readonly why: string; readonly next: string }>> = {
  no_computer_online: { why: "电脑不在线", next: "电脑回来后再说一次" },
  config_rejected: { why: "电脑上的白泽版本和控制面对不上", next: "把电脑上的白泽升级或重启后再说一次" },
  all_computers_offline: { why: "你的电脑都不在线", next: "有一台回来后再说一次" },
  required_account_not_found: { why: "要用的账号已经不在账号页里", next: "把账号挂上后再说一次" },
  accounts_on_multiple_computers: {
    why: "要用的账号分在两台电脑上",
    next: "拆成两句，每句只碰一台电脑上的账号",
  },
  required_computer_offline: {
    why: "要用的账号所在的那台电脑不在线",
    next: "也不会改派到另一台，那台回来后再说一次",
  },
  chosen_local_offline: {
    why: "这个 Bot 在这个群里选了用你的电脑，你的电脑现在不在线",
    next: "也不会改派到云电脑，电脑回来后再说一次，或在群顶部改用云电脑",
  },
  chosen_remote_offline: {
    why: "这个 Bot 在这个群里选了用云电脑，云电脑现在不在线",
    next: "也不会改派到你的电脑，云电脑回来后再说一次，或在群顶部改用你的电脑",
  },
};

/** continuation：换电脑后接着做的那条 run 派不出去，群里说的是那段活，不是用户刚发的「这条」。 */
export function selectionNotice(reason: SelectionFailure, options: { readonly continuation?: boolean } = {}): string {
  const { why, next } = SELECTION_FAILURE[reason];
  return options.continuation === true
    ? `${why}，刚才换电脑后要接着做的活没派出去，${next}`
    : `${why}，这条没派出去，${next}`;
}

export const CHOSEN_OFFLINE: Readonly<Record<ComputerKind, SelectionFailure>> = {
  local: "chosen_local_offline",
  remote: "chosen_remote_offline",
};

/**
 * 不看账号的派活选哪台。选过（preference 非 null）就只认那一种，派不过去报 chosen_*_offline，绝不落到另一种；
 * 那台连着但拒了 config 报版本对不上，用户该做的是升级，不是等它回来。
 * 没选过是默认策略：先挑连着的，都不连着再挑断线宽限里的，同一档本机在前；都不行而有一台拒了 config，说版本对不上。
 */
export function selectAvailable(
  computers: readonly ComputerRecord[],
  availability: readonly ComputerAvailability[],
  preference: ComputerKind | null,
): ComputerSelection {
  const of = (computer: ComputerRecord): ComputerAvailability | undefined =>
    availability.find((one) => one.id === computer.id);
  if (preference !== null) {
    const chosen = computers.find((computer) => computer.kind === preference);
    const state = chosen === undefined ? undefined : of(chosen);
    if (chosen !== undefined && state?.dispatchable === true) return { kind: "selected", computer: chosen };
    return { kind: "failed", reason: state?.reach === "rejected" ? "config_rejected" : CHOSEN_OFFLINE[preference] };
  }
  const within = (pick: (state: ComputerAvailability | undefined) => boolean): ComputerSelection =>
    selectComputer(
      [],
      computers.map((computer) => ({
        computer: { ...computer, status: pick(of(computer)) ? "online" : "sleeping" },
        accounts: [],
      })),
    );
  const connected = within((state) => state?.reach === "online");
  const selected = connected.kind === "selected" ? connected : within((state) => state?.dispatchable === true);
  if (selected.kind === "failed" && computers.some((computer) => of(computer)?.reach === "rejected"))
    return { kind: "failed", reason: "config_rejected" };
  return selected;
}

export function selectComputer(
  requiredAccounts: readonly AccountConfig[],
  candidates: readonly ComputerCandidate[],
): ComputerSelection {
  if (requiredAccounts.length === 0) {
    const local = candidates.find(({ computer }) => computer.kind === "local" && computer.status === "online");
    if (local !== undefined) return { kind: "selected", computer: local.computer };
    const remote = candidates.find(({ computer }) => computer.kind === "remote" && computer.status === "online");
    if (remote !== undefined) return { kind: "selected", computer: remote.computer };
    return { kind: "failed", reason: candidates.length > 1 ? "all_computers_offline" : "no_computer_online" };
  }

  const requiredIds = new Set(requiredAccounts.map((account) => account.id));
  const accountExists = (accountId: AccountConfig["id"]): boolean =>
    candidates.some(({ accounts }) => accounts.some((account) => account.id === accountId));
  if (requiredAccounts.some((account) => !accountExists(account.id)))
    return { kind: "failed", reason: "required_account_not_found" };
  const matches = candidates.filter(({ accounts }) => accounts.some((account) => requiredIds.has(account.id)));
  const selected = matches.find(({ accounts }) =>
    requiredAccounts.every((required) => accounts.some((one) => one.id === required.id)),
  );
  if (selected === undefined) return { kind: "failed", reason: "accounts_on_multiple_computers" };
  return selected.computer.status === "online"
    ? { kind: "selected", computer: selected.computer }
    : { kind: "failed", reason: "required_computer_offline" };
}
