import { z } from "zod";
import {
  Account,
  ApprovePlanRequest,
  ComputerListResponse,
  ContentPlan,
  DecideDraftRequest,
  Draft,
  type AccountTier,
  type CreateAccountRequest,
  type DraftContent,
  type Message,
  type Publication,
} from "@baize/shared";
import { accounts, at, drafts, nextSuffix, plans, publications, user } from "./store.js";
import { publicationOf } from "./today.js";

type PlanDecision =
  { decision: "approve"; edits: z.infer<typeof ApprovePlanRequest>["edits"] } | { decision: "return" };

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 404 | 409 | 400; error: string };

const now = (): string => new Date().toISOString();

export const computersOf = () =>
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
  });

// 照控制面：批准时带了新正文，先把这一对记进 edits，再换正文。
const approveDraft = (draft: Draft, content: DraftContent | undefined, decidedAt: string): Draft =>
  Draft.parse({
    ...draft,
    content: content ?? draft.content,
    edits:
      content === undefined || content.text === draft.content.text
        ? draft.edits
        : [...draft.edits, { before: draft.content.text, after: content.text, at: decidedAt }],
    status: "approved",
    decidedAt,
  });

const write = (draft: Draft): Draft => {
  drafts.set(draft.id, draft);
  return draft;
};

export const decideDraft = (id: string, decision: z.infer<typeof DecideDraftRequest>): Outcome<Draft> => {
  const draft = drafts.get(id);
  if (draft === undefined) return { ok: false, status: 404, error: "没有这条草稿" };
  if (draft.status !== "pending") return { ok: false, status: 409, error: "这条草稿已经有结论了" };
  if (decision.decision === "return") {
    return { ok: true, value: write(Draft.parse({ ...draft, status: "returned", decidedAt: now() })) };
  }
  if (decision.content !== undefined && decision.content.kind !== draft.content.kind) {
    return { ok: false, status: 400, error: "不能把帖子改成回复" };
  }
  return { ok: true, value: write(approveDraft(draft, decision.content, now())) };
};

export const settlePlan = (id: string, decision: PlanDecision): Outcome<{ plan: ContentPlan; drafts: Draft[] }> => {
  const plan = plans.get(id);
  if (plan === undefined) return { ok: false, status: 404, error: "没有这份计划" };
  if (plan.status !== "pending") return { ok: false, status: 409, error: "这份计划已经有结论了" };
  const edits = decision.decision === "approve" ? decision.edits : [];
  if (edits.some((edit) => !plan.draftIds.includes(edit.draftId))) {
    return { ok: false, status: 400, error: "改的草稿不在这份计划里" };
  }
  const decidedAt = now();
  const changed = plan.draftIds.flatMap((draftId) => {
    const draft = drafts.get(draftId);
    if (draft === undefined || draft.status !== "pending") return [];
    if (decision.decision === "return") return [write(Draft.parse({ ...draft, status: "returned", decidedAt }))];
    const edit = edits.find((item) => item.draftId === draftId);
    return [write(approveDraft(draft, edit?.content, decidedAt))];
  });
  const next = ContentPlan.parse({
    ...plan,
    status: decision.decision === "approve" ? "approved" : "returned",
    decidedAt,
  });
  plans.set(next.id, next);
  return { ok: true, value: { plan: next, drafts: changed } };
};

export const setAccountTier = (id: string, tier: AccountTier): Outcome<Account> => {
  const account = accounts.get(id);
  if (account === undefined) return { ok: false, status: 404, error: "没有这个账号" };
  if (account.platform === "xiaohongshu" && tier === "direct_publish") {
    return { ok: false, status: 400, error: "小红书账号不能设成可直接发布" };
  }
  const next = Account.parse({ ...account, tier });
  accounts.set(next.id, next);
  return { ok: true, value: next };
};

