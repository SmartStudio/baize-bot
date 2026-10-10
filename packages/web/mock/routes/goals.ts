import { ReportMetricRequest } from "@baize/shared";
import { recordSample } from "../state.js";
import { readBody, send, type Route } from "./http.js";

// 照控制面：手动记一个数落一条样本，推 task_updated，回带最新指标的任务卡。单聊和不存在的群 404。
export const goalRoutes: Route = async ({ req, res, path, method, push }) => {
  const match = /^\/api\/projects\/([^/]+)\/metric$/.exec(path);
  if (method !== "POST" || match === null) return false;
  const parsed = ReportMetricRequest.safeParse(await readBody(req));
  if (!parsed.success) {
    send(res, 400, { error: "记的数不对" });
    return true;
  }
  const task = recordSample(decodeURIComponent(match[1] ?? ""), parsed.data.value);
  if (task === null) send(res, 404, { error: "没有这个项目" });
  else {
    push({ type: "task_updated", task });
    send(res, 200, { task });
  }
  return true;
};
