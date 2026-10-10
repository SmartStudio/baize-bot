import type { RoutineState } from "@baize/shared";

export const ROUTINE_STATE: Record<RoutineState, { label: string; badge: string }> = {
  on: { label: "在跑", badge: "badge-accepted" },
  paused: { label: "暂停了", badge: "badge-await-bot" },
  auto_paused: { label: "自己停了", badge: "badge-warning" },
};

export const RoutineStateChip = ({ state }: { state: RoutineState }) => (
  <span className={`badge ${ROUTINE_STATE[state].badge}`} data-testid="routine-state" data-state={state}>
    {ROUTINE_STATE[state].label}
  </span>
);
