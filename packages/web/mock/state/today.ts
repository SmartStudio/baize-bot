import {
  Account,
  AccountId,
  Approval,
  ApprovalId,
  BotId,
  BrowserPlatform,
  ComputerId,
  ContentPlan,
  ContentPlanId,
  Draft,
  DraftId,
  type DraftContent,
  GroupId,
  Publication,
  PublicationId,
  RunId,
  TodayResponse,
  type TodayAssistantLine,
  type TodayPendingItem,
} from "@baize/shared";
import { appendMessage } from "./messages.js";
import { hasMembers, metricOf } from "./project-page.js";
import { isDeferredTeamOffer, pendingTeamOffers } from "./team-offers.js";
import {
  accounts,
  approvals,
  at,
  bots,
  drafts,
  groupIdByBotId,
  groups,
  messagesByGroupId,
  nextSuffix,
  plans,
  publications,
  routines,
  tasks,
  user,
} from "./store.js";

export type TodayMode = "full" | "empty" | "performance";

const decidedTime = (plan: ContentPlan) =>
  plan.decidedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(plan.decidedAt);
const laterPlan = (plan: ContentPlan, than: ContentPlan) =>
  decidedTime(plan) > decidedTime(than) || (decidedTime(plan) === decidedTime(than) && plan.id > than.id);

let mode: TodayMode = "full";
const pendingSince = new Map<string, string>();

const groupIdOf = (id: string): GroupId => groups.get(id)?.id ?? GroupId.parse(id);
const botIdOf = (id: string): BotId => bots.get(id)?.id ?? BotId.parse(id);

// 今天页的输入框发给主助理的单 Bot 群。控制面这一期还回 null，mock 先指到 role = assistant 那个 Bot 上，删掉它就回 null。
const assistantGroupIdOf = (): GroupId | null => {
  const groupId = groupIdByBotId.get("bot_assistant");
  return groupId === undefined ? null : groupIdOf(groupId);
};

const assistantLatestOf = (): TodayAssistantLine | null => {
  const groupId = groupIdByBotId.get("bot_assistant");
  const said = (groupId === undefined ? [] : (messagesByGroupId.get(groupId) ?? [])).findLast(
    (message) => message.body.kind === "bot" && !message.body.streaming && message.body.text !== "",
  );
  if (said === undefined || said.body.kind !== "bot") return null;
  // 跟控制面同一个口径：按 UTF-16 码元数到 200，一个码点一个码点地收，不劈开 emoji。
  let text = "";
  for (const point of said.body.text) {
    if (text.length + point.length > 200) break;
    text += point;
  }
  return { text, at: said.createdAt };
};

const accountOf = (
  id: string,
  platform: Account["platform"],
  handle: string,
  tier: Account["tier"],
  where: { computerId: string; login: Account["login"] } = { computerId: "cmp_local", login: "expired" },
): Account =>
  Account.parse({
    id: AccountId.parse(id),
    ownerId: user.id,
    computerId: ComputerId.parse(where.computerId),
    platform,
    handle,
    tier,
    login: where.login,
    loginChangedAt: at(-120),
    lastLoginFailure: null,
    createdAt: at(-120),
  });

const hoursFromNow = (hours: number): string => {
  const date = new Date(Date.now() + hours * 3_600_000);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
};

const draftOf = (input: {
  id: string;
  groupId: string;
  botId: string;
  planId?: string | null;
  accountId: string;
  platform: Draft["platform"];
  title: string;
  text: string;
  status: Draft["status"];
  scheduledAt?: string | null;
  content?: DraftContent;
  failure?: Draft["failure"];
}): Draft =>
  Draft.parse({
    id: DraftId.parse(input.id),
    groupId: groupIdOf(input.groupId),
    botId: botIdOf(input.botId),
    planId: input.planId === undefined || input.planId === null ? null : ContentPlanId.parse(input.planId),
    accountId: AccountId.parse(input.accountId),
    platform: input.platform,
    content: input.content ?? { kind: "post", title: input.title, text: input.text, images: [], github: null },
    scheduledAt: input.scheduledAt === undefined ? null : input.scheduledAt,
    status: input.status,
    edits: [],
    failure: input.failure ?? null,
    createdAt: at(-90),
    decidedAt: input.status === "pending" ? null : at(-50),
  });

