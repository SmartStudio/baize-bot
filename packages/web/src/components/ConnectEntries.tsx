import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Laptop, Server } from "lucide-react";
import { BrowserPlatform, type AccountId, type Computer, type ComputerId, type OAuthPlatform } from "@baize/shared";
import { oauthStartUrl } from "../api/client.js";
import { useApp } from "../state/app.js";
import { COMPUTER_KIND_TEXT, PLATFORM, beforeChinese, computerName } from "./messages/content.js";

// 电脑不在线就开不了登录窗口，原因写在选项上。
const BLOCKED: Record<Computer["status"], string | null> = {
  online: null,
  sleeping: "休眠中",
  creating: "还在创建",
  failed: "出错了",
};

export type ComputerChoice = { computer: Computer; blocked: string | null };

// 浏览器平台在哪台电脑上登录，号就挂在哪台电脑上。一台都没有就没处登；只有一台不用挑；几台让人挑，本机排第一。
export type ConnectTarget =
  { kind: "none" } | { kind: "one"; choice: ComputerChoice } | { kind: "many"; choices: ComputerChoice[] };

export const connectTarget = (computers: readonly Computer[]): ConnectTarget => {
  const choices = [...computers]
    .sort((left, right) => (left.kind === "local" ? 0 : 1) - (right.kind === "local" ? 0 : 1))
    .map((computer) => ({ computer, blocked: BLOCKED[computer.status] }));
  const [first] = choices;
  if (first === undefined) return { kind: "none" };
  return choices.length === 1 ? { kind: "one", choice: first } : { kind: "many", choices };
};

// 入口整个灰掉时为什么，写在入口旁边，不只放进 title：触屏上看不到 title。
export const connectNote = (target: ConnectTarget): string | null => {
  if (target.kind === "none") return "先在下面的「电脑」里加一台电脑，才能接入";
  if (target.kind !== "one" || target.choice.blocked === null) return null;
  return `${beforeChinese(computerName(target.choice.computer))}${target.choice.blocked}，开不了登录窗口`;
};

const ComputerMenu = ({
  platform,
  choices,
  busy,
  onChoose,
}: {
  platform: BrowserPlatform;
  choices: ComputerChoice[];
  busy: boolean;
  onChoose: (computerId: ComputerId) => void;
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = `account-connect-menu-${platform}`;

  // 只在打开那一下落焦点：电脑表随推送更新会重渲染，不能把方向键挪到的焦点又拽回第一项。
  useEffect(() => {
    if (!open) return;
    const rows = items.current.filter((item) => item !== null);
    (rows.find((item) => item.getAttribute("aria-disabled") !== "true") ?? rows[0])?.focus();
    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.current.findIndex((item) => item === document.activeElement);
    const last = choices.length - 1;
    const to: Partial<Record<string, number>> = {
      ArrowDown: at >= last ? 0 : at + 1,
      ArrowUp: at <= 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const index = to[event.key];
    if (index === undefined) return;
    event.preventDefault();
    items.current[index]?.focus();
  };

  return (
    <div
      className="connect-picker"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="ghost-button"
        data-testid="account-connect-browser"
        data-platform={platform}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        接入 {PLATFORM[platform]}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="connect-menu"
          id={menuId}
          role="menu"
          aria-label={`在哪台电脑上登录${PLATFORM[platform]}`}
          data-testid="account-connect-menu"
          onKeyDown={move}
        >
          <p className="connect-menu-head" aria-hidden="true">
            在哪台电脑上登录
          </p>
          {choices.map(({ computer, blocked }, index) => (
            <button
              type="button"
              key={computer.id}
              ref={(element) => {
                items.current[index] = element;
              }}
              className="menu-row connect-choice"
              role="menuitem"
              data-testid="account-connect-computer"
              data-computer-id={computer.id}
              aria-disabled={blocked === null ? undefined : true}
              onClick={() => {
                if (blocked !== null) return;
                setOpen(false);
                onChoose(computer.id);
              }}
            >
              {computer.kind === "local" ? (
                <Laptop size={16} aria-hidden="true" />
              ) : (
                <Server size={16} aria-hidden="true" />
              )}
              <span className="connect-choice-name">
                <b>{COMPUTER_KIND_TEXT[computer.kind]}</b>
                {computer.host === null ? null : <small>{computer.host}</small>}
              </span>
              {blocked === null ? null : (
                <span className="menu-trail" data-testid="account-connect-blocked">
                  {blocked}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const OAUTH_PLATFORMS: OAuthPlatform[] = ["github", "x"];

type Connect = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

type Props = { computers: readonly Computer[]; openLogin: (accountId: AccountId) => Promise<void> };

// OAuth 平台整页跳去平台授权，回来落在首页，结果由主窗口读查询串提示。
// 浏览器平台先在选中的电脑上建一个未登录的号（已经有就挪过去），再在它上面开登录窗口，登录的进度写在那一行上。
export const ConnectEntries = ({ computers, openLogin }: Props) => {
  const { actions } = useApp();
  const [connect, setConnect] = useState<Connect>({ status: "idle" });
  const target = connectTarget(computers);
  const note = connectNote(target);
  const busy = connect.status === "busy";
  const start = (platform: BrowserPlatform, computerId: ComputerId) => {
    if (busy) return;
    setConnect({ status: "busy" });
    actions
      .addAccount(platform, computerId)
      .then(async (accountId) => {
        if (accountId !== undefined) await openLogin(accountId);
        setConnect({ status: "idle" });
      })
      .catch((cause: unknown) =>
        setConnect({ status: "failed", message: cause instanceof Error ? cause.message : "请重试" }),
      );
  };
  return (
    <div className="account-connect" data-testid="account-connect">
      {OAUTH_PLATFORMS.map((platform) => (
        <a
          key={platform}
          className="ghost-button"
          href={oauthStartUrl(platform)}
          data-testid="account-connect-link"
          data-platform={platform}
        >
          接入 {PLATFORM[platform]}
        </a>
      ))}
      {BrowserPlatform.options.map((platform) =>
        target.kind === "many" ? (
          <ComputerMenu
            key={platform}
            platform={platform}
            choices={target.choices}
            busy={busy}
            onChoose={(computerId) => start(platform, computerId)}
          />
        ) : (
          <button
            type="button"
            key={platform}
            className="ghost-button"
            data-testid="account-connect-browser"
            data-platform={platform}
            disabled={note !== null || busy}
            title={note ?? undefined}
            onClick={() => {
              if (target.kind === "one") start(platform, target.choice.computer.id);
            }}
          >
            接入 {PLATFORM[platform]}
          </button>
        ),
      )}
      {note === null ? null : (
        <small className="account-connect-note" data-testid="account-connect-note">
          {note}
        </small>
      )}
      {connect.status === "failed" ? (
        <small className="account-connect-error" data-testid="account-connect-error" role="alert">
          没接上：{connect.message}
        </small>
      ) : null}
    </div>
  );
};
