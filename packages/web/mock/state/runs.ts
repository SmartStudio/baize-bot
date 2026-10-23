import {
  Approval,
  ApprovalId,
  ApprovalScope,
  GRANTABLE_SCOPES,
  BotId,
  GroupId,
  Grant,
  GrantId,
  Handoff,
  HandoffId,
  RunId,
  type Message,
  type ServerPush,
  type ToolCallStatus,
} from "@baize/shared";
import { startRunOn } from "./computer-choices.js";
import { assignTask, tickFirstUndone } from "./groups.js";
import { appendMessage, rewriteMessage } from "./messages.js";
import { projectOfferFor } from "./projects.js";
import {
  TEAM_GROUP_ID,
  approvals,
  currentGeneration,
  groups,
  handoffAcceptance,
  handoffWaiters,
  handoffs,
  nextSuffix,
  tasks,
  waiters,
  grants,
  type ApprovalDecision,
} from "./store.js";

export const createApproval = (input: {
  groupId: string;
  botId: BotId;
  runId: RunId;
  action: Approval["action"];
  target?: Approval["target"];
  view: Approval["view"];
  deadlineAt?: Approval["deadlineAt"];
}): Approval => {
  const approval = Approval.parse({
    id: ApprovalId.parse(`apr_${nextSuffix()}`),
    groupId: GroupId.parse(input.groupId),
    botId: input.botId,
    runId: input.runId,
    action: input.action,
    target: input.target ?? null,
    view: input.view,
    status: "pending",
    decidedAt: null,
    deadlineAt: input.deadlineAt ?? null,
    grantId: null,
  });
  approvals.set(approval.id, approval);
  return approval;
};

// 查状态和写结论是同一步，中间没有让别人插进来的缝。按钮和群里回的那句话会同时到，两边都先看到 pending
// 再各写一次的话，后写的那个会把结论翻过来，而等结论的运行早就按先到的那个跑完了。
// null 表示这条没得决定：查不到，或者已经有结论了。
// 控制面的同一条规则：长期授权按目标匹配，目标为空存不下；动作不许的范围也不收。
export const canGrant = (approval: Approval, scope: ApprovalScope): boolean =>
  scope === "once" || (approval.target !== null && GRANTABLE_SCOPES[approval.action].includes(scope));

export const settleApproval = (
  id: string,
  decision: ApprovalDecision,
  scope: ApprovalScope = "once",
): Approval | null => {
  const approval = approvals.get(id);
  if (approval === undefined || approval.status !== "pending") return null;
  const grant =
    decision === "approved" && scope !== "once" && approval.target !== null
      ? Grant.parse({
          id: GrantId.parse(`grant_${nextSuffix()}`),
          scope,
          ...(scope === "project" ? { groupId: approval.groupId } : {}),
          action: approval.action,
          target: approval.target,
          createdAt: new Date().toISOString(),
        })
      : null;
  if (grant !== null) grants.set(grant.id, grant);
  const next = Approval.parse({
    ...approval,
    status: decision,
    decidedAt: new Date().toISOString(),
    grantId: grant?.id ?? null,
  });
  approvals.set(next.id, next);
  waiters.get(next.id)?.(decision);
  waiters.delete(next.id);
  return next;
};

const pendingIn = (groupId: string): Approval[] =>
  [...approvals.values()].filter((a) => a.groupId === groupId && a.status === "pending");

export const pendingApprovalsOf = (groupId: string): number => pendingIn(groupId).length;

export const settleLatestPending = (groupId: string, decision: ApprovalDecision): Approval | null => {
  const waiting = pendingIn(groupId).at(-1);
  return waiting === undefined ? null : settleApproval(waiting.id, decision);
};

export const expireLatestPending = (): Approval | null => {
  const waiting = [...approvals.values()].findLast((approval) => approval.status === "pending");
  if (waiting === undefined) return null;
  const next = Approval.parse({ ...waiting, status: "expired", decidedAt: null });
  approvals.set(next.id, next);
  waiters.get(next.id)?.("rejected");
  waiters.delete(next.id);
  return next;
};

