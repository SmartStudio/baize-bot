import {
  AccountId,
  ActionKind,
  Bot,
  BotId,
  ComputerStatus,
  Group,
  GroupId,
  GrantTarget,
  LoginAttemptId,
  MessageBody,
  MessageId,
  Notice,
  Timestamp,
  ServerPush,
  RunId,
} from "@baize/shared";
import { z } from "zod";
import {
  confirmNextHandoff,
  addTodayApproval,
  bots,
  appendMessage,
  computerStatus,
  computersOf,
  removedComputers,
  LoginState,
  messageFetchFaults,
  reportLoginState,
  seedLoginCard,
  createApproval,
  expireLatestPending,
  timeOutLatestPending,
  groups,
  holdHandoffAccept,
  publishDraft,
  removeBot,
  reseed,
  seedManyPreferences,
  restoreAssistant,
  resetToday,
  seedProjectGoal,
  seedProjectPage,
  reviseDraft,
  seedUnseenHandoff,
  setTodayMode,
  settleUnseenHandoff,
} from "../state.js";
import { resetRegisteredEmails } from "./auth.js";
import { resetLive } from "./live.js";
import { readBody, send, type Route } from "./http.js";

const GroupUpdateTrigger = z.object({ groupId: GroupId, chiefBotId: BotId.nullable() });
const TodayModeRequest = z.object({ mode: z.enum(["full", "empty", "performance"]) }).strict();
const LoginCardRequest = z.object({ slot: z.union([z.literal(1), z.literal(2)]).default(1) }).strict();
const TodayPendingRequest = z.object({ title: z.string().min(1).max(80) }).strict();
const TestReviseRequest = z.object({ text: z.string().min(1) }).strict();
const TestApprovalRequest = z
  .object({
    action: ActionKind,
    groupId: GroupId.default("grp_sales"),
    target: GrantTarget.nullable().optional(),
    deadlineAt: Timestamp.nullable().optional(),
  })
  .strict();
