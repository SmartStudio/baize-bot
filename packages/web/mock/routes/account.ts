import { randomUUID } from "node:crypto";
import { ComputerListResponse, ComputerTokenResponse, Settings, UpdateSettingsRequest } from "@baize/shared";
import { at, overnightOf, settings, usageOf, user } from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

export const accountRoutes: Route = async ({ req, res, path, method }) => {
  if (method === "GET" && path === "/api/me") send(res, 200, { user });
  else if (method === "GET" && path === "/api/computers") {
    send(
      res,
      200,
      ComputerListResponse.parse({
        computers: [
          {
            id: "cmp_local",
            ownerId: user.id,
            kind: "local",
            status: "online",
            host: null,
            idleSince: null,
            lastSeenAt: at(1),
          },
          {
            id: "cmp_remote",
            ownerId: user.id,
            kind: "remote",
            status: "online",
            host: "remote.baize.dev",
            idleSince: null,
            lastSeenAt: at(1),
          },
        ],
      }),
    );
  } else if (method === "POST" && path === "/api/computers/local") {
    send(res, 200, ComputerTokenResponse.parse({ computerId: "cmp_local", token: randomUUID() }));
  } else if (method === "GET" && path === "/api/usage") send(res, 200, usageOf());
  else if (method === "GET" && path === "/api/overnight") send(res, 200, overnightOf());
  else if (path === "/api/settings") {
    if (method === "GET") send(res, 200, settings.current);
    else if (method === "PATCH") {
      const parsed = UpdateSettingsRequest.safeParse(await readBody(req));
      if (!parsed.success) send(res, 400, { error: "设置字段不对" });
      else {
        settings.current = Settings.parse({ ...settings.current, ...defined(parsed.data) });
        send(res, 200, settings.current);
      }
    } else return false;
  } else return false;

  return true;
};
