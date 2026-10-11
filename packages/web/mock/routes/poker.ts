import { send, type Route } from "./http.js";

// 第 3 期形状提交的空路由：牌局接口一律 501，和控制面的接缝桩同一个口径，全部路由归单元 6。
export const pokerRoutes: Route = async ({ res, path }) => {
  if (!path.startsWith("/api/poker/")) return false;
  send(res, 501, { error: "未实现" });
  return true;
};
