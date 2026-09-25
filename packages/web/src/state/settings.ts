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
    // 授权 id 不复用，撤掉的记下来就一直作数。在途的列表请求可能比 grant_deleted 晚到，不能把撤掉的那行带回来。
    case "grants_loaded":
      return { ...state, grants: action.grants.filter((grant) => !state.revokedGrantIds.includes(grant.id)) };
    case "grant_upserted":
      if (state.revokedGrantIds.includes(action.grant.id)) return state;
      return {
        ...state,
        grants: state.grants.some((grant) => grant.id === action.grant.id)
          ? state.grants.map((grant) => (grant.id === action.grant.id ? action.grant : grant))
          : [...state.grants, action.grant],
      };
    case "grant_deleted":
      return {
        ...state,
        grants: state.grants.filter((grant) => grant.id !== action.grantId),
        revokedGrantIds: state.revokedGrantIds.includes(action.grantId)
          ? state.revokedGrantIds
          : [...state.revokedGrantIds, action.grantId],
      };
    default:
      return state;
  }
};
