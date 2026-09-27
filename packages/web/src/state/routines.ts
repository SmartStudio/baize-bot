import { shelfLoad, shelfRemove, shelfWrite } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

// 例行按 GET /api/routines 一次拉全，整份只有一个桶。
export const MY_ROUTINES = "mine";

// 每次运行记录变化都会重推整条，按 id 就地覆盖。
export const reduceRoutines = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "routines_loaded":
      return {
        ...state,
        routines: shelfLoad(state.routines, MY_ROUTINES, action.seq, action.routines, "deleted"),
      };
    case "routine_upserted":
      return { ...state, routines: shelfWrite(state.routines, MY_ROUTINES, action.seq, action.routine) };
    case "routine_removed":
      return { ...state, routines: shelfRemove(state.routines, MY_ROUTINES, action.seq, action.routineId) };
    default:
      return state;
  }
};
