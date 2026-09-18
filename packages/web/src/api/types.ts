import type { z } from "zod";
import type { BotListItem as BotListItemSchema } from "@baize/shared";

// packages/shared 的 api.ts 只导出了 BotListItem 的 schema，没导出推导类型。
export type BotListItem = z.infer<typeof BotListItemSchema>;
