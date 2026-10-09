import { send, type Route } from "./http.js";

/** 第 2 期形状占位：路径认得，一律回 501，p2-brand-web 换成真 mock。 */
export const brandRoutes: Route = async ({ res, path, method }) => {
  if (path !== "/api/brand" || (method !== "GET" && method !== "PUT")) return false;
  send(res, 501, { error: "未实现" });
  return true;
};