// 照控制面：一个人每个平台最多一个未登录占位，重复加原样回已有那行。
export const createAccount = (request: CreateAccountRequest): Outcome<{ account: Account; created: boolean }> => {
  const computer = computersOf().computers.find((c) => c.id === request.computerId);
  if (computer === undefined) return { ok: false, status: 404, error: "没有这台电脑" };
  if (computer.kind === "remote") {
    return { ok: false, status: 400, error: "小红书要扫码登录，只能挂在你自己的电脑上，远程电脑没有助理浏览器" };
  }
  const existing = [...accounts.values()].find((a) => a.platform === request.platform && a.login === "none");
  if (existing !== undefined) return { ok: true, value: { account: existing, created: false } };
  const stamp = now();
  const next = Account.parse({
    id: `acc_${nextSuffix()}`,
    ownerId: user.id,
    computerId: request.computerId,
    platform: request.platform,
    handle: null,
    tier: "confirm_publish",
    login: "none",
    loginChangedAt: stamp,
    createdAt: stamp,
  });
  accounts.set(next.id, next);
  return { ok: true, value: { account: next, created: true } };
};

// mock 没有电脑和助理浏览器，点登录就当扫码成功，直接记已登录。
export const loginAccount = (id: string): Outcome<Account> => {
  const account = accounts.get(id);
  if (account === undefined) return { ok: false, status: 404, error: "没有这个账号" };
  if (account.platform !== "xiaohongshu") return { ok: false, status: 400, error: "这个平台不走浏览器登录" };
  const next = Account.parse({
    ...account,
    handle: account.handle ?? `小红书号${nextSuffix()}`,
    login: "valid",
    loginChangedAt: now(),
  });
  accounts.set(next.id, next);
  return { ok: true, value: next };
};

// 测试入口：代替控制面的发布循环把一条已批草稿发出去。
export const publishDraft = (id: string): Outcome<{ draft: Draft; publication: Publication }> => {
  const draft = drafts.get(id);
  if (draft === undefined) return { ok: false, status: 404, error: "没有这条草稿" };
  if (draft.status !== "approved") return { ok: false, status: 409, error: "只有已批的草稿能发" };
  if (accounts.get(draft.accountId)?.tier === "draft") return { ok: false, status: 409, error: "可起草档批了也不发" };
  const publication = publicationOf({
    id: `pub_${nextSuffix()}`,
    draftId: draft.id,
    groupId: draft.groupId,
    accountId: draft.accountId,
    platform: draft.platform,
    publishedAt: now(),
  });
  publications.set(publication.id, publication);
  return { ok: true, value: { draft: write(Draft.parse({ ...draft, status: "published" })), publication } };
};

// 测试入口：代替 Bot 的 draft_edit 改正文。照控制面，已批的换了正文就回到待批，发出中和已发的不改。
export const reviseDraft = (id: string, text: string): Outcome<Draft> => {
  const draft = drafts.get(id);
  if (draft === undefined) return { ok: false, status: 404, error: "没有这条草稿" };
  if (draft.status === "publishing" || draft.status === "published") {
    return { ok: false, status: 409, error: "已经在发或发出的草稿不能改" };
  }
  const reopened = draft.status === "approved" && text !== draft.content.text;
  return {
    ok: true,
    value: write(
      Draft.parse({
        ...draft,
        content: { ...draft.content, text },
        status: reopened ? "pending" : draft.status,
        decidedAt: reopened ? null : draft.decidedAt,
      }),
    ),
  };
};

export const contentIn = (page: Message[]): { drafts: Draft[]; plans: ContentPlan[]; publications: Publication[] } => {
  const pagePlans = page.flatMap(({ body }) => {
    const plan = body.kind === "plan" ? plans.get(body.planId) : undefined;
    return plan === undefined ? [] : [plan];
  });
  const draftIds = [
    ...page.flatMap(({ body }) => (body.kind === "draft" ? [body.draftId] : [])),
    ...pagePlans.flatMap((plan) => plan.draftIds),
  ];
  return {
    drafts: draftIds.flatMap((draftId) => {
      const draft = drafts.get(draftId);
      return draft === undefined ? [] : [draft];
    }),
    plans: pagePlans,
    publications: [...publications.values()]
      .filter((publication) => publication.draftId !== null && draftIds.includes(publication.draftId))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id)),
  };
};
