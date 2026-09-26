import { createApi, type Api } from "../api/client.js";
import type { Seq } from "./stamped.js";
import type { LoadKey, SessionId } from "./types.js";

// 同一个桶在途的那一趟：seq 是它发出时取的号；again 表示它发出之后又有人要一份比它新的，回来后补拉一次。
export type Flight = { seq: Seq; again: boolean };

export type Session = { id: SessionId; api: Api; signal: AbortSignal; flights: Map<LoadKey, Flight> };

// 一次登录、注册或打开页面时的自动登录。认证和入口数据都挂在它的 signal 上，新的尝试一开始旧的就取消。
export type Attempt = { id: number; api: Api; signal: AbortSignal };

// 会话里的请求都挂在这次会话的 signal 上，登出时一并取消。已经拿到回包、取消不掉的，由 reducer 按会话号丢掉。
export const createSessions = () => {
  let last = 0;
  let live: (Session & { controller: AbortController }) | null = null;
  let lastAttempt = 0;
  let pending: AbortController | null = null;
  const end = (id?: SessionId) => {
    if (live === null || (id !== undefined && live.id !== id)) return;
    live.controller.abort();
    live = null;
  };
  return {
    attempt: (): Attempt => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      return { id: ++lastAttempt, api: createApi(controller.signal), signal: controller.signal };
    },
    isCurrent: (attempt: Attempt): boolean => attempt.id === lastAttempt,
    // 只有最近一次尝试能进会话，晚到的旧尝试拿到 null，调用方就此丢掉它的入口数据。尝试的 signal 接着当会话的用。
    begin: (attempt: Attempt): SessionId | null => {
      if (attempt.id !== lastAttempt || pending === null) return null;
      const controller = pending;
      pending = null;
      end();
      live = { id: ++last as SessionId, api: attempt.api, signal: attempt.signal, controller, flights: new Map() };
      return live.id;
    },
    current: (): Session | null => live,
    end,
  };
};
