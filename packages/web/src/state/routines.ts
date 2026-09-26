import { shelfLoad, shelfRemove, shelfWrite } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

// 每次运行记录变化都会重推整条，按 id 就地覆盖。
export const reduceRoutines = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "routines_loaded":
      return {
        ...state,
        routines: shelfLoad(state.routines, action.botId, action.seq, action.routines, "deleted"),
      };
    case "routine_upserted":
      return {
        ...state,
        routines: shelfWrite(state.routines, action.routine.botId, action.seq, action.routine),
      };
    case "routine_removed":
      return { ...state, routines: shelfRemove(state.routines, action.botId, action.seq, action.routineId) };
    default:
      return state;
  }
};
