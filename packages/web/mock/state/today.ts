import {
  Account,
  AccountId,
  Approval,
  ApprovalId,
  BotId,
  ComputerId,
  ContentPlan,
  ContentPlanId,
  Draft,
  DraftId,
  GroupId,
  Publication,
  PublicationId,
  RunId,
  TodayResponse,
  type TodayPendingItem,
} from "@baize/shared";
import { appendMessage } from "./messages.js";
import {
  accounts,
  approvals,
  at,
  bots,
  drafts,
  groups,
  nextSuffix,
  plans,
  publications,
  routines,
  user,
} from "./store.js";

export type TodayMode = "full" | "empty" | "performance";

let mode: TodayMode = "full";
const pendingSince = new Map<string, string>();

const groupIdOf = (id: string): GroupId => groups.get(id)?.id ?? GroupId.parse(id);
const botIdOf = (id: string): BotId => bots.get(id)?.id ?? BotId.parse(id);

const accountOf = (id: string, platform: Account["platform"], handle: string, tier: Account["tier"]): Account =>
  Account.parse({
    id: AccountId.parse(id),
    ownerId: user.id,
    computerId: ComputerId.parse("cmp_local"),
    platform,
    handle,
    tier,
    login: "expired",
    createdAt: at(-120),
  });

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
}): Draft =>
  Draft.parse({
    id: DraftId.parse(input.id),
    groupId: groupIdOf(input.groupId),
    botId: botIdOf(input.botId),
    planId: input.planId === undefined || input.planId === null ? null : ContentPlanId.parse(input.planId),
    accountId: AccountId.parse(input.accountId),
    platform: input.platform,
    content: { kind: "post", title: input.title, text: input.text, images: [], github: null },
    scheduledAt: input.scheduledAt === undefined ? null : input.scheduledAt,
    status: input.status,
    edits: [],
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
    grantId: null,
  });

const publicationOf = (input: {
  id: string;
  draftId: string;
  groupId: string;
  accountId: string;
  publishedAt?: string;
}): Publication =>
  Publication.parse({
    id: PublicationId.parse(input.id),
    draftId: DraftId.parse(input.draftId),
    groupId: groupIdOf(input.groupId),
    accountId: AccountId.parse(input.accountId),
    platform: "x",
    url: `https://x.com/baize/status/${input.id.replace("pub_", "")}`,
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

  const planDraft = draftOf({
    id: "draft_today_content",
    groupId: "grp_sales",
    botId: "bot_sales",
    planId: "plan_today_content",
    accountId: accountX.id,
    platform: "x",
    title: "X3 交付进度：从排产到现场",
    text: "记录一台 X3 从确认订单到交付现场的真实协作过程。",
    status: "pending",
  });
  drafts.set(planDraft.id, planDraft);
  putPending(
    planOf({
      id: "plan_today_content",
      groupId: "grp_sales",
      botId: "bot_sales",
      title: "本周 X3 客户案例连载",
      status: "pending",
      draftIds: [planDraft.id],
    }),
    at(-95),
  );

  putPending(
    draftOf({
      id: "draft_today_review",
      groupId: "grp_buy",
      botId: "bot_buy",
      accountId: accountXhs.id,
      platform: "xiaohongshu",
      title: "X3 现货比价清单",
      text: "三家供应商的现货、到货和报价差异已经整理好。",
      status: "pending",
    }),
    at(-90),
  );

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

const removeTodayData = (): void => {
  for (const store of [approvals, drafts, plans, accounts, publications]) {
    for (const id of store.keys()) {
      if (id.includes("_today_") || id.includes("_perf_")) store.delete(id);
    }
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

const pendingOf = (): TodayPendingItem[] => {
  const items: TodayPendingItem[] = [];
  for (const approval of approvals.values()) {
    if (approval.status === "pending") {
      items.push({ kind: "approval", since: pendingSince.get(approval.id) ?? at(-1), approval });
    }
  }
  for (const plan of plans.values()) {
    if (plan.status !== "pending") continue;
    items.push({
      kind: "plan",
      since: pendingSince.get(plan.id) ?? plan.createdAt,
      plan,
      drafts: plan.draftIds.flatMap((id) => {
        const draft = drafts.get(id);
        return draft === undefined ? [] : [draft];
      }),
    });
  }
  for (const draft of drafts.values()) {
    if (draft.status !== "pending") continue;
    if (draft.planId !== null && plans.get(draft.planId)?.status === "pending") continue;
    items.push({ kind: "draft", since: pendingSince.get(draft.id) ?? draft.createdAt, draft });
  }
  for (const account of accounts.values()) {
    if (account.login === "expired") {
      items.push({ kind: "account", since: pendingSince.get(account.id) ?? account.createdAt, account });
    }
  }
  return items.sort((left, right) => left.since.localeCompare(right.since));
};

export const todayOf = (): TodayResponse => {
  if (mode === "empty") {
    return TodayResponse.parse({ assistantGroupId: null, pending: [], done: [], running: [], next: [] });
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

  const running: TodayResponse["running"] = [...plans.values()]
    .filter((plan) => plan.status === "approved")
    .map((plan) => ({
      groupId: plan.groupId,
      title: plan.title,
      published: plan.draftIds.filter((id) => drafts.get(id)?.status === "published").length,
      planned: plan.draftIds.length,
    }));

  const next: TodayResponse["next"] = [...drafts.values()]
    .filter((draft) => draft.status === "approved" && draft.scheduledAt !== null)
    .map((draft) => ({ kind: "draft" as const, at: draft.scheduledAt ?? draft.createdAt, draft }));
  if (mode === "full") {
    for (const routine of routines.values()) {
      if (routine.enabled) {
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
    assistantGroupId: groupIdOf("grp_service"),
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
