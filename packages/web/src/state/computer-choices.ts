import type { BotId, GroupId } from "@baize/shared";
import { shelfLoad, shelfRow, shelfWrite } from "./stamped.js";
import type { Action, ChoiceEntry, ReadyState } from "./types.js";

const entryId = (groupId: GroupId, botId: BotId): string => `${groupId}/${botId}`;

// 按群分架，一行一个成员。kind 由选择和推送改、按号比；runningOn 只有列表知道，
// 列表回来时号更新的那行留它自己的 kind，runningOn 仍取这份列表的。同一个群的拉取一次只飞一趟，后到的就是新的。
export const reduceComputerChoices = (state: ReadyState, action: Action): ReadyState => {
  switch (action.type) {
    case "computer_choices_loaded": {
      const snapshot = action.choices.map((choice) => ({ ...choice, id: entryId(action.groupId, choice.botId) }));
      const loaded = shelfLoad(state.computerChoices, action.groupId, action.seq, snapshot, "deleted");
      const running = new Map(snapshot.map((row) => [row.id, row.runningOn]));
      const rows = (loaded.rows[action.groupId] ?? []).map((row) => {
        const runningOn = running.get(row.id);
        return runningOn === undefined ? row : { ...row, runningOn };
      });
      return { ...state, computerChoices: { ...loaded, rows: { ...loaded.rows, [action.groupId]: rows } } };
    }
    case "computer_choice_set": {
      const id = entryId(action.groupId, action.botId);
      const known = shelfRow(state.computerChoices, action.groupId, id);
      const row: ChoiceEntry = { id, botId: action.botId, runningOn: known?.runningOn ?? null, kind: action.kind };
      return { ...state, computerChoices: shelfWrite(state.computerChoices, action.groupId, action.seq, row) };
    }
    default:
      return state;
  }
};

// 有成员换了电脑、这一轮还在原来那台上跑。这一轮跑完时控制面会往群里推花费卡或收尾那句，回合推送也会到，
// 这时重拉才收得掉头部那句「这一轮还在……跑完」。
export const finishingElsewhere = (state: ReadyState | null, groupId: GroupId): boolean =>
  (state?.computerChoices.rows[groupId] ?? []).some(
    (row) => row.kind !== null && row.runningOn !== null && row.kind !== row.runningOn,
  );
