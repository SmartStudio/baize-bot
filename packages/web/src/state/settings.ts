import type { Action, ReadyState } from "./types.js";

export const reduceSettings = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "tool_upserted": {
      const known = state.tools.some((tool) => tool.id === action.tool.id);
      // 删 Bot 之前发出的请求晚到，快照里还挂着它，按本会话的删除记录剔掉。
      const tool = {
        ...action.tool,
        assignedBotIds: action.tool.assignedBotIds.filter((id) => !state.deletedBotIds.includes(id)),
      };
      return {
        ...state,
        tools: known ? state.tools.map((old) => (old.id === tool.id ? tool : old)) : [...state.tools, tool],
      };
    }
    case "tool_removed":
      return { ...state, tools: state.tools.filter((tool) => tool.id !== action.toolId) };
    case "tools_unsynced":
      if (state.toolsUnsynced.includes(action.botId)) return state;
      return { ...state, toolsUnsynced: [...state.toolsUnsynced, action.botId] };
    case "tools_synced":
      return { ...state, toolsUnsynced: state.toolsUnsynced.filter((id) => id !== action.botId) };
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
