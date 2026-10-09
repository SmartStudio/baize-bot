import { send, type Route } from "./http.js";

/** 第 2 期形状占位：路径认得，一律回 501，p2-goal-web 换成真 mock。 */
export const goalRoutes: Route = async ({ res, path, method }) => {
  if (method !== "POST" || !/^\/api\/projects\/[^/]+\/metric$/.test(path)) return false;
  send(res, 501, { error: "未实现" });
  return true;
};
