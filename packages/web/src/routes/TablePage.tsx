import type { GroupId, PokerTableView } from "@baize/shared";
import { ActionBar } from "../components/table/ActionBar.js";
import { Felt } from "../components/table/Felt.js";
import { HandEnd } from "../components/table/HandEnd.js";
import { HostHint } from "../components/table/HostHint.js";
import { TableLog, VirtualChipsNote } from "../components/table/TableLog.js";
import { usePokerTableLoad } from "../state/use-poker-table.js";

type Props = {
  groupId: GroupId;
  table: PokerTableView | null;
};

// 牌桌页在这里接线：Felt、ActionBar 归单元 11，TableLog、HostHint、HandEnd 归单元 12。
export const TablePage = ({ groupId, table }: Props) => {
  const { load, reload } = usePokerTableLoad(groupId);

  return (
    <main className="table-page" data-testid="table-page" data-table={groupId}>
      <VirtualChipsNote />
      {table === null ? (
        load === "failed" ? (
          <p className="table-page-note" data-testid="table-error">
            牌桌没拉到。
            <button type="button" className="link-button" onClick={reload}>
              重试
            </button>
          </p>
        ) : (
          <p className="table-page-note">牌桌加载中。</p>
        )
      ) : null}
      <div className="table-stage">
        <Felt table={table} />
        <ActionBar table={table} />
        <HandEnd table={table} />
      </div>
      <aside className="table-side">
        <TableLog table={table} />
        <HostHint table={table} />
      </aside>
    </main>
  );
};
