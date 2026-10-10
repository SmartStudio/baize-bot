import type { BrandBook } from "@baize/shared";
import type { Action, ReadyState } from "./types.js";

const versionOf = (brand: BrandBook | null) => brand?.version ?? 0;

// 一个用户一本，推送和接口回的都是整本，都走 brand_set。控制面提交后的广播不保证按版本先后到，
// 不比手上新的那本一律丢掉，晚到的旧版才盖不回来。
export const reduceBrand = (state: ReadyState, action: Action): ReadyState =>
  action.type === "brand_set" && versionOf(action.brand) > versionOf(state.brand)
    ? { ...state, brand: action.brand }
    : state;
