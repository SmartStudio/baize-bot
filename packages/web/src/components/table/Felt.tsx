import type { PokerTableView } from "@baize/shared";
import { feltOf, type FeltSeat } from "../../state/poker.js";
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

const Seat = ({ seat, testId }: { seat: FeltSeat; testId: "felt-opponent" | "felt-me" }) => (
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
        <span className="felt-name">{seat.name}</span>
        <span className="felt-stack" data-testid="seat-stack">
          筹码 {seat.stack}
        </span>
      </div>
    </div>
    <span className="felt-label" data-testid="seat-label">
      {seat.label}
    </span>
  </div>
);

export const Felt = ({ table }: { table: PokerTableView | null }) => {
  const felt = feltOf(table);
  if (felt === null) return null;
  return (
    <section className="felt" data-testid="felt" aria-label="牌桌">
      <div className="felt-opponents">
        {felt.opponents.map((seat) => (
          <Seat key={seat.seat} seat={seat} testId="felt-opponent" />
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
          底池 {felt.pot}
        </span>
      </div>
      {felt.me === null ? null : <Seat seat={felt.me} testId="felt-me" />}
    </section>
  );
};
