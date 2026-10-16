import { z } from "zod";
import { BotId, ComputerKind } from "./domain.js";

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
