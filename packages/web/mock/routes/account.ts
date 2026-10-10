import { randomUUID } from "node:crypto";
import { ComputerTokenResponse, DeleteAccountRequest, Settings, UpdateSettingsRequest } from "@baize/shared";
import {
  bots,
  brand,
  computersOf,
  drafts,
  preferencesOf,
  routines,
  settings,
  skillsOf,
  tasks,
  usageOf,
  user,
} from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

// 照控制面 repo/export.ts 的白名单：工具连接、平台账号、电脑带凭据，整段不进。
const exportOf = () => ({
  format: 1,
  exportedAt: new Date().toISOString(),
  user,
  settings: settings.current,
  brand: brand.current,
  bots: [...bots.values()].map((bot) => ({ ...bot, skills: skillsOf(bot.id), preferences: preferencesOf(bot.id) })),
  routines: [...routines.values()],
  projects: [...tasks.values()],
  drafts: [...drafts.values()],
});

export const accountRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "GET" && path === "/api/me") send(res, 200, { user });
  else if (method === "DELETE" && path === "/api/me") {
    // mock 整局共用一份种子，不真删；只照控制面校验邮箱、清掉这次的 cookie。
    const parsed = DeleteAccountRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "请输入邮箱确认" });
    else if (parsed.data.email !== user.email) send(res, 400, { error: "邮箱和当前账号不符" });
    else {
      res.setHeader("set-cookie", "baize_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      send(res, 204);
    }
  } else if (method === "GET" && path === "/api/export") {
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("content-disposition", `attachment; filename="baize-export-${day}.json"`);
    send(res, 200, exportOf());
  } else if (method === "GET" && path === "/api/computers") {
    send(res, 200, computersOf());
  } else if (method === "POST" && path === "/api/computers/local") {
    send(res, 200, ComputerTokenResponse.parse({ computerId: "cmp_local", token: randomUUID() }));
  } else if (method === "POST" && path === "/api/computers/remote") {
    const remote = computersOf().computers.find((computer) => computer.kind === "remote");
    if (remote !== undefined) push({ type: "computer_updated", computer: remote });
    send(res, 200, ComputerTokenResponse.parse({ computerId: "cmp_remote", token: randomUUID() }));
  } else if (method === "GET" && path === "/api/usage") send(res, 200, usageOf());
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
