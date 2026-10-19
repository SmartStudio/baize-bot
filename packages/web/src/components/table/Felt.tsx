import { useEffect, useState } from "react";
import type { PokerTableView } from "@baize/shared";
import { feltOf, formatChips, type FeltSeat } from "../../state/poker.js";
import { BotAvatar } from "../BotAvatar.js";
import { CardBack, CardFace } from "./CardFace.js";
import "./felt.css";

const Hand = ({ seat }: { seat: FeltSeat }) => {
  if (!seat.hasCards) return <div className="felt-hand" />;
  return (
    <div className="felt-hand">
      {seat.cards === null ? (
        <>
          <CardBack />
          <CardBack />
        </>
      ) : (
        seat.cards.map((card) => <CardFace key={card} card={card} />)
      )}
    </div>
  );
};

// 牌友出牌有 60 秒的兜底，倒数只在有期限时走，一秒一跳。
const useSecondsLeft = (deadline: string | null): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
};

const Seat = ({
  seat,
  testId,
  secondsLeft,
}: {
  seat: FeltSeat;
  testId: "felt-opponent" | "felt-me";
  secondsLeft: number | null;
}) => (
  <div
    className="felt-seat"
    data-testid={testId}
    data-seat={seat.seat}
    data-status={seat.status}
    data-acting={seat.acting}
  >
    <Hand seat={seat} />
    <div className="felt-plate">
      <BotAvatar shape={seat.shape} hue={seat.hue} size="sm" />
      <div className="felt-who">
        <span className="felt-name">
          {seat.name}
          {seat.marker === null ? null : (
            <span className="felt-marker" data-testid="seat-marker">
              {seat.marker}
            </span>
          )}
        </span>
        <span className="felt-stack" data-testid="seat-stack">
          筹码 {formatChips(seat.stack)}
        </span>
      </div>
    </div>
    <div className="felt-tags">
      {seat.acting ? (
        <span className="felt-turn" data-testid="seat-turn">
          {testId === "felt-me" ? "轮到你" : secondsLeft === null ? "在想" : `在想 · ${secondsLeft} 秒`}
        </span>
      ) : null}
      <span className="felt-label" data-testid="seat-label">
        {seat.label}
      </span>
      {seat.won > 0 ? (
        <span className="felt-won" data-testid="seat-won">
          赢 {formatChips(seat.won)}
        </span>
      ) : null}
    </div>
    <span className="felt-bet" data-testid="seat-bet">
      {seat.bet > 0 ? formatChips(seat.bet) : ""}
    </span>
  </div>
);

export const Felt = ({ table }: { table: PokerTableView | null }) => {
  const felt = feltOf(table);
  const secondsLeft = useSecondsLeft(felt?.deadline ?? null);
  if (felt === null) return null;
  return (
    <section className="felt" data-testid="felt" aria-label="牌桌">
      <div className="felt-opponents">
        {felt.opponents.map((seat) => (
          <Seat key={seat.seat} seat={seat} testId="felt-opponent" secondsLeft={seat.acting ? secondsLeft : null} />
        ))}
      </div>
      <div className="felt-middle">
        <span className="felt-street">{felt.streetLabel}</span>
        <div className="felt-board">
          {felt.board.map((card, index) => (
            <div className="felt-slot" data-testid="board-slot" key={index}>
              {card === null ? null : <CardFace card={card} />}
            </div>
          ))}
        </div>
        <span className="felt-pot" data-testid="pot">
          底池 {formatChips(felt.pot)}
        </span>
      </div>
      {felt.me === null ? null : <Seat seat={felt.me} testId="felt-me" secondsLeft={null} />}
    </section>
  );
};
