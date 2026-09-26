import { shelfLoad, shelfRemove, shelfWrite } from "./stamped.js";
import type { Action, ReadyState } from "./types.js";

// 用过几次一变就会重推整条，按 id 就地覆盖。
export const reduceSkills = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "skills_loaded":
      return { ...state, skills: shelfLoad(state.skills, action.botId, action.seq, action.skills, "deleted") };
    case "skill_upserted":
      return { ...state, skills: shelfWrite(state.skills, action.skill.botId, action.seq, action.skill) };
    case "skill_removed":
      return { ...state, skills: shelfRemove(state.skills, action.botId, action.seq, action.skillId) };
    default:
      return state;
  }
};
