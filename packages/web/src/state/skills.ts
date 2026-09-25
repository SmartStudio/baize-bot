import type { Action, ReadyState } from "./types.js";

export const reduceSkills = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "skills_loaded":
      return { ...state, skills: { ...state.skills, [action.botId]: action.skills } };
    case "skill_upserted": {
      const known = state.skills[action.skill.botId];
      if (known === undefined) return state;
      const seen = known.some((s) => s.id === action.skill.id);
      // 用过几次一变就会重推整条。按 id 覆盖且不挪位置，列表不会在你正看着的时候跳一下。
      const next = seen ? known.map((s) => (s.id === action.skill.id ? action.skill : s)) : [...known, action.skill];
      return { ...state, skills: { ...state.skills, [action.skill.botId]: next } };
    }
    case "skill_removed": {
      const known = state.skills[action.botId];
      if (known === undefined) return state;
      return { ...state, skills: { ...state.skills, [action.botId]: known.filter((s) => s.id !== action.skillId) } };
    }
    default:
      return state;
  }
};
