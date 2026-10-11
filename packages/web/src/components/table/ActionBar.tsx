import { useState } from "react";
import type { PokerAction, PokerTableView } from "@baize/shared";
import { RequestFailed } from "../../api/client.js";
import { useApp } from "../../state/app.js";
import { actionBarOf, raiseCheck, type ActionBarModel, type RaiseRange } from "../../state/poker.js";
import "./action-bar.css";

type Props = {
  table: PokerTableView | null;
};

const passText = (pass: ActionBarModel["pass"]): string => (pass.kind === "check" ? "过牌" : `跟 ${pass.amount}`);

const clamp = (range: RaiseRange, amount: number): number => Math.min(range.max, Math.max(range.min, amount));

export const ActionBar = ({ table }: Props) => {
  const { actions } = useApp();
  // 记的是发出时的牌桌版本：更大的版本一到（接口回的或推送来的）就不再算在途。
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 草稿按决策点记，换了决策点就回到最小加注。
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);

  const model = table === null ? null : actionBarOf(table);
  if (table === null || model === null) return null;

  const pending = sentAt !== null && table.version <= sentAt;
  const enabled = model.mine && !pending;
  const range = model.raise?.kind === "raise" ? model.raise : null;
  const key = `${model.handId}:${model.seq}`;
  const text = draft?.key === key ? draft.text : range === null ? "" : String(range.min);
  const check = range === null ? null : raiseCheck(range, text);

  const submit = async (action: PokerAction) => {
    setSentAt(table.version);
    setError(null);
    try {
      await actions.actPoker(model.handId, { seq: model.seq, action });
    } catch (cause) {
      setSentAt(null);
      setError(cause instanceof RequestFailed ? cause.message : "出牌没成功，稍后再试");
      // 409 是你看的牌桌已经过时了，补拉一份最新的。
      if (cause instanceof RequestFailed && cause.status === 409) {
        void actions.loadPokerTable(table.groupId).catch(() => undefined);
      }
    }
  };

  const setText = (next: string) => setDraft({ key, text: next });
  const stepBy = (direction: 1 | -1) => {
    if (range === null) return;
    const current = check?.ok === true ? check.amount : range.min;
    setText(String(clamp(range, current + direction * range.step)));
  };

  const raiseLabel =
    model.raise?.kind === "all_in"
      ? `全下 ${model.raise.amount}`
      : check?.ok === true
        ? `加注到 ${check.amount}`
        : "加注";
  const raiseDisabled = !enabled || model.raise === null || (range !== null && check?.ok !== true);
  const raiseAction = (): PokerAction | null => {
    if (model.raise?.kind === "all_in") return { kind: "all_in" };
    return check?.ok === true ? { kind: "raise", amount: check.amount } : null;
  };

  return (
    <section
      className="action-bar"
      data-testid="action-bar"
      data-mine={model.mine}
      data-pending={pending}
      aria-label="你的操作"
    >
      <div className="action-row">
        <button
          type="button"
          className="ghost-button"
          data-testid="action-fold"
          disabled={!enabled || !model.canFold}
          onClick={() => void submit({ kind: "fold" })}
        >
          弃牌
        </button>
        <button
          type="button"
          className="ghost-button"
          data-testid="action-pass"
          disabled={!enabled}
          onClick={() => void submit({ kind: model.pass.kind })}
        >
          {passText(model.pass)}
        </button>
        <button
          type="button"
          className="primary-button action-raise"
          data-testid="action-raise"
          disabled={raiseDisabled}
          onClick={() => {
            const action = raiseAction();
            if (action !== null) void submit(action);
          }}
        >
          {raiseLabel}
        </button>
      </div>
      {range === null || !model.mine ? null : (
        <div className="raise-controls">
          <button
            type="button"
            className="ghost-button"
            data-testid="raise-step-down"
            aria-label="少加一档"
            disabled={!enabled}
            onClick={() => stepBy(-1)}
          >
            −
          </button>
          <input
            className="raise-amount"
            data-testid="raise-amount"
            inputMode="numeric"
            aria-label="加注到多少"
            value={text}
            disabled={!enabled}
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="button"
            className="ghost-button"
            data-testid="raise-step-up"
            aria-label="多加一档"
            disabled={!enabled}
            onClick={() => stepBy(1)}
          >
            +
          </button>
          {range.quick.map((pick) => (
            <button
              type="button"
              className="ghost-button raise-quick"
              data-testid={`raise-quick-${pick.id}`}
              key={pick.id}
              disabled={!enabled}
              onClick={() => setText(String(pick.amount))}
            >
              {pick.label}
            </button>
          ))}
          <span className="raise-hint" data-testid="raise-hint" role="status">
            {check?.ok === false ? check.reason : ""}
          </span>
        </div>
      )}
      {error === null ? null : (
        <p className="action-error" data-testid="action-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
