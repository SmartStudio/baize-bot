import { shelfLoad, shelfRemove, shelfWrite } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

// 偏好和 skill 一样按 Bot 分架，推送整条按 id 覆盖。
// 偏好 id 不复用，删除是终态：确认删掉（DELETE 的 204/404，或 preference_deleted 推送）之后，
// 该 id 的更新不管取到多大的号都不再写回。本地的号只表达收到的先后，拦不住删除之后才处理的旧更新帧。
export const reducePreferences = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "preferences_loaded":
      return {
        ...state,
        preferences: shelfLoad(state.preferences, action.botId, action.seq, action.preferences, "deleted"),
      };
    case "preference_upserted":
      if (state.deletedPreferences[action.preference.id]) return state;
      return {
        ...state,
        preferences: shelfWrite(state.preferences, action.preference.botId, action.seq, action.preference),
      };
    case "preference_removed":
      return {
        ...state,
        preferences: shelfRemove(state.preferences, action.botId, action.seq, action.preferenceId),
        deletedPreferences: { ...state.deletedPreferences, [action.preferenceId]: true },
      };
    default:
      return state;
  }
};
