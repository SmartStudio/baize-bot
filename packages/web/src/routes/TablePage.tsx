import { ChevronLeft, Play } from "lucide-react";
import { Link } from "react-router-dom";
import type { GroupId, PokerTableView } from "@baize/shared";
import { ActionBar } from "../components/table/ActionBar.js";
import { Felt } from "../components/table/Felt.js";
import { HandEnd } from "../components/table/HandEnd.js";
import { HostHint } from "../components/table/HostHint.js";
import { TableLog, VirtualChipsNote } from "../components/table/TableLog.js";
import { useTableRun } from "../components/table/use-table-run.js";
import { usePokerTableLoad } from "../state/use-poker-table.js";
import { pathOf } from "./screen.js";

type Props = {
  groupId: GroupId;
  /** 牌桌项目的名字。侧栏里还没认出这个群时是 null，页头只写「牌桌」。 */
  title: string | null;
  table: PokerTableView | null;
};

// 控制面在一手打到一半或从没开打时散场回 409，页头的散场按同样的条件先灰掉，说清为什么。
const leaveBlocked = (table: PokerTableView): string | null => {
  if (table.status === "in_hand") return "这一手还没打完，打完再散场";
  if (table.session === null) return "还没开打，没有可散的场";
  return null;
};

const TableHead = ({ groupId, title, table }: Props) => {
  const { busy, failure, run } = useTableRun(groupId);
  const blocked = table === null ? "牌桌还没拉到" : leaveBlocked(table);
  return (
    <header className="table-head" data-testid="table-head">
      <Link className="table-back" data-testid="table-back" to={pathOf({ kind: "project", groupId })}>
        <ChevronLeft size={16} aria-hidden="true" />
        返回项目
      </Link>
      <h1 className="table-title">{title ?? "牌桌"}</h1>
      {table?.hand === null || table?.hand === undefined ? null : (
        <span className="table-hand-no" data-testid="table-hand-no">
          第 {table.hand.number} 手
        </span>
      )}
      <VirtualChipsNote />
      <button
        type="button"
        className="ghost-button table-head-leave"
        data-testid="table-leave"
        disabled={blocked !== null || busy !== null}
        title={blocked ?? undefined}
        onClick={() => void run("leave")}
      >
        散场
      </button>
      {failure === null ? null : (
        <p className="error table-head-error" role="alert">
          {failure}
        </p>
      )}
    </header>
  );
};

const NoHand = ({ groupId }: { groupId: GroupId }) => {
  const { busy, failure, run } = useTableRun(groupId);
  return (
    <section className="table-empty" data-testid="table-empty">
      <p className="table-empty-text">桌上还没有牌。</p>
      <button
        type="button"
        className="primary-button table-empty-start"
        data-testid="table-start"
        disabled={busy !== null}
        onClick={() => void run("start")}
      >
        <Play size={16} aria-hidden="true" />
        开一手
      </button>
      {failure === null ? null : (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
};

// 牌桌页在这里接线：Felt、ActionBar 归单元 11，TableLog、HostHint、HandEnd 归单元 12。
export const TablePage = ({ groupId, title, table }: Props) => {
  const { load, reload } = usePokerTableLoad(groupId);

  return (
    <main className="table-page" data-testid="table-page" data-table={groupId}>
      <TableHead groupId={groupId} title={title} table={table} />
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
        {table !== null && table.hand === null ? <NoHand groupId={groupId} /> : null}
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
