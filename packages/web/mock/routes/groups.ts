import { BotId, CreateGroupRequest, DecideApprovalRequest, SendMessageRequest, UpdateTaskRequest } from "@baize/shared";
import {
  appendMessage,
  approvals,
  approvalsIn,
  assignTask,
  createGroup,
  groups,
  grants,
  handoffsIn,
  isTeamGroup,
  learnFrom,
  lastMessageOf,
  mentionsIn,
  metricOf,
  messageFetchFaults,
  messagesByGroupId,
  pendingApprovalsOf,
  pendingHandoffsOf,
  responderOf,
  canGrant,
  contentIn,
  settleApproval,
  settleLatestPending,
  streamBotReply,
  tasks,
  voidLatestPendingForBot,
  writeTask,
  type ApprovalDecision,
} from "../state.js";
import { defined, readBody, send, type Route } from "./http.js";

const DECISION_WORDS = new Map<string, ApprovalDecision>([
  ["批准", "approved"],
  ["同意", "approved"],
  ["拒绝", "rejected"],
  ["不行", "rejected"],
]);

const groupListItems = () =>
  [...groups.values()].filter(isTeamGroup).map((group) => {
    const task = tasks.get(group.taskId);
    if (task === undefined) throw new Error(`群 ${group.id} 没有主题任务，mock 状态坏了`);
    return {
      group,
      task: { ...task, metric: metricOf(group.id, new Date()) },
      lastMessage: lastMessageOf(group.id),
      pendingApprovals: pendingApprovalsOf(group.id),
      pendingHandoffs: pendingHandoffsOf(group.id),
    };
  });

export const groupRoutes: Route = async ({ req, res, url, path, method, push }) => {
  if (path === "/api/groups") {
    if (method === "GET") send(res, 200, { items: groupListItems() });
    else if (method === "POST") {
      const parsed = CreateGroupRequest.safeParse(await readBody(req));
      if (!parsed.success) send(res, 400, { error: "建群字段不对" });
      else {
        const created = createGroup(parsed.data);
        push({ type: "group_created", group: created.group, task: created.task });
        send(res, 200, created);
      }
    } else return false;
    return true;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (taskMatch !== null && method === "PATCH") {
    const rawTaskId = taskMatch[1];
    const taskId = rawTaskId === undefined ? "" : decodeURIComponent(rawTaskId);
    const parsed = UpdateTaskRequest.safeParse(await readBody(req));
    if (!tasks.has(taskId)) send(res, 404, { error: "没有这个任务" });
    else if (!parsed.success) send(res, 400, { error: "任务字段不对" });
    else {
      const next = writeTask(taskId, defined(parsed.data));
      if (next === null) send(res, 404, { error: "没有这个任务" });
      else {
        push({ type: "task_updated", task: next });
        send(res, 200, { task: next });
      }
    }
    return true;
  }

  const messageMatch = /^\/api\/messages\/([^/]+)$/.exec(path);
  if (messageMatch !== null && method === "GET") {
    const messageId = decodeURIComponent(messageMatch[1] ?? "");
    const message = [...messagesByGroupId.values()].flat().find((item) => item.id === messageId);
    const faults = messageFetchFaults.get(messageId) ?? 0;
    if (faults > 0) {
      messageFetchFaults.set(messageId, faults - 1);
      send(res, 503, { error: "单拉消息暂时失败" });
    } else if (message === undefined) send(res, 404, { error: "没有这条消息" });
    else send(res, 200, { message });
    return true;
  }

  const messagesMatch = /^\/api\/groups\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch !== null) {
    const rawGroupId = messagesMatch[1];
    if (rawGroupId === undefined) send(res, 404, { error: "没有这个群" });
    else {
      const groupId = decodeURIComponent(rawGroupId);
      if (!groups.has(groupId)) send(res, 404, { error: "没有这个群" });
      else if (method === "GET") {
        const all = messagesByGroupId.get(groupId) ?? [];
        const before = url.searchParams.get("before");
        const end = before === null ? all.length : all.findIndex((message) => message.id === before);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const start = Math.max(0, (end < 0 ? all.length : end) - limit);
        const page = all.slice(start, end < 0 ? all.length : end);
        send(res, 200, {
          messages: page,
          hasMore: start > 0,
          approvals: approvalsIn(page),
          handoffs: handoffsIn(page),
          ...contentIn(page),
        });
      } else if (method === "POST") {
        const parsed = SendMessageRequest.safeParse(await readBody(req));
        if (!parsed.success) send(res, 400, { error: "消息不能为空" });
        else {
          const text = parsed.data.text;
          const mentions = mentionsIn(groupId, text);
          const message = appendMessage(
            groupId,
            mentions.length > 0 ? { kind: "user", text, mentions } : { kind: "user", text },
          );
          const decision = DECISION_WORDS.get(text.trim());
          const settled = decision === undefined ? null : settleLatestPending(groupId, decision);
          if (settled !== null) {
            push({ type: "approval_updated", approval: settled });
            send(res, 200, { message });
          } else {
            const responder = responderOf(groupId, mentions);
            if (responder !== null) {
              const voided = voidLatestPendingForBot(groupId, responder);
              if (voided !== null) push({ type: "approval_updated", approval: voided });
            }
            if (responder === null) {
              const note = appendMessage(groupId, { kind: "system", text: "没人接这句话。@ 一个 Bot 派活。" });
              push({ type: "message", message: note });
              send(res, 200, { message });
            } else {
              const assigned = assignTask(groupId, responder);
              if (assigned !== null) push({ type: "task_updated", task: assigned });
              streamBotReply(groupId, responder, text, push).catch((cause: unknown) => {
                process.stderr.write(`mock 回复跑挂了：${String(cause)}\n`);
              });
              const group = groups.get(groupId);
              const learned = group !== undefined && !isTeamGroup(group) ? learnFrom(text) : null;
              if (learned !== null) {
                const card = appendMessage(groupId, {
                  kind: "preference_offer",
                  botId: BotId.parse(responder),
                  text: learned,
                  private: false,
                  sourceMessageId: message.id,
                  status: "offered",
                  preferenceId: null,
                });
                push({ type: "message", message: card });
              }
              send(res, 200, { message });
            }
          }
        }
      } else return false;
    }
    return true;
  }

  const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(path);
  if (approvalMatch === null || method !== "POST") return false;
  const rawApprovalId = approvalMatch[1];
  const id = rawApprovalId === undefined ? "" : decodeURIComponent(rawApprovalId);
  const parsed = DecideApprovalRequest.safeParse(await readBody(req));
  const approval = approvals.get(id);
  if (approval === undefined) send(res, 404, { error: "没有这条审批" });
  else if (!parsed.success) send(res, 400, { error: "结论只能是批准或拒绝" });
  else if (parsed.data.decision === "approved" && !canGrant(approval, parsed.data.scope)) {
    send(res, 400, { error: "这条审批只能批这一次" });
  } else {
    const next = settleApproval(
      id,
      parsed.data.decision,
      parsed.data.decision === "approved" ? parsed.data.scope : "once",
    );
    if (next === null) send(res, 409, { error: "这条审批已经有结论了" });
    else {
      push({ type: "approval_updated", approval: next });
      send(res, 200, { approval: next, grant: next.grantId === null ? null : (grants.get(next.grantId) ?? null) });
    }
  }
  return true;
};
