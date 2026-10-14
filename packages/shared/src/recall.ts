import { z } from "zod";
import { GroupId } from "./domain.js";

export const RECALL_LIMIT = 8;
export const RECALL_EXCERPT_LENGTH = 400;
export const RECALL_QUERY_LENGTH = 100;

export const RecallRequest = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(RECALL_QUERY_LENGTH)
      .refine((query) => !query.includes("\u0000")),
  })
  .strict();
export type RecallRequest = z.infer<typeof RecallRequest>;

export const RecallEntry = z.object({
  groupId: GroupId,
  groupTitle: z.string(),
  at: z.string().datetime(),
  kind: z.enum(["user", "assistant", "toolResult"]),
  excerpt: z.string().max(RECALL_EXCERPT_LENGTH),
});
export type RecallEntry = z.infer<typeof RecallEntry>;

export const RecallResponse = z.array(RecallEntry).max(RECALL_LIMIT);
export type RecallResponse = z.infer<typeof RecallResponse>;

export const recallPlaceholder = (count: number): string => `找到 ${count} 条以前的记录，内容只在这一轮可见`;
