import type { AccountConfig, Computer } from "@baize/shared";

export type ComputerCandidate = {
  readonly computer: Computer;
  readonly accounts: readonly AccountConfig[];
};

export type ComputerSelection =
  | { readonly kind: "selected"; readonly computer: Computer }
  | {
      readonly kind: "failed";
      readonly reason:
        | "no_computer_online"
        | "required_account_not_found"
        | "accounts_on_multiple_computers"
        | "required_computer_offline";
    };

export function selectComputer(
  requiredAccounts: readonly AccountConfig[],
  candidates: readonly ComputerCandidate[],
): ComputerSelection {
  if (requiredAccounts.length === 0) {
    const local = candidates.find(({ computer }) => computer.kind === "local" && computer.status === "online");
    if (local !== undefined) return { kind: "selected", computer: local.computer };
    const remote = candidates.find(({ computer }) => computer.kind === "remote" && computer.status === "online");
    return remote === undefined
      ? { kind: "failed", reason: "no_computer_online" }
      : { kind: "selected", computer: remote.computer };
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
