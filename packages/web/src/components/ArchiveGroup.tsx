import { useState } from "react";
import type { GroupId } from "@baize/shared";

type Props = {
  groupId: GroupId;
  // 桌上正有一手在打时多一句「这手作废」。
  handInPlay: boolean;
  onArchive: (groupId: GroupId) => Promise<unknown>;
};

// 解散是收不回的操作，入口放成不抢眼的次级按钮，点了先确认。成了之后侧栏移掉这个群，开着的页面自己回首页。
export const ArchiveGroup = ({ groupId, handInPlay, onArchive }: Props) => {
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setArchiving(true);
    setError(null);
    onArchive(groupId).catch((cause: unknown) => {
      setArchiving(false);
      setError(cause instanceof Error ? cause.message : "没解散成，再试一次");
    });
  };

  return (
    <>
      <button
        type="button"
        className="ghost-button archive-group-open"
        data-testid="archive-group"
        onClick={() => setOpen(true)}
      >
        解散群
      </button>
      {open ? (
        <div className="scrim" data-testid="archive-group-dialog">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="解散这个群">
            <header className="dialog-head">
              <span>
                <b>解散这个群？</b>
                <small>
                  群会从侧栏消失，正在做的活和挂着的审批都会停下{handInPlay ? "，正在打的这手作废" : ""}
                  。解散后找不回来。
                </small>
              </span>
            </header>
            {error === null ? null : (
              <p className="today-inline-error" role="alert" data-testid="archive-group-error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost-button"
                data-testid="archive-group-cancel"
                disabled={archiving}
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="ghost-button archive-group-confirm"
                data-testid="archive-group-confirm"
                disabled={archiving}
                onClick={confirm}
              >
                解散
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