export const timeOutLatestPending = (): Approval | null => {
  const waiting = [...approvals.values()].findLast((approval) => approval.status === "pending");
  if (waiting === undefined) return null;
  const next = Approval.parse({ ...waiting, status: "timed_out", decidedAt: new Date().toISOString() });
  approvals.set(next.id, next);
  waiters.get(next.id)?.("rejected");
  waiters.delete(next.id);
  return next;
};

export const voidLatestPendingForBot = (groupId: string, botId: BotId): Approval | null => {
  const waiting = [...approvals.values()].findLast(
    (approval) => approval.groupId === groupId && approval.botId === botId && approval.status === "pending",
  );
  if (waiting === undefined) return null;
  const next = Approval.parse({ ...waiting, status: "voided", decidedAt: new Date().toISOString() });
  approvals.set(next.id, next);
  waiters.get(next.id)?.("rejected");
  waiters.delete(next.id);
  return next;
};

// approval 消息的正文只有 approvalId，状态在 Approval 上。这一页引用到的跟着这一页回，客户端不用再问一次。
export const approvalsIn = (messages: Message[]): Approval[] => {
  const found: Approval[] = [];
  for (const message of messages) {
    if (message.body.kind !== "approval") continue;
    const approval = approvals.get(message.body.approvalId);
    if (approval) found.push(approval);
  }
  return found;
};

// 交接卡的正文只有 handoffId，状态在 Handoff 上。跟审批一样，这一页引用到的跟着这一页回。
export const handoffsIn = (messages: Message[]): Handoff[] => {
  const found: Handoff[] = [];
  for (const message of messages) {
    if (message.body.kind !== "handoff") continue;
    const handoff = handoffs.get(message.body.handoffId);
    if (handoff) found.push(handoff);
  }
  return found;
};

export const pendingHandoffsOf = (groupId: string): number =>
  [...handoffs.values()].filter((h) => h.groupId === groupId && h.status === "pending").length;

// 交接报文指向的是「下一个人该从哪一项接着做」，所以指针取交接这一刻第一项还没勾掉的。全勾完了就没什么可指的。
const nextUndoneIndexOf = (groupId: string): number | null => {
  const taskId = groups.get(groupId)?.taskId;
  const at = (taskId === undefined ? undefined : tasks.get(taskId))?.checklist.findIndex((item) => !item.done) ?? -1;
  return at < 0 ? null : at;
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const chunked = (text: string, count: number): string[] => {
  const letters = [...text];
  const size = Math.ceil(letters.length / count);
  const parts: string[] = [];
  for (let i = 0; i < letters.length; i += size) parts.push(letters.slice(i, i + size).join(""));
  return parts;
};

// 真控制面要等运行时回话。这些延迟把一次运行的真实节奏摆出来：工具先跑起来，正文一段段吐，最后结账。
const REPLY_DELAY_MS = 120;
const TOOL_CALL_MS = 1000;
const DELTA_MS = 80;
const DELTA_COUNT = 4;

// 这次运行用的工具要不要点头，写死在 prompt 上：出现「发」「付」或「退款」就要。镜像 bot-runner/README.md 的
// 工具名前缀规则（send_ 映射 send_external、pay_ 映射 pay），含「发」当对外发送，其余当付钱。
const approvalFor = (prompt: string): { tool: string; action: Approval["action"] } | null => {
  if (!/[发付]|退款/.test(prompt)) return null;
  return prompt.includes("发")
    ? { tool: "send_email", action: "message_person" }
    : { tool: "pay_refund", action: "spend" };
};

const waitForDecision = (id: string): Promise<ApprovalDecision> => new Promise((resolve) => waiters.set(id, resolve));

// mock 只演一次交接，对着原型 05：小服在群里把手上这一段干完，把剩下的供货确认交给小采，两秒后小采接手。
// 真控制面里交给谁由 Bot 自己的 handoff_task 决定，这里写死一条，用例才数得清角标和当前经手。
const HANDOFF_SCRIPT = {
  fromBotId: "bot_service",
  toBotId: "bot_buy",
  done: "查完 Globex 的 X3 库存与排产：10 月 20 日能先交 120 台，联系人和交期口径都记在任务卡上了。",
  notDone: "剩下 80 台的货期还没定，三家供应商的现货和到货期一家都没问。",
  next: "找 3 家供应商问 X3 现货和最早到货日，回来补进任务卡。",
};

const HANDOFF_ACCEPT_MS = 2000;

export const holdHandoffAccept = (): void => {
  handoffAcceptance.automatic = false;
};

export const confirmNextHandoff = (): boolean => {
  const wake = handoffWaiters.values().next().value;
  if (wake === undefined) return false;
  wake();
  return true;
};

const waitForHandoffAccept = (id: string): Promise<void> =>
  new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      if (timer !== null) clearTimeout(timer);
      handoffWaiters.delete(id);
      resolve();
    };
    handoffWaiters.set(id, wake);
    if (handoffAcceptance.automatic) timer = setTimeout(wake, HANDOFF_ACCEPT_MS);
  });

