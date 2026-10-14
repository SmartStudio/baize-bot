import { createHash } from "node:crypto";
import { LiveId, type ToolView } from "@baize/shared";
import { Type } from "typebox";
import { z } from "zod";
import type { RunnerTool } from "./bot-session.js";
import { abortedError, type PageLoan } from "./browser.js";
import type { LiveOutcome, PresentPage } from "./live-port.js";
import type { RunIdentity } from "./reporter.js";

// Bot 请用户接手自己的那一页（登录墙、验证码）。页借出去的时候不持浏览器锁：发布器有自己的标签页，照常发；
// 同一个 Bot 别的群碰浏览器立刻报错，不排队等用户。这件工具不进 BROWSER_TOOL_ACTIONS，闸门归 read，会话闸门不为它持锁。

export const TAKEOVER_TOOL = "browser_ask_user";
export const TAKEOVER_LIMIT_MS = 30 * 60_000;

export const TAKEOVER_VOIDED = "用户在群里发了新消息，这次接手作废了。新消息会在这轮结束后送到你这里，别再请他接手。";
const TAKEOVER_TIMED_OUT = "等了 30 分钟用户没有接手，这一页收回来了。";
const TAKEOVER_ABANDONED = "用户说不弄了，这一页收回来了。";
const TAKEOVER_PAGE_GONE = "这一页在接手时被关掉了，要接着弄先 browser_open。";
const TAKEOVER_BROKEN = "助理浏览器出了问题，这次没法请用户接手。";
const TAKEOVER_BROWSER_CLOSED = "助理浏览器关掉了，这次接手没做完。";

const REASON_MAX = 200;
const Reason = z.string().min(1).max(REASON_MAX);
const PARAMS = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: REASON_MAX,
      description: "一句话告诉用户为什么要他接手、做到哪一步交还给你，最多 200 字",
    }),
  },
  { additionalProperties: false },
);

/** 一次工具调用一个画面 id：同一组 runId、callId 永远算出同一个，重投不生出第二块画面。 */
export function takeoverLiveId(runId: string, callId: string): LiveId {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, callId]))
    .digest();
  digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x40, 6);
  digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = digest.subarray(0, 16).toString("hex");
  return LiveId.parse(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

export function takeoverToolView(args: unknown, runId: string, callId: string): ToolView {
  const reason =
    typeof args === "object" && args !== null && "reason" in args && typeof args.reason === "string" ? args.reason : "";
  return {
    kind: "takeover",
    liveId: takeoverLiveId(runId, callId),
    reason,
    ...(args === undefined ? {} : { raw: args as ToolView["raw"] }),
  };
}

/** 一个 lane 当前挂着的接手。用户在这个群里发了新消息时，运行器按它作废。 */
export interface LaneTakeover {
  readonly runId: string;
  abort(): void;
}
export interface TakeoverSlot {
  current: LaneTakeover | null;
}

export interface TakeoverDeps {
  readonly activeRun: () => { readonly run: RunIdentity } | null;
  readonly lend: (signal: AbortSignal | undefined) => Promise<PageLoan>;
  readonly present: PresentPage;
  /** 这个 Bot 的浏览器要关了（Bot 被移除、停机）就响。每次调用现读，Bot 重建过 lifetime 会换。 */
  readonly closed: () => AbortSignal;
  readonly slot: TakeoverSlot;
  readonly limitMs: number;
}

/** 网址只报 origin 加 path：query 和 fragment 里常有一次性 token。 */
const reportedUrl = (url: string | null): string => {
  if (url === null) return "（不知道）";
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return "（不知道）";
  }
};

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function createTakeoverTool(deps: TakeoverDeps): RunnerTool {
  return {
    name: TAKEOVER_TOOL,
    label: "请用户接手",
    description:
      "把你后台标签页里当前这一页摆到用户眼前，请他亲自操作（登录、验证码、付款确认），操作完他会交还给你。" +
      "先 browser_open 到要他接手的那一页再调。等的时候别的浏览器工具都用不了；用户交还后之前的编号作废，先 browser_snapshot。" +
      "最多等 30 分钟；用户在群里发了新消息这次接手就作废。",
    parameters: PARAMS,
    execute: async (callId, raw, signal) => {
      const reason = Reason.safeParse((raw as { reason?: unknown }).reason);
      if (!reason.success) throw new Error(`reason 要写一句话，1 到 ${REASON_MAX} 字。`);
      const active = deps.activeRun();
      if (active === null) throw new Error("这次接手不在任何一次运行里");
      const { runId, botId, groupId } = active.run;
      const loan = await deps.lend(signal);
      const voided = new AbortController();
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), deps.limitMs);
      const closed = deps.closed();
      const mine: LaneTakeover = { runId, abort: () => voided.abort() };
      deps.slot.current = mine;
      try {
        const outcome = await deps.present(
          {
            liveId: takeoverLiveId(runId, callId),
            targetId: loan.targetId,
            purpose: { kind: "takeover", botId, groupId, reason: reason.data },
          },
          AbortSignal.any([...(signal === undefined ? [] : [signal]), limit.signal, voided.signal, closed]),
        );
        return resultOf(outcome, {
          aborted: signal?.aborted === true,
          closed: closed.aborted,
          voided: voided.signal.aborted,
        });
      } finally {
        clearTimeout(timer);
        if (deps.slot.current === mine) deps.slot.current = null;
        loan.giveBack();
      }
    },
  };
}

/** caller 是我们自己撤的，撤的原因只有调用方知道，按「run 中止 > 浏览器要关 > 作废 > 到点」分。 */
function resultOf(
  outcome: LiveOutcome,
  cause: { readonly aborted: boolean; readonly closed: boolean; readonly voided: boolean },
): ReturnType<typeof textResult> {
  switch (outcome.end.kind) {
    case "user":
      if (outcome.end.action === "abandon") throw new Error(TAKEOVER_ABANDONED);
      return textResult(
        `用户交还了这一页。\n地址：${reportedUrl(outcome.url)}\n之前的编号都作废了，要接着看先 browser_snapshot。`,
      );
    case "caller":
      if (cause.aborted) throw abortedError();
      if (cause.closed) throw new Error(TAKEOVER_BROWSER_CLOSED);
      if (cause.voided) throw new Error(TAKEOVER_VOIDED);
      throw new Error(TAKEOVER_TIMED_OUT);
    case "page_gone":
      throw new Error(TAKEOVER_PAGE_GONE);
    case "broken":
      throw new Error(TAKEOVER_BROKEN);
  }
}
