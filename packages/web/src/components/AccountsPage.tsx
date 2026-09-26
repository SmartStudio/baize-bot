import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Account, AccountId, AccountTier, Computer } from "@baize/shared";
import { PLATFORM, TIER, TIERS, accountText, blockedTier, computerText } from "./messages/content.js";

type Props = {
  accounts: Account[];
  computers: Record<string, Computer>;
  onLoad: () => Promise<void>;
  onChangeTier: (accountId: AccountId, tier: AccountTier) => Promise<void>;
};

type Load = "loading" | "ready" | "failed";

type Change = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

const AccountRow = ({
  account,
  computers,
  onChangeTier,
}: {
  account: Account;
  computers: Record<string, Computer>;
  onChangeTier: Props["onChangeTier"];
}) => {
  const [open, setOpen] = useState(false);
  const [change, setChange] = useState<Change>({ status: "idle" });
  const choose = (tier: AccountTier) => {
    if (tier === account.tier || change.status === "busy") return;
    setChange({ status: "busy" });
    onChangeTier(account.id, tier)
      .then(() => setChange({ status: "idle" }))
      .catch((cause: unknown) =>
        setChange({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };
  return (
    <div className="account-row" data-testid="account-row" data-tier={account.tier}>
      <button
        type="button"
        className="row-card account-row-head"
        data-testid="account-tier-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          <b>
            {PLATFORM[account.platform]} · {accountText(account)}
          </b>
          <small>
            {computerText(account, computers)}
            {account.login === "expired" ? " · 登录已过期" : ""}
          </small>
        </span>
        <span className="account-tier" data-testid="account-tier">
          {TIER[account.tier].title}
        </span>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button>
      {open ? (
        <fieldset
          className="account-tiers"
          aria-label={`${accountText(account)} 的档位`}
          disabled={change.status === "busy"}
        >
          {TIERS.map((tier) => {
            const blocked = blockedTier(account.platform, tier);
            return (
              <label
                key={tier}
                className={`account-tier-option${blocked === null ? "" : " is-blocked"}`}
                data-testid="account-tier-option"
                data-tier={tier}
              >
                <input
                  type="radio"
                  name={`tier-${account.id}`}
                  checked={account.tier === tier}
                  disabled={blocked !== null}
                  onChange={() => choose(tier)}
                />
                <span>
                  <b>{TIER[tier].title}</b>
                  <small>{TIER[tier].note}</small>
                  {blocked === null ? null : (
                    <small className="account-tier-reason" data-testid="account-tier-reason">
                      {blocked}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
          {change.status === "failed" ? (
            <small className="account-tier-error" role="alert">
              没换成：{change.message}
            </small>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
};

// 进来就重拉一遍。拉不到得明说，不然空表会被读成「真的没有账号」。
export const AccountsPage = ({ accounts, computers, onLoad, onChangeTier }: Props) => {
  const [load, setLoad] = useState<Load>("loading");
  const fetchAccounts = useCallback(() => {
    onLoad().then(
      () => setLoad("ready"),
      () => setLoad("failed"),
    );
  }, [onLoad]);
  useEffect(fetchAccounts, [fetchAccounts]);
  const retry = () => {
    setLoad("loading");
    fetchAccounts();
  };

  return (
    <>
      {load === "failed" ? (
        <p className="later" data-testid="accounts-failed" role="alert">
          账号没取到。{" "}
          <button type="button" className="ghost-button" data-testid="accounts-retry" onClick={retry}>
            重试
          </button>
        </p>
      ) : null}
      {accounts.length > 0 ? (
        <div className="accounts-page" data-testid="accounts-page">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} computers={computers} onChangeTier={onChangeTier} />
          ))}
        </div>
      ) : load === "ready" ? (
        <p className="later" data-testid="accounts-empty">
          还没有接入的平台账号
        </p>
      ) : load === "loading" ? (
        <p className="later">正在读取账号…</p>
      ) : null}
    </>
  );
};
