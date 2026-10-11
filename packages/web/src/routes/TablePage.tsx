import type { GroupId, PokerTableView } from "@baize/shared";
import { ActionBar } from "../components/table/ActionBar.js";
import { Felt } from "../components/table/Felt.js";
import { HandEnd } from "../components/table/HandEnd.js";
import { HostHint } from "../components/table/HostHint.js";
import { TableLog, VirtualChipsNote } from "../components/table/TableLog.js";
import { useApp } from "../state/app.js";
import { usePokerTable } from "../state/use-poker-table.js";

type Props = {
  groupId: GroupId;
  table: PokerTableView | null;
};

// 牌桌页在这里接线：Felt、ActionBar 归单元 11，TableLog、HostHint、HandEnd 归单元 12。
// store 里的牌桌只有推送来过才有，进页面先自己拉一次，重连后再拉一次。
export const TablePage = ({ groupId, table: stored }: Props) => {
  const { state } = useApp();
  const reconnectedAt = state.status === "ready" ? state.reconnectedAt : 0;
  const { table, load, adopt, reload } = usePokerTable(groupId, stored, reconnectedAt);

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
        <ActionBar table={table} onTable={adopt} />
        <HandEnd table={table} />
      </div>
      <aside className="table-side">
        <TableLog table={table} />
        <HostHint table={table} />
      </aside>
    </main>
  );
};
