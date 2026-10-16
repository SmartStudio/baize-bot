import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Laptop, MonitorSmartphone, Server } from "lucide-react";
import type { Bot, BotId, Computer, ComputerKind, GroupId } from "@baize/shared";
import { RequestFailed } from "../api/client.js";
import { BotAvatar } from "./BotAvatar.js";
import type { ChoiceEntry } from "../state/types.js";

const KIND_TEXT: Record<ComputerKind, string> = { local: "你的电脑", remote: "云电脑" };
const OTHER: Record<ComputerKind, ComputerKind> = { local: "remote", remote: "local" };
const KINDS: readonly ComputerKind[] = ["local", "remote"];
const ICON: Record<ComputerKind, ReactNode> = {
  local: <Laptop size={16} aria-hidden="true" />,
  remote: <Server size={16} aria-hidden="true" />,
};

// 每种电脑一个账号最多一台，两种都有才有得选。
export const hasChoice = (computers: readonly Computer[]): boolean =>
  KINDS.every((kind) => computers.some((computer) => computer.kind === kind));

const dispatchable = (computers: readonly Computer[], kind: ComputerKind): boolean =>
  computers.some((computer) => computer.kind === kind && computer.dispatchable);

// 没选过时照控制面的默认挑法说是哪台：先挑连着的，再挑断线宽限里还能派的，同一档你的电脑在前。
const defaultKind = (computers: readonly Computer[]): ComputerKind => {
  const first = (ok: (computer: Computer) => boolean) =>
    KINDS.find((kind) => computers.some((computer) => computer.kind === kind && ok(computer)));
  return (
    first((computer) => computer.dispatchable && computer.status === "online") ??
    first((computer) => computer.dispatchable) ??
    "local"
  );
};

export type PickerNotes = { offline: string | null; running: string | null };

// 选了就只派那台，不在线也不改派，所以要明说。没选过走默认，默认自己会挑能派的那台，两句都不用说。
export const pickerNotes = (
  computers: readonly Computer[],
  choice: ComputerKind | null,
  runningOn: ComputerKind | null,
): PickerNotes => {
  if (choice === null) return { offline: null, running: null };
  return {
    offline: dispatchable(computers, choice)
      ? null
      : `${KIND_TEXT[choice]}不在线，发消息不会改派到${KIND_TEXT[OTHER[choice]]}`,
    running:
      runningOn === null || runningOn === choice
        ? null
        : `这一轮还在${KIND_TEXT[runningOn]}上跑完，下一条起用${KIND_TEXT[choice]}`,
  };
};

type Request = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

type PickerProps = {
  groupId: GroupId;
  botId: BotId;
  computers: readonly Computer[];
  choice: ComputerKind | null;
  runningOn: ComputerKind | null;
  onChoose: (kind: ComputerKind) => Promise<void>;
};

