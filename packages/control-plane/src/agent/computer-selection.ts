import type { AccountConfig, Computer } from "@baize/shared";

export type ComputerCandidate = {
  readonly computer: Computer;
  readonly accounts: readonly AccountConfig[];
};

export type SelectionFailure =
  | "no_computer_online"
  | "config_rejected"
  | "all_computers_offline"
  | "required_account_not_found"
  | "accounts_on_multiple_computers"
  | "required_computer_offline";

export type ComputerSelection =
  | { readonly kind: "selected"; readonly computer: Computer }
  | { readonly kind: "failed"; readonly reason: SelectionFailure };

/** `why` 同时进群里那句、例行的运行记录和 stuck 通知，`next` 只在群里说，告诉用户接下来怎么办。 */
export const SELECTION_FAILURE: Readonly<Record<SelectionFailure, { readonly why: string; readonly next: string }>> = {
  no_computer_online: { why: "电脑不在线", next: "电脑回来后再说一次" },
  config_rejected: { why: "电脑拒收了配置", next: "按通知里说的把两边版本对上再说一次" },
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
};

export function selectionNotice(reason: SelectionFailure): string {
  const { why, next } = SELECTION_FAILURE[reason];
  return `${why}，这条没派出去，${next}`;
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
