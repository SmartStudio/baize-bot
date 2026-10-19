import { POKER_PERSONAS, type PokerSeatNo, type PokerTableView } from "@baize/shared";
import { BotAvatar } from "../BotAvatar.js";

type Props = {
  table: PokerTableView;
  // 刚换完人的那一句，下一次换人或离开页面才没。
  notice: string | null;
  onSwap: (seat: PokerSeatNo) => void;
};

export const SeatsBlock = ({ table, notice, onSwap }: Props) => {
  const friends = table.seats.filter((seat) => seat.kind === "bot").toSorted((a, b) => a.seat - b.seat);
  const handRunning = table.status === "in_hand";

  return (
    <section className="poker-seats" data-testid="poker-seats">
      <div className="poker-block-head">
        <h2>牌友</h2>
        <span>你坐 4 号位</span>
      </div>
      <div className="poker-seat-list">
        {friends.map((seat) => (
          <article key={seat.seat} className="poker-seat" data-testid="poker-seat" data-seat-name={seat.name}>
            <BotAvatar shape={seat.shape} hue={seat.hue} size="md" />
            <div className="poker-seat-who">
              <b data-testid="poker-seat-name">{seat.name}</b>
              <small data-testid="poker-seat-line">
                {seat.persona === null ? "" : POKER_PERSONAS[seat.persona].line}
              </small>
            </div>
            <button
              type="button"
              className="ghost-button"
              data-testid="poker-seat-swap"
              aria-label={`换掉 ${seat.name}`}
              disabled={handRunning}
              onClick={() => onSwap(seat.seat)}
            >
              换人
            </button>
          </article>
        ))}
        <article className="poker-seat" data-testid="poker-seat" data-seat-name={table.host.name}>
          <BotAvatar shape={table.host.shape} hue={table.host.hue} size="md" />
          <div className="poker-seat-who">
            <b data-testid="poker-seat-name">{table.host.name}</b>
            <small data-testid="poker-seat-line">{POKER_PERSONAS.laobai.line}</small>
          </div>
        </article>
      </div>
      {handRunning ? (
        <p className="poker-seats-note" data-testid="poker-seats-note">
          这手打完才能换人。
        </p>
      ) : null}
      {notice === null ? null : (
        <p className="poker-swap-notice" role="status" data-testid="poker-swap-notice">
          {notice}
        </p>
      )}
    </section>
  );
};