export const ComputerPicker = ({ groupId, botId, computers, choice, runningOn, onChoose }: PickerProps) => {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<Request>({ status: "idle" });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  // 只在打开那一下落焦点：电脑状态随推送更新会重渲染，不能把方向键挪到的焦点又拽回去。
  useEffect(() => {
    if (!open) return;
    const rows = items.current.filter((item) => item !== null);
    (rows.find((item) => item.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (!hasChoice(computers)) return null;

  const menuId = `computer-picker-${groupId}-${botId}`;
  const notes = pickerNotes(computers, choice, runningOn);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (kind: ComputerKind) => {
    close();
    if (kind === choice || request.status === "busy") return;
    setRequest({ status: "busy" });
    onChoose(kind)
      .then(() => setRequest({ status: "idle" }))
      .catch((cause: unknown) =>
        setRequest({
          status: "failed",
          message: cause instanceof RequestFailed ? cause.message : "没换成，再试一次",
        }),
      );
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.current.findIndex((item) => item === document.activeElement);
    const last = KINDS.length - 1;
    const to: Partial<Record<string, number>> = {
      ArrowDown: at >= last ? 0 : at + 1,
      ArrowUp: at <= 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      // 套在项目群的成员菜单里时，Esc 只收这一层。
      event.stopPropagation();
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
      className="computer-picker"
      ref={root}
      data-testid="computer-picker"
      data-bot-id={botId}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="computer-picker-anchor">
        <button
          type="button"
          ref={trigger}
          className="ghost-button computer-picker-trigger"
          data-testid="computer-picker-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-busy={request.status === "busy"}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          {ICON[choice ?? defaultKind(computers)]}
          <span data-testid="computer-picker-label">
            {choice === null ? `默认：${KIND_TEXT[defaultKind(computers)]}` : KIND_TEXT[choice]}
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {open ? (
          <div
            className="connect-menu computer-picker-menu"
            id={menuId}
            role="menu"
            aria-label="在这个群里用哪台电脑"
            data-testid="computer-picker-menu"
            onKeyDown={move}
          >
            <p className="connect-menu-head" aria-hidden="true">
              在这个群里用哪台电脑
            </p>
            {KINDS.map((kind, index) => (
              <button
                type="button"
                key={kind}
                ref={(element) => {
                  items.current[index] = element;
                }}
                className={`menu-row connect-choice${kind === choice ? " is-selected" : ""}`}
                role="menuitemradio"
                aria-checked={kind === choice}
                data-testid="computer-picker-option"
                data-kind={kind}
                onClick={() => choose(kind)}
              >
                {ICON[kind]}
                <b>{KIND_TEXT[kind]}</b>
                {dispatchable(computers, kind) ? null : (
                  <span className="menu-trail" data-testid="computer-picker-down">
                    不在线
                  </span>
                )}
                {kind === choice ? <Check size={14} aria-hidden="true" className="computer-picker-check" /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {notes.offline === null ? null : (
        <p className="computer-picker-note is-warning" data-testid="computer-picker-offline" role="status">
          {notes.offline}
        </p>
      )}
      {notes.running === null ? null : (
        <p className="computer-picker-note" data-testid="computer-picker-running" role="status">
          {notes.running}
        </p>
      )}
      {request.status === "failed" ? (
        <p className="computer-picker-note is-error" data-testid="computer-picker-error" role="alert">
          {request.message}
        </p>
      ) : null}
    </div>
  );
};

// 群头拿到的这一份：账号下的电脑、这个群每个成员的那一行，换电脑的入口。没得选或这个群还没拉回来时父组件拿到 null。
export type ComputerChoicesView = {
  groupId: GroupId;
  computers: readonly Computer[];
  choices: readonly ChoiceEntry[];
  onChoose: (botId: BotId, kind: ComputerKind) => Promise<void>;
};

const rowOf = (view: ComputerChoicesView, botId: BotId) => view.choices.find((row) => row.botId === botId);

// 单聊头部就是这一个选择器。key 换群换 Bot 时重来，上一个群里没换成的那句不带过来。
export const BotComputerPicker = ({ view, botId }: { view: ComputerChoicesView; botId: BotId }) => {
  const row = rowOf(view, botId);
  return (
    <ComputerPicker
      key={`${view.groupId}/${botId}`}
      groupId={view.groupId}
      botId={botId}
      computers={view.computers}
      choice={row?.kind ?? null}
      runningOn={row?.runningOn ?? null}
      onChoose={(kind) => view.onChoose(botId, kind)}
    />
  );
};

// 项目群头部只放一个入口，点开每个成员一行，各自一个选择器。
export const TeamComputers = ({ view, members }: { view: ComputerChoicesView; members: readonly Bot[] }) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = `team-computers-${view.groupId}`;

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[data-testid=computer-picker-trigger]")?.focus();
    const away = (event: MouseEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div
      className="team-computers"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="ghost-button team-computers-trigger"
        data-testid="team-computers"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <MonitorSmartphone size={14} aria-hidden="true" />
        电脑
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="connect-menu team-computer-menu"
          id={panelId}
          role="dialog"
          aria-label="每个 Bot 在这个群里用哪台电脑"
          data-testid="team-computer-menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <p className="connect-menu-head">每个 Bot 在这个群里用哪台电脑</p>
          {members.map((bot) => (
            <div className="team-computer-row" data-testid="team-computer-row" data-bot-id={bot.id} key={bot.id}>
              <BotAvatar name={bot.name} hue={bot.hue} size="xs" />
              <b className="team-computer-name">{bot.name}</b>
              <BotComputerPicker view={view} botId={bot.id} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

// 成员菜单收着也看得见的那几句，带上是谁。
export const TeamComputerNotes = ({ view, members }: { view: ComputerChoicesView; members: readonly Bot[] }) => (
  <>
    {members.flatMap((bot) => {
      const row = rowOf(view, bot.id);
      const { offline, running } = pickerNotes(view.computers, row?.kind ?? null, row?.runningOn ?? null);
      return [offline, running].flatMap((note) =>
        note === null
          ? []
          : [
              <p
                className="computer-picker-note team-computer-note"
                data-testid="team-computer-note"
                key={`${bot.id}/${note}`}
              >
                {bot.name}：{note}
              </p>,
            ],
      );
    })}
  </>
);
