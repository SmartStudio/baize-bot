import type { GroupId, PokerTableView } from "@baize/shared";
import { ReviewCard } from "../components/poker/ReviewCard.js";
import { SeatsBlock } from "../components/poker/SeatsBlock.js";
import { StatsBlock } from "../components/poker/StatsBlock.js";
import { SwapSeatDialog } from "../components/poker/SwapSeatDialog.js";

type Props = {
  table: PokerTableView;
  onOpenTable: (groupId: GroupId) => void;
};

// 牌桌项目页只在这里接线，四个子组件由单元 13（SeatsBlock、SwapSeatDialog）和单元 14（ReviewCard、StatsBlock）填实。
export const PokerProjectPage = ({ table, onOpenTable }: Props) => (
  <main data-poker-project={table.groupId}>
    <ReviewCard table={table} />
    <SeatsBlock table={table} onOpenTable={onOpenTable} />
    <SwapSeatDialog table={table} />
    <StatsBlock table={table} />
  </main>
);
