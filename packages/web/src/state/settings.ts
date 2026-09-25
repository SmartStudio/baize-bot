import type { Action, ReadyState } from "./types.js";

export const reduceSettings = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "tool_upserted": {
      const known = state.tools.some((tool) => tool.id === action.tool.id);
      return {
        ...state,
        tools: known
          ? state.tools.map((tool) => (tool.id === action.tool.id ? action.tool : tool))
          : [...state.tools, action.tool],
      };
    }
    case "tool_removed":
      return { ...state, tools: state.tools.filter((tool) => tool.id !== action.toolId) };
    case "settings_set":
      return { ...state, settings: action.settings };
    case "usage_loaded":
      return { ...state, usage: action.usage };
    default:
      return state;
  }
};