const TestMessageRequest = z
  .object({
    groupId: GroupId,
    text: z.string().min(1),
    botId: BotId.optional(),
    createdAt: Timestamp.optional(),
    id: MessageId.optional(),
    silent: z.boolean().optional(),
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();
const PreferenceOfferRequest = z
  .object({ groupId: GroupId, botId: BotId, text: z.string().min(1).max(200), private: z.boolean() })
  .strict();
const MessageFetchFaultRequest = z.object({ messageId: MessageId, count: z.number().int().min(0).max(10) }).strict();
const TestDeltaRequest = z
  .object({
    groupId: GroupId,
    messageId: MessageId,
    delta: z.string().min(1),
    done: z.boolean(),
    revision: z.number().int().positive().default(1),
  })
  .strict();
const LegacyDescriptionRequest = z.object({ botId: BotId, description: z.string() }).strict();
const ManyPreferencesRequest = z.object({ botId: BotId, count: z.number().int().min(1).max(100) }).strict();
const ComputerStatusRequest = z.object({ status: ComputerStatus }).strict();
const activeTurns = new Map<GroupId, Extract<ServerPush, { type: "group_turn" }>>();
const turnEpochs = new Map<GroupId, number>();

export const currentTurns = (): Iterable<Extract<ServerPush, { type: "group_turn" }>> => activeTurns.values();

export const testRoutes: Route = async ({ req, res, path, method, push }) => {
  if (method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true });
    return true;
  }

  if (method === "POST" && path === "/api/test/reset") {
    reseed();
    resetToday();
    resetRegisteredEmails();
    resetLive();
    activeTurns.clear();
    turnEpochs.clear();
    send(res, 204);
    return true;
  }

  // 写入上限收紧之前存下的长描述，PATCH 造不出来，只能从这里直接种。
  if (method === "POST" && path === "/api/test/bot-description") {
    const parsed = LegacyDescriptionRequest.safeParse(await readBody(req));
    const bot = parsed.success ? bots.get(parsed.data.botId) : undefined;
    if (!parsed.success || bot === undefined) send(res, 400, { error: "要种描述的 Bot 不对" });
    else {
      const next = Bot.parse({ ...bot, description: parsed.data.description });
      bots.set(next.id, next);
      push({ type: "bot_updated", bot: next });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/preferences") {
    const parsed = ManyPreferencesRequest.safeParse(await readBody(req));
    if (!parsed.success || !bots.has(parsed.data.botId)) send(res, 400, { error: "要种偏好的 Bot 不对" });
    else {
      seedManyPreferences(parsed.data.botId, parsed.data.count);
      send(res, 204);
    }
    return true;
  }

  // 控制面不让删主助理，mock 也不让；还没有主助理的账号只能从这里直接造。
  if (method === "POST" && path === "/api/test/without-assistant") {
    removeBot(BotId.parse("bot_assistant"));
    send(res, 204);
    return true;
  }

  // 照控制面电脑 hello 补建主助理：推送依次是 bot_updated、group_created、开场白那条 message。
  if (method === "POST" && path === "/api/test/assistant-hello") {
    const restored = restoreAssistant();
    push({ type: "bot_updated", bot: restored.bot });
    push({ type: "group_created", group: restored.group, task: restored.task });
    push({ type: "message", message: restored.greeting });
    send(res, 204);
    return true;
  }

  if (method === "POST" && path === "/api/test/today") {
    const parsed = TodayModeRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Today 模式不对" });
    else {
      setTodayMode(parsed.data.mode);
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/today/pending") {
    const parsed = TodayPendingRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "Today 待办参数不对" });
    else {
      const approval = addTodayApproval(parsed.data.title);
      push({ type: "approval_updated", approval });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/project") {
    const draft = seedProjectPage();
    push({ type: "draft_updated", draft });
    send(res, 204);
    return true;
  }

  if (method === "POST" && path === "/api/test/project-goal") {
    const task = seedProjectGoal();
    if (task === null) send(res, 404, { error: "没有订单群" });
    else {
      push({ type: "task_updated", task });
      send(res, 204);
    }
    return true;
  }

  const publishMatch = /^\/api\/test\/drafts\/([^/]+)\/publish$/.exec(path);
  if (publishMatch !== null && method === "POST") {
    const outcome = publishDraft(decodeURIComponent(publishMatch[1] ?? ""));
    if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
    else {
      push({ type: "publication_created", publication: outcome.value.publication });
      push({ type: "draft_updated", draft: outcome.value.draft });
      send(res, 204);
    }
    return true;
  }

  const reviseMatch = /^\/api\/test\/drafts\/([^/]+)\/revise$/.exec(path);
  if (reviseMatch !== null && method === "POST") {
    const parsed = TestReviseRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "改稿参数不对" });
    else {
      const outcome = reviseDraft(decodeURIComponent(reviseMatch[1] ?? ""), parsed.data.text);
      if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
      else {
        push({ type: "draft_updated", draft: outcome.value });
        send(res, 204);
      }
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/approval") {
    const parsed = TestApprovalRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "审批参数不对" });
    else {
      const approval = createApproval({
        groupId: parsed.data.groupId,
        botId: BotId.parse("bot_sales"),
        runId: RunId.parse(`run_test_${Date.now()}`),
        action: parsed.data.action,
        target: parsed.data.target ?? null,
        deadlineAt: parsed.data.deadlineAt ?? null,
        view: { kind: "bash", command: "示例调用", raw: { command: "示例调用" } },
      });
      const message = appendMessage(approval.groupId, { kind: "approval", approvalId: approval.id });
      push({ type: "approval_updated", approval });
      push({ type: "message", message });
      send(res, 201, { approval });
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/messages") {
    const parsed = TestMessageRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "消息参数不对" });
    else {
      const { groupId, text, botId, createdAt, id, silent, revision } = parsed.data;
      const body: MessageBody =
        botId === undefined ? { kind: "user", text } : { kind: "bot", botId, text, streaming: false };
      const message = appendMessage(groupId, body, { createdAt, id, revision });
      // silent 只落 mock 状态不推送，这条消息页面只能从重拉的历史里读到。
      if (silent !== true) push({ type: "message", message });
      send(res, 204);
    }
    return true;
  }

  // 只推 delta，不落 mock 状态，用来造「没收到空壳就先来了 delta」。
  // 真运行器会按 Bot 判断出私人偏好，mock 的 learnFrom 只出非私人的卡，要看「私人」那句提示从这里直接造。
  if (method === "POST" && path === "/api/test/preference-offer") {
    const parsed = PreferenceOfferRequest.safeParse(await readBody(req));
    if (!parsed.success || !groups.has(parsed.data.groupId) || !bots.has(parsed.data.botId)) {
      send(res, 400, { error: "要出的偏好卡不对" });
    } else {
      const message = appendMessage(parsed.data.groupId, {
        kind: "preference_offer",
        botId: parsed.data.botId,
        text: parsed.data.text,
        private: parsed.data.private,
        sourceMessageId: null,
        status: "offered",
        preferenceId: null,
      });
      push({ type: "message", message });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/message-delta") {
    const parsed = TestDeltaRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "delta 参数不对" });
    else {
      push({ type: "message_delta", ...parsed.data, visibleTo: null });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/message-fetch-failures") {
    const parsed = MessageFetchFaultRequest.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "失败次数参数不对" });
    else {
      messageFetchFaults.set(parsed.data.messageId, parsed.data.count);
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/accounts/login-card") {
    const parsed = LoginCardRequest.safeParse(await readBody(req));
    const { account, draft } = seedLoginCard(parsed.success ? parsed.data.slot : 1);
    push({ type: "account_updated", account });
    push({ type: "draft_updated", draft });
    send(res, 200, { accountId: account.id, draftId: draft.id });
    return true;
  }

  // 代替电脑代理报 login_state，推送照控制面：账号变了推 account_updated，没成先推 login_failed 再发 failed 通知。
  const loginStateMatch = /^\/api\/test\/accounts\/([^/]+)\/login-state$/.exec(path);
  if (loginStateMatch !== null && method === "POST") {
    const parsed = LoginState.safeParse(await readBody(req));
    const outcome = parsed.success ? reportLoginState(decodeURIComponent(loginStateMatch[1] ?? ""), parsed.data) : null;
    if (outcome === null) send(res, 400, { error: "登录结果参数不对" });
    else if (!outcome.ok) send(res, outcome.status, { error: outcome.error });
    else {
      if (outcome.value.account !== null) push({ type: "account_updated", account: outcome.value.account });
      if (outcome.value.failed !== null) {
        push({
          type: "login_failed",
          accountId: AccountId.parse(decodeURIComponent(loginStateMatch[1] ?? "")),
          attempt: LoginAttemptId.parse(outcome.value.failed.attempt),
          reason: outcome.value.failed.reason,
        });
      }
      if (outcome.value.notice !== null) {
        const notice = Notice.parse({
          kind: "failed",
          text: outcome.value.notice,
          groupId: null,
          at: new Date().toISOString(),
        });
        push({ type: "notify", notice });
      }
      send(res, 204);
    }
    return true;
  }

  // 摘掉一台电脑，造「只有一台」的场景。不推送：控制面也没有删电脑的推送，网页进账号页时重拉电脑表才看到。
  const computerMatch = /^\/api\/test\/computers\/([^/]+)$/.exec(path);
  if (computerMatch !== null && method === "DELETE") {
    const id = decodeURIComponent(computerMatch[1] ?? "");
    if (computersOf().computers.some((item) => item.id === id)) {
      removedComputers.add(id);
      send(res, 204);
    } else send(res, 404, { error: "没有这台电脑" });
    return true;
  }

  const computerStatusMatch = /^\/api\/test\/computers\/([^/]+)\/status$/.exec(path);
  if (computerStatusMatch !== null && method === "POST") {
    const parsed = ComputerStatusRequest.safeParse(await readBody(req));
    const id = decodeURIComponent(computerStatusMatch[1] ?? "");
    const computer = computersOf().computers.find((item) => item.id === id);
    if (!parsed.success) send(res, 400, { error: "电脑状态参数不对" });
    else if (computer === undefined) send(res, 404, { error: "没有这台电脑" });
    else {
      computerStatus.set(id, parsed.data.status);
      push({
        type: "computer_updated",
        computer: { ...computer, status: parsed.data.status, dispatchable: parsed.data.status === "online" },
      });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/notify") {
    const parsed = Notice.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "通知参数不对" });
    else {
      push({ type: "notify", notice: parsed.data });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/group/updated") {
    const parsed = GroupUpdateTrigger.safeParse(await readBody(req));
    if (!parsed.success) send(res, 400, { error: "群更新参数不对" });
    else {
      const group = groups.get(parsed.data.groupId);
      if (group === undefined) send(res, 404, { error: "没有这个群" });
      else if (parsed.data.chiefBotId !== null && !group.botIds.includes(parsed.data.chiefBotId)) {
        send(res, 400, { error: "首席不在群里" });
      } else {
        const updated = Group.parse({ ...group, chiefBotId: parsed.data.chiefBotId });
        groups.set(updated.id, updated);
        push({ type: "group_updated", group: updated });
        send(res, 204);
      }
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/group/turn") {
    const body = await readBody(req);
    const parsed = ServerPush.safeParse(
      typeof body === "object" && body !== null ? { ...body, type: "group_turn" } : body,
    );
    if (!parsed.success || parsed.data.type !== "group_turn") send(res, 400, { error: "群回合参数不对" });
    else if (!groups.has(parsed.data.groupId)) send(res, 404, { error: "没有这个群" });
    else {
      const turn = parsed.data;
      if (turn.epoch >= (turnEpochs.get(turn.groupId) ?? -1)) {
        turnEpochs.set(turn.groupId, turn.epoch);
        if (turn.current === null && turn.next.length === 0) activeTurns.delete(turn.groupId);
        else activeTurns.set(turn.groupId, turn);
      }
      push(turn);
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/pending") {
    send(res, 201, { handoff: seedUnseenHandoff() });
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/hold") {
    holdHandoffAccept();
    send(res, 204);
    return true;
  }

  if (method === "POST" && path === "/api/test/handoff/accept") {
    if (confirmNextHandoff()) send(res, 204);
    else {
      const accepted = settleUnseenHandoff();
      if (accepted === null) send(res, 404, { error: "没有待确认的交接" });
      else {
        push({ type: "handoff_updated", handoff: accepted });
        send(res, 204);
      }
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/approval/expire") {
    const expired = expireLatestPending();
    if (expired === null) send(res, 409, { error: "没有待失效的审批" });
    else {
      push({ type: "approval_updated", approval: expired });
      send(res, 204);
    }
    return true;
  }

  if (method === "POST" && path === "/api/test/approval/timeout") {
    const timedOut = timeOutLatestPending();
    if (timedOut === null) send(res, 409, { error: "没有待超时的审批" });
    else {
      push({ type: "approval_updated", approval: timedOut });
      send(res, 204);
    }
    return true;
  }

  return false;
};
