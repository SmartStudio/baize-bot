import { send, type Route } from "./http.js";

/** 第 2 期形状占位：路径认得，一律回 501，p2-botpage-web 换成真 mock。 */
export const preferenceRoutes: Route = async ({ res, path, method }) => {
  const botSide = method === "GET" && /^\/api\/bots\/[^/]+\/(preferences|profile)$/.test(path);
  const single = (method === "PATCH" || method === "DELETE") && /^\/api\/preferences\/[^/]+$/.test(path);
  if (!botSide && !single) return false;
  send(res, 501, { error: "未实现" });
  return true;
};