const planOf = (input: {
  id: string;
  groupId: string;
  botId: string;
  title: string;
  status: ContentPlan["status"];
  draftIds: string[];
}): ContentPlan =>
  ContentPlan.parse({
    id: ContentPlanId.parse(input.id),
    groupId: groupIdOf(input.groupId),
    botId: botIdOf(input.botId),
    title: input.title,
    status: input.status,
    draftIds: input.draftIds.map((id) => DraftId.parse(id)),
    createdAt: at(-80),
    decidedAt: input.status === "pending" ? null : at(-45),
  });

const approvalOf = (input: { id: string; groupId: string; botId: string; runId: string; text: string }): Approval =>
  Approval.parse({
    id: ApprovalId.parse(input.id),
    groupId: groupIdOf(input.groupId),
    botId: botIdOf(input.botId),
    runId: RunId.parse(input.runId),
    action: "publish",
    target: null,
    view: { kind: "bash", command: input.text, raw: { command: input.text } },
    status: "pending",
    decidedAt: null,
    deadlineAt: null,
    grantId: null,
  });

const POST_URL: Record<Publication["platform"], (key: string) => string> = {
  x: (key) => `https://x.com/baize/status/${key}`,
  xiaohongshu: (key) => `https://www.xiaohongshu.com/explore/${key}`,
  github: (key) => `https://github.com/baize-tech/x3/issues/${key.replace(/\D/g, "") || "1"}`,
};

export const publicationOf = (input: {
  id: string;
  draftId: string;
  groupId: string;
  accountId: string;
  platform?: Publication["platform"];
  publishedAt?: string;
}): Publication =>
  Publication.parse({
    id: PublicationId.parse(input.id),
    draftId: DraftId.parse(input.draftId),
    groupId: groupIdOf(input.groupId),
    accountId: AccountId.parse(input.accountId),
    platform: input.platform ?? "x",
    url: POST_URL[input.platform ?? "x"](input.id.replace("pub_", "")),
    publishedAt: input.publishedAt ?? at(-30),
  });

const putPending = (item: Approval | ContentPlan | Draft | Account, since: string): void => {
  pendingSince.set(item.id, since);
  if ("action" in item) approvals.set(item.id, item);
  else if ("draftIds" in item) plans.set(item.id, item);
  else if ("content" in item) drafts.set(item.id, item);
  else accounts.set(item.id, item);
};

