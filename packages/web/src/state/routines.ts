import type { Action, ReadyState } from "./types.js";

export const reduceRoutines = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "routines_loaded":
      return { ...state, routines: { ...state.routines, [action.botId]: action.routines } };
    case "routine_upserted": {
      const known = state.routines[action.routine.botId];
      if (known === undefined) return state;
      const seen = known.some((r) => r.id === action.routine.id);
      // 每次运行记录变化都会重推整条。按 id 覆盖且不挪位置，列表不会在你正看着的时候跳一下。
      const next = seen
        ? known.map((r) => (r.id === action.routine.id ? action.routine : r))
        : [...known, action.routine];
      return { ...state, routines: { ...state.routines, [action.routine.botId]: next } };
    }
    case "routine_removed": {
      const known = state.routines[action.botId];
      if (known === undefined) return state;
      return {
        ...state,
        routines: { ...state.routines, [action.botId]: known.filter((r) => r.id !== action.routineId) },
      };
    }
    default:
      return state;
  }
};
