import { GrantId } from "@baize/shared";
import { grants } from "../state.js";
import { send, type Route } from "./http.js";

export const grantRoutes: Route = async ({ res, path, method, push }) => {
  if (method === "GET" && path === "/api/grants") {
    send(res, 200, { grants: [...grants.values()] });
    return true;
  }

  const match = /^\/api\/grants\/([^/]+)$/.exec(path);
  if (match === null || method !== "DELETE") return false;
  const rawId = match[1];
  if (rawId === undefined) {
    send(res, 404, { error: "没有这条授权" });
    return true;
  }
  const id = decodeURIComponent(rawId);
  if (!grants.delete(id)) send(res, 404, { error: "没有这条授权" });
  else {
    push({ type: "grant_deleted", grantId: GrantId.parse(id) });
    send(res, 204);
  }
  return true;
};
