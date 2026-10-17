import { z } from "zod";
import { BotId, ComputerKind, RunId } from "./domain.js";

/**
 * POST /hub/v1/lane/computer：Bot 在这一轮里请求把这个群换到另一台电脑。网关 key 认电脑，道头认这条道，body 带这一轮的 run。
 * switching 表示选择已经改了、这一轮结束后会在那台上接着做；refused 的 text 原样给模型当工具错误。
 */
export const SwitchComputerRequest = z.object({ runId: RunId, kind: ComputerKind }).strict();
export type SwitchComputerRequest = z.infer<typeof SwitchComputerRequest>;

export const SwitchComputerResponse = z.discriminatedUnion("result", [
  z.object({ result: z.literal("switching") }).strict(),
  z
    .object({
      result: z.literal("refused"),
      reason: z.enum([
        "not_current_run",
        "already_continued",
        "routine_failed",
        "same_computer",
        "no_such_computer",
        "target_offline",
      ]),
      text: z.string(),
    })
    .strict(),
]);
export type SwitchComputerResponse = z.infer<typeof SwitchComputerResponse>;

// PUT /api/groups/:groupId/bots/:botId/computer。成功 204，账号下没有这种电脑 409，群或成员不是你的 404。
export const PutComputerChoiceRequest = z.object({ kind: ComputerKind }).strict();
export type PutComputerChoiceRequest = z.infer<typeof PutComputerChoiceRequest>;

/**
 * GET /api/groups/:groupId/computer-choices：按成员顺序每个 Bot 一项。kind 为 null 是没选过，走默认（本机优先）。
 * runningOn 是这条道上没跑完的 run 所在电脑的种类，没有为 null；和 kind 不同就是「这一轮还在原来那台上跑完」。
 */
export const ComputerChoices = z.array(
  z.object({ botId: BotId, kind: ComputerKind.nullable(), runningOn: ComputerKind.nullable() }).strict(),
);
export type ComputerChoices = z.infer<typeof ComputerChoices>;
