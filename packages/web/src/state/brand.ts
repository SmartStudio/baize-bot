import type { Action, ReadyState } from "./types.js";

// 一个用户一本，推送和接口回的都是整本，直接换。
export const reduceBrand = (state: ReadyState, action: Action): ReadyState =>
  action.type === "brand_set" ? { ...state, brand: action.brand } : state;
