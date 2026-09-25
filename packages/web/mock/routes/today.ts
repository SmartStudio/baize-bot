import { todayOf } from "../state.js";
import { send, type Route } from "./http.js";

export const todayRoutes: Route = async ({ res, path, method }) => {
  if (method === "GET" && path === "/api/today") {
    send(res, 200, todayOf());
    return true;
  }
  return false;
};
