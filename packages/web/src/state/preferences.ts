import { shelfLoad, shelfRemove, shelfWrite } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

// 偏好和 skill 一样按 Bot 分架，推送整条按 id 覆盖。
export const reducePreferences = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "preferences_loaded":
      return {
        ...state,
        preferences: shelfLoad(state.preferences, action.botId, action.seq, action.preferences, "deleted"),
      };
    case "preference_upserted":
      return {
        ...state,
        preferences: shelfWrite(state.preferences, action.preference.botId, action.seq, action.preference),
      };
    case "preference_removed":
      return {
        ...state,
        preferences: shelfRemove(state.preferences, action.botId, action.seq, action.preferenceId),
      };
    default:
      return state;
  }
};
