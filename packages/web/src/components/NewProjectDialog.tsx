import { useRef, useState } from "react";
import { Spade, Sparkles } from "lucide-react";
import { useEscapeToClose } from "./useEscapeToClose.js";
import { useFailureToast } from "./Toasts.js";

type Props = {
  // 主助理单聊还没拉回来时是 null，这时不能发。
  canSend: boolean;
  onSend: (text: string) => Promise<void>;
  // 牌桌不用方案卡，点了直接建桌。requestId 一次打开内不变，建桌失败再点不会建出第二张。
  onCreateTable: (requestId: string) => Promise<void>;
  onClose: () => void;
};

// 只收一句话。这句话就是主助理单聊里的一条普通消息，方案卡由主助理回在那里。
export const NewProjectDialog = ({ canSend, onSend, onCreateTable, onClose }: Props) => {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [tableError, setTableError] = useState<string | null>(null);
  const tableRequestId = useRef(crypto.randomUUID());
  const failed = useFailureToast();
  const ready = canSend && text.trim().length > 0 && !sending;
  useEscapeToClose(onClose);

  const createTable = () => {
    setSending(true);
    setTableError(null);
    onCreateTable(tableRequestId.current).catch((cause: unknown) => {
      setSending(false);
      setTableError(cause instanceof Error ? cause.message : "建桌没成功，再试一次");
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    void onSend(text.trim()).catch((cause: unknown) => {
      setSending(false);
      failed("没发给主助理，再试一次")(cause);
    });
  };

  return (
    <div className="scrim" data-testid="new-project-dialog">
      <form className="dialog" onSubmit={submit}>
        <header className="dialog-head">
          <Sparkles size={20} aria-hidden="true" />
          <span>
            <b>新项目</b>
            <small>想做成什么事？一句话就行</small>
          </span>
        </header>
        <label className="field">
          <input
            data-testid="new-project-input"
            aria-label="想做成什么事"
            autoFocus
            value={text}
            placeholder="比如「把抖音号做起来，年底 1000 粉」"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <p className="dialog-note">
          名字、队伍、要用的账号、多久跑一次，主助理排成一张方案卡给你看。你点开始就开工，不用先填表。
        </p>
        <button
          type="button"
          className="new-project-table"
          data-testid="new-project-table"
          disabled={sending}
          onClick={createTable}
        >
          <Spade size={20} aria-hidden="true" />
          <span>
            <b>和 AI 打一局德州</b>
            <small>三个 AI 牌友加老白，不用方案卡，现在就能开</small>
          </span>
        </button>
        {tableError === null ? null : (
          <p className="today-inline-error" role="alert" data-testid="new-project-table-error">
            {tableError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" data-testid="new-project-cancel" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary-button" data-testid="new-project-submit" disabled={!ready}>
            交给主助理
          </button>
        </div>
      </form>
    </div>
  );
};