const pendingHandoff = (groupId: string, fromBotId: BotId, toBotId: BotId): Handoff =>
  Handoff.parse({
    id: HandoffId.parse(`hof_${nextSuffix()}`),
    groupId: GroupId.parse(groupId),
    fromBotId,
    toBotId,
    done: HANDOFF_SCRIPT.done,
    notDone: HANDOFF_SCRIPT.notDone,
    next: HANDOFF_SCRIPT.next,
    checklistIndex: nextUndoneIndexOf(groupId),
    status: "pending",
    createdAt: new Date().toISOString(),
    acceptedAt: null,
  });

export const seedUnseenHandoff = (): Handoff => {
  const handoff = pendingHandoff(
    TEAM_GROUP_ID,
    BotId.parse(HANDOFF_SCRIPT.fromBotId),
    BotId.parse(HANDOFF_SCRIPT.toBotId),
  );
  handoffs.set(handoff.id, handoff);
  return handoff;
};

export const settleUnseenHandoff = (): Handoff | null => {
  const handoff = [...handoffs.values()].find((item) => item.status === "pending");
  if (handoff === undefined) return null;
  const accepted = Handoff.parse({ ...handoff, status: "accepted", acceptedAt: new Date().toISOString() });
  handoffs.set(accepted.id, accepted);
  return accepted;
};

const playHandoff = async (groupId: string, botId: BotId, push: (event: ServerPush) => void): Promise<void> => {
  const run = currentGeneration();
  const group = groups.get(groupId);
  if (group === undefined || group.kind === "solo" || botId !== HANDOFF_SCRIPT.fromBotId) return;
  const toBotId = group.botIds.find((id) => id === HANDOFF_SCRIPT.toBotId);
  if (toBotId === undefined) return;
  // 演一次就够。再 @ 一次小服不该又长出一张卡，不然角标是几全看用例发过几条消息。
  if ([...handoffs.values()].some((h) => h.groupId === groupId)) return;

  const handoff = pendingHandoff(groupId, botId, toBotId);
  handoffs.set(handoff.id, handoff);
  // 先推 handoff_updated 再推那条消息：卡的状态只在 Handoff 上，消息先到的话前端只能先画一张查不到状态的占位。
  push({ type: "handoff_updated", handoff });
  push({ type: "message", message: appendMessage(groupId, { kind: "handoff", handoffId: handoff.id }) });

  await waitForHandoffAccept(handoff.id);
  if (currentGeneration() !== run) return;
  const accepted = Handoff.parse({ ...handoff, status: "accepted", acceptedAt: new Date().toISOString() });
  handoffs.set(accepted.id, accepted);
  push({ type: "handoff_updated", handoff: accepted });
  // 接手就是换经手人，控制面那边复用 setCurrentBot，mock 这边是同一件事。
  const assigned = assignTask(groupId, toBotId);
  if (assigned !== null) push({ type: "task_updated", task: assigned });
};

export const streamBotReply = async (
  groupId: string,
  botId: BotId,
  prompt: string,
  push: (event: ServerPush) => void,
  onHold?: () => void,
): Promise<void> => {
  // 开跑那一刻就定下在哪台上跑，这一轮中途换了选择也跑完再说。
  const finish = startRunOn(groupId, botId);
  try {
    await replyOn(groupId, botId, prompt, push, finish, onHold);
  } finally {
    finish();
  }
};

