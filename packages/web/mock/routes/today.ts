import { projectOf, todayOf } from "../state.js";
import { send, type Route } from "./http.js";

export const todayRoutes: Route = async ({ res, path, method }) => {
  if (method === "GET" && path === "/api/today") {
    send(res, 200, todayOf());
    return true;
  }
  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (method === "GET" && projectMatch !== null) {
    const project = projectOf(decodeURIComponent(projectMatch[1] ?? ""));
    if (project === null) send(res, 404, { error: "没有这个对象" });
    else send(res, 200, project);
    return true;
  }
  return false;
};
