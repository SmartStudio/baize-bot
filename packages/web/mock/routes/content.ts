import {
  AccountListResponse,
  ApprovePlanRequest,
  CreateAccountRequest,
  DecideDraftRequest,
  LoginAccountRequest,
  OAuthPlatform,
  UpdateAccountRequest,
} from "@baize/shared";
import {
  accounts,
  connectOAuthAccount,
  createAccount,
  decideDraft,
  loginAccount,
  setAccountTier,
  settlePlan,
} from "../state.js";
import { readBody, send, type Route } from "./http.js";

const idOf = (match: RegExpExecArray): string => decodeURIComponent(match[1] ?? "");

export const contentRoutes: Route = async ({ req, res, path, method, push }) => {
  const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(path);
  if (draftMatch !== null && method === "POST") {
    const parsed = DecideDraftRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "结论只能是批准或退回" });
    else {
      const outcome = decideDraft(idOf(draftMatch), parsed.data);
      if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
      else {
        push({ type: "draft_updated", draft: outcome.value });
        send(res, 200, { draft: outcome.value });
      }
    }
    return true;
  }

  const planMatch = /^\/api\/plans\/([^/]+)\/(approve|return)$/.exec(path);
  if (planMatch !== null && method === "POST") {
    const body = await readBody(req);
    const parsed = planMatch[2] === "approve" ? ApprovePlanRequest.safeParse(body) : null;
    if (parsed !== null && !parsed.success) send(res, 400, { error: "改动的格式不对" });
    else {
      const outcome = settlePlan(
        idOf(planMatch),
        parsed === null ? { decision: "return" } : { decision: "approve", edits: parsed.data.edits },
      );
      if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
      else {
        push({ type: "plan_updated", plan: outcome.value.plan });
        for (const draft of outcome.value.drafts) push({ type: "draft_updated", draft });
        send(res, 200, parsed === null ? { plan: outcome.value.plan } : outcome.value);
      }
    }
    return true;
  }

  if (method === "GET" && path === "/api/accounts") {
    send(res, 200, AccountListResponse.parse({ accounts: [...accounts.values()] }));
    return true;
  }

  if (method === "POST" && path === "/api/accounts") {
    const parsed = CreateAccountRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "只能加小红书账号，并选一台电脑" });
    else {
      const outcome = createAccount(parsed.data);
      if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
      else {
        push({ type: "account_updated", account: outcome.value.account });
        send(res, outcome.value.created ? 201 : 200, { account: outcome.value.account });
      }
    }
    return true;
  }

  // 不去平台，start 直接当回调成功：挂上账号、推 account_updated，再 302 回首页。
  const oauthMatch = /^\/api\/oauth\/([^/]+)\/start$/.exec(path);
  if (oauthMatch !== null && method === "GET") {
    const platform = OAuthPlatform.safeParse(idOf(oauthMatch));
    if (!platform.success) send(res, 404, { error: "这个平台不走授权登录" });
    else {
      push({ type: "account_updated", account: connectOAuthAccount(platform.data) });
      res.writeHead(302, { location: `/?${new URLSearchParams({ oauth: platform.data, result: "connected" })}` });
      res.end();
    }
    return true;
  }

  const loginMatch = /^\/api\/accounts\/([^/]+)\/login$/.exec(path);
  if (loginMatch !== null && method === "POST") {
    const parsed = LoginAccountRequest.safeParse(await readBody(req));
    if (!parsed.success) {
      send(res, 400, { error: "尝试号不对" });
      return true;
    }
    const outcome = loginAccount(idOf(loginMatch), parsed.data.attempt);
    if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
    else send(res, 202, outcome.value);
    return true;
  }

  const accountMatch = /^\/api\/accounts\/([^/]+)$/.exec(path);
  if (accountMatch !== null && method === "PATCH") {
    const parsed = UpdateAccountRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "档位不对" });
    else {
      const outcome = setAccountTier(idOf(accountMatch), parsed.data.tier);
      if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
      else {
        push({ type: "account_updated", account: outcome.value });
        send(res, 200, { account: outcome.value });
      }
    }
    return true;
  }

  return false;
};