const seedFull = (): void => {
  const accountX = accountOf("acc_today_x", "x", "@baize_x3", "confirm_publish");
  const accountXhs = accountOf("acc_today_xhs", "xiaohongshu", "要务机械星球", "draft");
  putPending(accountX, at(-70));
  putPending(accountXhs, at(-60));

  const accountGithub = accountOf("acc_today_github", "github", "baize-tech", "confirm_publish", {
    computerId: "cmp_remote",
    login: "valid",
  });
  const accountDiary = accountOf("acc_today_diary", "xiaohongshu", "白泽工厂日记", "confirm_publish", {
    computerId: "cmp_remote",
    login: "valid",
  });
  accounts.set(accountGithub.id, accountGithub);
  accounts.set(accountDiary.id, accountDiary);

  // 故意不按排期顺序登记，卡片自己按 scheduledAt 排。
  const weekly = [
    {
      id: "draft_today_plan_3",
      account: accountGithub,
      hours: 50,
      title: "X3 v1.2 更新说明",
      text: "X3 v1.2 发布：排产看板支持按产线筛选，交期预估误差降到半天以内。",
      github: { repo: "baize-tech/x3", as: "discussion" as const },
    },
    {
      id: "draft_today_plan_1",
      account: accountX,
      hours: 20,
      title: "X3 上线苏州工厂",
      text: "X3 这周在苏州工厂上线，第一天就把排产会从两小时缩到二十分钟。",
      github: null,
    },
    {
      id: "draft_today_plan_5",
      account: accountDiary,
      hours: 98,
      title: "车间主任的一周",
      text: "跟着车间主任过了一周：早会、巡线、对交期，哪些事交给 X3 了。",
      github: null,
    },
    {
      id: "draft_today_plan_2",
      account: accountDiary,
      hours: 30,
      title: "X3 排产看板上手笔记",
      text: "三张图看懂 X3 排产看板：订单、产线、交期一屏对齐。",
      github: null,
    },
    {
      id: "draft_today_plan_4",
      account: accountX,
      hours: 74,
      title: "客户问答合集",
      text: "这周客户问得最多的三个问题：能不能接飞书、数据放哪、多久能上线。",
      github: null,
    },
  ];
  for (const item of weekly) {
    const draft = draftOf({
      id: item.id,
      groupId: "grp_assistant",
      botId: "bot_assistant",
      planId: "plan_today_content",
      accountId: item.account.id,
      platform: item.account.platform,
      title: item.title,
      text: item.text,
      status: "pending",
      scheduledAt: hoursFromNow(item.hours),
      content: { kind: "post", title: item.title, text: item.text, images: [], github: item.github },
    });
    drafts.set(draft.id, draft);
  }
  const weeklyPlan = planOf({
    id: "plan_today_content",
    groupId: "grp_assistant",
    botId: "bot_assistant",
    title: "本周推广计划",
    status: "pending",
    draftIds: weekly.map((item) => item.id),
  });
  putPending(weeklyPlan, at(-95));
  appendMessage(weeklyPlan.groupId, { kind: "plan", planId: weeklyPlan.id });

  // 这一张留在小采的群里，首页的「去群里看」得进它自己的群，不能都进主助理。
  const review = draftOf({
    id: "draft_today_review",
    groupId: "grp_buy",
    botId: "bot_buy",
    accountId: accountXhs.id,
    platform: "xiaohongshu",
    title: "X3 现货比价清单",
    text: "三家供应商的现货、到货和报价差异已经整理好。",
    status: "pending",
  });
  putPending(review, at(-90));
  appendMessage(review.groupId, { kind: "draft", draftId: review.id });

  const failed = draftOf({
    id: "draft_today_failed",
    groupId: "grp_buy",
    botId: "bot_buy",
    accountId: accountX.id,
    platform: "x",
    title: "X3 交期答疑",
    text: "X3 交期答疑：现货两天发出，定制款三周。",
    status: "failed",
    failure: "login_expired",
  });
  drafts.set(failed.id, failed);
  appendMessage(failed.groupId, { kind: "draft", draftId: failed.id });

  const paused = draftOf({
    id: "draft_today_paused",
    groupId: "grp_buy",
    botId: "bot_buy",
    accountId: accountX.id,
    platform: "x",
    title: "X3 暂停后答疑",
    text: "X3 暂停后答疑：恢复 Bot 后让它再起一稿。",
    status: "failed",
    failure: "paused",
  });
  drafts.set(paused.id, paused);
  appendMessage(paused.groupId, { kind: "draft", draftId: paused.id });

  const replyText = "能接。飞书的审批和群消息都能进白泽，私信我发你接入文档。";
  const reply = draftOf({
    id: "draft_today_reply",
    groupId: "grp_assistant",
    botId: "bot_assistant",
    accountId: accountDiary.id,
    platform: "xiaohongshu",
    title: replyText,
    text: replyText,
    status: "pending",
    content: {
      kind: "reply",
      text: replyText,
      images: [],
      replyTo: {
        url: "https://www.xiaohongshu.com/explore/x3-launch",
        author: "阿杰的车间",
        quote: "这个能接飞书吗？我们厂里审批都在飞书上。",
      },
    },
  });
  putPending(reply, at(-85));
  appendMessage(reply.groupId, { kind: "draft", draftId: reply.id });

  putPending(
    approvalOf({
      id: "apr_today_publish",
      groupId: "grp_today",
      botId: "bot_sales",
      runId: "run_today_publish",
      text: "发送 Globex X3 报价确认邮件",
    }),
    at(-100),
  );

  const runningDraft = draftOf({
    id: "draft_today_digest",
    groupId: "grp_service",
    botId: "bot_service",
    planId: "plan_today_digest",
    accountId: accountX.id,
    platform: "x",
    title: "本周客户问题处理小结",
    text: "本周完成 14 张工单，重点跟进 Globex 的交期确认。",
    status: "publishing",
  });
  drafts.set(runningDraft.id, runningDraft);
  const runningPlan = planOf({
    id: "plan_today_digest",
    groupId: "grp_service",
    botId: "bot_service",
    title: "客户服务周报整理",
    status: "approved",
    draftIds: [runningDraft.id],
  });
  plans.set(runningPlan.id, runningPlan);

  const nextDraft = draftOf({
    id: "draft_today_next",
    groupId: "grp_buy",
    botId: "bot_buy",
    accountId: accountXhs.id,
    platform: "xiaohongshu",
    title: "X3 现货交付提醒",
    text: "明早提醒客户确认首批交付数量。",
    status: "approved",
    scheduledAt: at(60 * 24),
  });
  drafts.set(nextDraft.id, nextDraft);

  const publishedDraft = draftOf({
    id: "draft_today_done",
    groupId: "grp_service",
    botId: "bot_service",
    accountId: accountX.id,
    platform: "x",
    title: "14 张客户工单已经处理完",
    text: "本周客户工单处理结果。",
    status: "published",
  });
  drafts.set(publishedDraft.id, publishedDraft);
  const publication = publicationOf({
    id: "pub_today_1",
    draftId: publishedDraft.id,
    groupId: "grp_service",
    accountId: accountX.id,
  });
  publications.set(publication.id, publication);
};