const replyOn = async (
  groupId: string,
  botId: BotId,
  prompt: string,
  push: (event: ServerPush) => void,
  finish: () => void,
  onHold: (() => void) | undefined,
): Promise<void> => {
  const run = currentGeneration();
  const abandoned = () => currentGeneration() !== run;
  const needed = approvalFor(prompt);
  const tool = needed?.tool ?? "erp.query";
  const operation = tool.includes(".") ? tool.slice(tool.lastIndexOf(".") + 1) : tool;
  const runId = RunId.parse(`run_${nextSuffix()}`);
  const view = {
    kind: "mcp" as const,
    server: "ERP",
    tool: operation,
    params: [{ key: "请求", value: prompt.slice(0, 12) }],
  };

  await sleep(REPLY_DELAY_MS);
  if (abandoned()) return;
  const call = appendMessage(groupId, {
    kind: "tool_call",
    runId,
    botId,
    tool,
    view,
    status: "running",
    durationMs: null,
  });
  push({ type: "message", message: call });

  let status: ToolCallStatus = "ok";
  let outcome: Approval["status"] = "approved";
  let reply = `收到。${prompt.slice(0, 12)}… 我这就去办。`;
  if (needed === null) {
    await sleep(TOOL_CALL_MS);
    if (abandoned()) return;
  } else {
    const approval = createApproval({ groupId, botId, runId, action: needed.action, view });
    const card = appendMessage(groupId, { kind: "approval", approvalId: approval.id });
    // 先推 approval_updated 再推那条消息：卡的状态只在 Approval 上，消息先到的话前端只能先画一张查不到状态的占位。
    push({ type: "approval_updated", approval });
    push({ type: "message", message: card });
    onHold?.();
    const decision = await waitForDecision(approval.id);
    if (abandoned()) return;
    outcome = approvals.get(approval.id)?.status ?? decision;
    status = decision === "approved" ? "ok" : "blocked";
    reply =
      decision === "approved" ? `好，${prompt.slice(0, 12)}… 已经办了。` : `明白，这一步我放弃了，别的照原样办完。`;
  }

  const settled = rewriteMessage(groupId, call.id, {
    kind: "tool_call",
    runId,
    botId,
    tool,
    view,
    status,
    durationMs: TOOL_CALL_MS,
  });
  push({ type: "message", message: settled });
  if (outcome === "voided") return;

  // 接手的 Bot 干完这一步就把清单勾掉一项，这是它维护任务卡的方式，用户在卡上看到的就是这次运行的结果。
  const ticked = status === "ok" ? tickFirstUndone(groupId, botId) : null;
  if (ticked !== null) push({ type: "task_updated", task: ticked });

  // 这条回复只靠 delta 长出来，整条的 message 一次都不推，逼着前端走「没见过就先占个位」那条路。
  // 占位按经手猜是谁在说，全员轮流答时轮到的不是经手，就像真控制面一样先推空壳，不然话会记到经手头上。
  const draft = appendMessage(groupId, { kind: "bot", botId, text: "", streaming: true });
  const group = groups.get(groupId);
  const guessed = group === undefined || group.kind === "solo" ? botId : tasks.get(group.taskId)?.currentBotId;
  if (guessed !== botId) push({ type: "message", message: draft });
  const parts = chunked(reply, DELTA_COUNT);
  let text = "";
  for (const [index, delta] of parts.entries()) {
    await sleep(DELTA_MS);
    if (abandoned()) return;
    text += delta;
    const done = index === parts.length - 1;
    const { revision } = rewriteMessage(groupId, draft.id, { kind: "bot", botId, text, streaming: !done });
    push({
      type: "message_delta",
      messageId: draft.id,
      groupId: draft.groupId,
      delta,
      done,
      revision,
      visibleTo: null,
    });
  }

  await sleep(DELTA_MS);
  if (abandoned()) return;
  const offer = projectOfferFor(prompt);
  if (offer !== null && botId === offer.botId) push({ type: "message", message: appendMessage(groupId, offer) });
  const cost = appendMessage(groupId, {
    kind: "cost",
    runId: RunId.parse(`run_${nextSuffix()}`),
    steps: 4,
    amount: 0.8,
  });
  finish();
  push({ type: "message", message: cost });

  // 被拦下的那次运行没干成事，没什么可交接的。
  if (status === "ok") await playHandoff(groupId, botId, push);
};
