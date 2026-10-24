import { ReportMetricRequest } from "@baize/shared";
import { recordSample } from "../state.js";
import { readBody, send, type Route } from "./http.js";

export const goalRoutes: Route = async ({ req, res, path, method, push }) => {
  const match = /^\/api\/projects\/([^/]+)\/metric$/.exec(path);
  if (method !== "POST" || match === null) return false;
  const parsed = ReportMetricRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: "记的数不对" });
    return true;
  }
  const task = recordSample(decodeURIComponent(match[1] ?? ""), parsed.data.value, Date.now(), parsed.data.metric);
  if (task === null) send(res, 404, { error: "没有这个项目" });
  else if (task === "unknown_metric") send(res, 400, { error: "这个项目没挂这个指标" });
  else {
    push({ type: "task_updated", task });
    send(res, 200, { task });
  }
  return true;
};