const seedPerformance = (): void => {
  for (let index = 0; index < 5; index += 1) {
    const suffix = index + 1;
    const account = accountOf(`acc_perf_${suffix}`, "x", `@baize_demo_${suffix}`, "confirm_publish");
    putPending(account, at(-100 + index));
    putPending(
      approvalOf({
        id: `apr_perf_${suffix}`,
        groupId: index % 2 === 0 ? "grp_service" : "grp_sales",
        botId: index % 2 === 0 ? "bot_service" : "bot_sales",
        runId: `run_perf_${suffix}`,
        text: `发布第 ${suffix} 条客户进展消息`,
      }),
      at(-120 + index),
    );

    const planDraft = draftOf({
      id: `draft_perf_plan_${suffix}`,
      groupId: "grp_sales",
      botId: "bot_sales",
      planId: `plan_perf_pending_${suffix}`,
      accountId: account.id,
      platform: "x",
      title: `待确认计划稿 ${suffix}`,
      text: `第 ${suffix} 条计划稿。`,
      status: "pending",
    });
    drafts.set(planDraft.id, planDraft);
    putPending(
      planOf({
        id: `plan_perf_pending_${suffix}`,
        groupId: "grp_sales",
        botId: "bot_sales",
        title: `待确认内容计划 ${suffix}`,
        status: "pending",
        draftIds: [planDraft.id],
      }),
      at(-110 + index),
    );
    putPending(
      draftOf({
        id: `draft_perf_pending_${suffix}`,
        groupId: "grp_sales",
        botId: "bot_sales",
        accountId: account.id,
        platform: "x",
        title: `待确认内容 ${suffix}`,
        text: `待确认的客户动态 ${suffix}。`,
        status: "pending",
      }),
      at(-105 + index),
    );
  }

  for (let index = 0; index < 10; index += 1) {
    const suffix = index + 1;
    const accountId = `acc_perf_${(index % 5) + 1}`;
    const doneDraft = draftOf({
      id: `draft_perf_done_${suffix}`,
      groupId: index % 2 === 0 ? "grp_sales" : "grp_service",
      botId: index % 2 === 0 ? "bot_sales" : "bot_service",
      accountId,
      platform: "x",
      title: `已发布客户进展 ${suffix}`,
      text: `第 ${suffix} 条已经发布。`,
      status: "published",
    });
    drafts.set(doneDraft.id, doneDraft);
    const publication = publicationOf({
      id: `pub_perf_${suffix}`,
      draftId: doneDraft.id,
      groupId: doneDraft.groupId,
      accountId,
      publishedAt: at(-30 - index),
    });
    publications.set(publication.id, publication);

    const runningDraft = draftOf({
      id: `draft_perf_running_${suffix}`,
      groupId: "grp_service",
      botId: "bot_service",
      planId: `plan_perf_running_${suffix}`,
      accountId,
      platform: "x",
      title: `正在发布的工单总结 ${suffix}`,
      text: `第 ${suffix} 份工单总结。`,
      status: index % 2 === 0 ? "published" : "publishing",
    });
    drafts.set(runningDraft.id, runningDraft);
    const runningPlan = planOf({
      id: `plan_perf_running_${suffix}`,
      groupId: "grp_service",
      botId: "bot_service",
      title: `正在整理的客户周报 ${suffix}`,
      status: "approved",
      draftIds: [runningDraft.id],
    });
    plans.set(runningPlan.id, runningPlan);

    const nextDraft = draftOf({
      id: `draft_perf_next_${suffix}`,
      groupId: "grp_buy",
      botId: "bot_buy",
      accountId,
      platform: "x",
      title: `下一步选题 ${suffix}`,
      text: `下一步安排 ${suffix}。`,
      status: "approved",
      scheduledAt: at(60 * suffix),
    });
    drafts.set(nextDraft.id, nextDraft);
  }
};

