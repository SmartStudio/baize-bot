import { useState } from "react";
import { POKER_PERSONAS, SwapSeatRequest, type PokerSeatNo, type PokerTableView } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";

export type SwapPersona = SwapSeatRequest["persona"];

// 老白不入座，已经在桌上的牌友不能再请一遍，剩下的才是候选。
export const swapCandidates = (table: PokerTableView): SwapPersona[] => {
  const seated = new Set(table.seats.map((seat) => seat.persona));
  return SwapSeatRequest.shape.persona.options.filter((persona) => !seated.has(persona));
};

type Props = {
  table: PokerTableView;
  seat: PokerSeatNo;
  onPick: (persona: SwapPersona) => Promise<void>;
  onClose: () => void;
};

export const SwapSeatDialog = ({ table, seat, onPick, onClose }: Props) => {
  const [picking, setPicking] = useState<SwapPersona | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = table.seats.find((item) => item.seat === seat);

  const pick = (persona: SwapPersona) => {
    setPicking(persona);
    setError(null);
    onPick(persona).catch((cause: unknown) => {
      setPicking(null);
      setError(cause instanceof Error ? cause.message : "换人没成功，再试一次");
    });
  };

  return (
    <div className="scrim" data-testid="swap-seat-dialog">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`换掉${current?.name ?? ""}`}>
        <header className="dialog-head">
          <span>
            <b>换掉{current?.name ?? "这位牌友"}</b>
            <small>挑一位没在桌上的牌友坐 {seat} 号位</small>
          </span>
        </header>
        <div className="swap-options">
          {swapCandidates(table).map((persona) => {
            const card = POKER_PERSONAS[persona];
            return (
              <button
                key={persona}
                type="button"
                className="swap-option"
                data-testid="swap-seat-option"
                disabled={picking !== null}
                onClick={() => pick(persona)}
              >
                <BotAvatar name={card.name} hue={card.hue} size="md" />
                <span>
                  <b>{card.name}</b>
                  <small>{card.line}</small>
                </span>
              </button>
            );
          })}
        </div>
        {error === null ? null : (
          <p className="today-inline-error" role="alert" data-testid="swap-seat-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            data-testid="swap-seat-cancel"
            disabled={picking !== null}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
};
