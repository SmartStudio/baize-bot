import type { PokerCard } from "@baize/shared";
import { cardParts, cardText } from "../../state/poker.js";
import "./felt.css";

export const CardFace = ({ card }: { card: PokerCard }) => {
  const { rank, suit, red } = cardParts(card);
  return (
    <span
      className="poker-card card-face"
      data-testid="card-face"
      data-card={card}
      data-red={red}
      role="img"
      aria-label={cardText(card)}
    >
      <span className="card-rank">{rank}</span>
      <span className="card-suit">{suit}</span>
    </span>
  );
};

export const CardBack = () => (
  <span className="poker-card card-back" data-testid="card-back" role="img" aria-label="扣着的牌" />
);