const seeded = (id: string): boolean => id.includes("_today_") || id.includes("_perf_");

const removeTodayData = (): void => {
  for (const store of [approvals, drafts, plans, accounts, publications]) {
    for (const id of store.keys()) {
      if (seeded(id)) store.delete(id);
    }
  }
  for (const [groupId, list] of messagesByGroupId) {
    messagesByGroupId.set(
      groupId,
      list.filter(
        ({ body }) =>
          !(body.kind === "draft" && seeded(body.draftId)) && !(body.kind === "plan" && seeded(body.planId)),
      ),
    );
  }
  pendingSince.clear();
};

export const setTodayMode = (next: TodayMode): void => {
  mode = next;
  removeTodayData();
  if (next === "full") seedFull();
  if (next === "performance") seedPerformance();
};

export const resetToday = (): void => setTodayMode("full");

const titleOf = (draft: Draft): string =>
  draft.content.kind === "post"
    ? (draft.content.title ?? draft.content.text.slice(0, 80))
    : `回复 ${draft.content.replyTo.author}`;

// 跟控制面同一个口径：过期的号恒成一行；没登录的浏览器平台占位只在有待办等着它时成一行，从最早那件待办算起。
export const pendingOf = (): TodayPendingItem[] => {
  const items: TodayPendingItem[] = [];
  const waitingSince = new Map<string, string>();
  const waitOn = (draft: Draft, since: string) => {
    if (draft.status !== "pending") return;
    const current = waitingSince.get(draft.accountId);
    if (current === undefined || since < current) waitingSince.set(draft.accountId, since);
  };
  for (const approval of approvals.values()) {
    if (approval.status === "pending") {
      items.push({ kind: "approval", since: pendingSince.get(approval.id) ?? at(-1), approval });
    }
  }
  for (const plan of plans.values()) {
    if (plan.status !== "pending") continue;
    const since = pendingSince.get(plan.id) ?? plan.createdAt;
    const planDrafts = plan.draftIds.flatMap((id) => {
      const draft = drafts.get(id);
      return draft === undefined ? [] : [draft];
    });
    for (const draft of planDrafts) waitOn(draft, since);
    items.push({ kind: "plan", since, plan, drafts: planDrafts });
  }
  for (const draft of drafts.values()) {
    if (draft.status !== "pending") continue;
    if (draft.planId !== null && plans.get(draft.planId)?.status === "pending") continue;
    const since = pendingSince.get(draft.id) ?? draft.createdAt;
    waitOn(draft, since);
    items.push({ kind: "draft", since, draft });
  }
  for (const messages of messagesByGroupId.values()) {
    for (const message of messages) {
      if (message.body.kind === "routine_offer" && message.body.status === "offered") {
        items.push({ kind: "routine_offer", since: message.createdAt, message });
      }
    }
  }
  for (const account of accounts.values()) {
    if (account.login === "expired") {
      items.push({ kind: "account", since: pendingSince.get(account.id) ?? account.createdAt, account });
    }
    const waiting = waitingSince.get(account.id);
    if (account.login === "none" && BrowserPlatform.safeParse(account.platform).success && waiting !== undefined) {
      items.push({ kind: "account", since: waiting, account });
    }
  }
  items.push(...pendingTeamOffers());
  const rank = (item: TodayPendingItem) => (item.kind === "account" ? 0 : 1);
  // 先放着的建队卡还在，只是排到别的待办后面。
  const behind = (item: TodayPendingItem) => Number(isDeferredTeamOffer(item));
  return items.sort(
    (left, right) => behind(left) - behind(right) || left.since.localeCompare(right.since) || rank(left) - rank(right),
  );
};

