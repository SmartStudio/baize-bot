import type { GroupId, PokerTableView } from "@baize/shared";
import { ActionBar } from "../components/table/ActionBar.js";
import { Felt } from "../components/table/Felt.js";
import { HandEnd } from "../components/table/HandEnd.js";
import { HostHint } from "../components/table/HostHint.js";
import { TableLog, VirtualChipsNote } from "../components/table/TableLog.js";

type Props = {
  groupId: GroupId;
  table: PokerTableView | null;
};

// 牌桌页只在这里接线，五个子组件由单元 11（Felt、ActionBar）和单元 12（TableLog、HostHint、HandEnd）各自填实。
export const TablePage = ({ groupId, table }: Props) => (
  <main data-table={groupId}>
    <VirtualChipsNote />
    <Felt table={table} />
    <ActionBar table={table} />
    <TableLog table={table} />
    <HostHint table={table} />
    <HandEnd table={table} />
  </main>
);