export const todayOf = (): TodayResponse => {
  if (mode === "empty") {
    return TodayResponse.parse({
      assistantGroupId: null,
      assistantLatest: null,
      pending: [],
      done: [],
      running: [],
      next: [],
    });
  }

  const done: TodayResponse["done"] = [...publications.values()].map((publication) => {
    const draft = publication.draftId === null ? undefined : drafts.get(publication.draftId);
    return {
      kind: "publication",
      at: publication.publishedAt,
      groupId: publication.groupId,
      title: draft === undefined ? "成果已发布" : titleOf(draft),
      platform: publication.platform,
      url: publication.url,
    };
  });
  if (mode === "full") {
    for (const plan of plans.values()) {
      if (plan.status === "approved" && plan.decidedAt !== null) {
        done.push({
          kind: "plan_approved",
          at: plan.decidedAt,
          groupId: plan.groupId,
          title: plan.title,
          draftCount: plan.draftIds.length,
        });
      }
    }
    for (const routine of routines.values()) {
      const run = routine.runs.find((item) => item.status === "ok");
      if (run !== undefined) {
        done.push({
          kind: "routine",
          at: run.startedAt,
          groupId: routine.groupId,
          title: routine.name,
          note: run.note,
        });
      }
    }
  }
  done.sort((left, right) => right.at.localeCompare(left.at));

  // 照控制面 repo/today.ts：每个群只看最新一份已批计划（decidedAt，同刻比 id）。进「在进行」只有一道门，
  // 任务卡 active、群里还有成员；有目标的多 Bot 群恒出一行，没目标的只在最新计划还有稿子没发时出一行。
  const latestPlans = new Map<string, ContentPlan>();
  for (const plan of plans.values()) {
    if (plan.status !== "approved") continue;
    const current = latestPlans.get(plan.groupId);
    if (current === undefined || laterPlan(plan, current)) latestPlans.set(plan.groupId, plan);
  }
  const now = new Date();
  const running = [...groups.values()]
    .flatMap((group): { at: string; id: string; item: TodayResponse["running"][number] }[] => {
      const task = tasks.get(group.taskId);
      // mock 只给多 Bot 群存任务卡，单聊没有卡，当它进行中。
      if ((task !== undefined && task.status !== "active") || !hasMembers(group)) return [];
      const plan = latestPlans.get(group.id);
      const planDrafts = plan?.draftIds ?? [];
      const published = planDrafts.filter((id) => drafts.get(id)?.status === "published").length;
      const counts = { published, planned: planDrafts.length };
      if (group.kind === "team" && task !== undefined && task.goal !== null) {
        return [
          {
            at: plan?.decidedAt ?? group.createdAt,
            id: plan?.id ?? task.id,
            item: { groupId: group.id, title: task.title, ...counts, goal: task.goal, metric: metricOf(group.id, now) },
          },
        ];
      }
      if (plan === undefined || published === planDrafts.length) return [];
      return [
        {
          at: plan.decidedAt ?? plan.createdAt,
          id: plan.id,
          item: { groupId: group.id, title: plan.title, ...counts, goal: null, metric: null },
        },
      ];
    })
    .toSorted((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
    .slice(0, 20)
    .map(({ item }) => item);

  const next: TodayResponse["next"] = [...drafts.values()]
    .filter((draft) => draft.status === "approved" && draft.scheduledAt !== null)
    .map((draft) => ({ kind: "draft" as const, at: draft.scheduledAt ?? draft.createdAt, draft }));
  if (mode === "full") {
    for (const routine of routines.values()) {
      if (routine.state === "on") {
        next.push({
          kind: "routine",
          at: at(60 * 24),
          routineId: routine.id,
          groupId: routine.groupId,
          botId: routine.botId,
          title: routine.name,
        });
      }
    }
  }
  next.sort((left, right) => left.at.localeCompare(right.at));

  return TodayResponse.parse({
    assistantGroupId: assistantGroupIdOf(),
    assistantLatest: assistantLatestOf(),
    pending: pendingOf(),
    done,
    running,
    next,
  });
};

export const addTodayApproval = (title: string): Approval => {
  const suffix = nextSuffix();
  const approval = approvalOf({
    id: `apr_today_dynamic_${suffix}`,
    groupId: "grp_sales",
    botId: "bot_sales",
    runId: `run_today_dynamic_${suffix}`,
    text: title,
  });
  putPending(approval, new Date().toISOString());
  appendMessage(approval.groupId, { kind: "approval", approvalId: approval.id });
  return approval;
};

// 项目页用例的数据：Globex 订单群里三条发布记录（小红书那条读不到笔记 id，只有管理页链接）和一张待批稿子。
// id 都带 _today_，重置时跟首页数据一起清掉；默认 seed 不放，首页的计数不受影响。
export const seedProjectPage = (): Draft => {
  const accountX = accountOf("acc_today_proj_x", "x", "@globex_x3", "confirm_publish", {
    computerId: "cmp_remote",
    login: "valid",
  });
  const accountXhs = accountOf("acc_today_proj_xhs", "xiaohongshu", "X3 工厂日记", "confirm_publish", {
    computerId: "cmp_local",
    login: "valid",
  });
  const accountGithub = accountOf("acc_today_proj_github", "github", "globex", "confirm_publish", {
    computerId: "cmp_remote",
    login: "valid",
  });
  for (const account of [accountX, accountXhs, accountGithub]) accounts.set(account.id, account);
  const shipped = [
    { key: "x", account: accountX, title: "X3 × 200 台签约", url: "https://x.com/globex/status/1", minutes: -300 },
    {
      key: "github",
      account: accountGithub,
      title: "X3 交付节奏公开",
      url: "https://github.com/globex/x3/issues/200",
      minutes: -200,
    },
    {
      key: "xhs",
      account: accountXhs,
      title: "三张图看懂 X3 交期",
      url: "https://creator.xiaohongshu.com/new/note-manager",
      minutes: -100,
    },
  ];
  for (const item of shipped) {
    const draft = draftOf({
      id: `draft_today_proj_${item.key}`,
      groupId: "grp_order",
      botId: "bot_sales",
      accountId: item.account.id,
      platform: item.account.platform,
      title: item.title,
      text: `${item.title}的正文`,
      status: "published",
    });
    drafts.set(draft.id, draft);
    const publication = Publication.parse({
      id: PublicationId.parse(`pub_today_proj_${item.key}`),
      draftId: draft.id,
      groupId: draft.groupId,
      accountId: item.account.id,
      platform: item.account.platform,
      url: item.url,
      publishedAt: new Date(Date.now() + item.minutes * 60_000).toISOString(),
    });
    publications.set(publication.id, publication);
  }
  const pending = draftOf({
    id: "draft_today_proj_pending",
    groupId: "grp_order",
    botId: "bot_sales",
    accountId: accountX.id,
    platform: "x",
    title: "Globex 交期答疑",
    text: "200 台 X3 分三批交付，第一批下周发出。",
    status: "pending",
  });
  putPending(pending, new Date().toISOString());
  appendMessage(pending.groupId, { kind: "draft", draftId: pending.id });
  return pending;
};

// 登录卡用例的数据：本机一个还没登录的小红书占位号，主助理给它写好一条待确认的稿子。slot 2 再造一对，两个号同时登录的用例用。
export const seedLoginCard = (slot: 1 | 2 = 1): { account: Account; draft: Draft } => {
  const suffix = slot === 1 ? "" : "2";
  const account = accountOf(`acc_today_login${suffix}`, "xiaohongshu", "占位", "confirm_publish", {
    computerId: "cmp_local",
    login: "none",
  });
  const placeholder = Account.parse({ ...account, handle: null });
  accounts.set(placeholder.id, placeholder);
  const draft = draftOf({
    id: `draft_today_login${suffix}`,
    groupId: "grp_assistant",
    botId: "bot_assistant",
    accountId: placeholder.id,
    platform: "xiaohongshu",
    title: slot === 1 ? "车间主任的一天" : "质检员的一天",
    text: "早会、巡线、对交期，车间主任的一天交给 X3 分担了哪些。",
    status: "pending",
  });
  putPending(draft, new Date().toISOString());
  appendMessage(draft.groupId, { kind: "draft", draftId: draft.id });
  return { account: placeholder, draft };
};
