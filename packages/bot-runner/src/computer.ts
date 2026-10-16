import type { ComputerKind, ComputerView } from "@baize/shared";

const NAME: Readonly<Record<ComputerKind, string>> = { local: "主人的电脑", remote: "云电脑" };

const SELF: Readonly<Record<ComputerKind, string>> = {
  local: "这一轮你在主人的电脑上。",
  remote:
    "这一轮你在云电脑上：一台 Linux 服务器，不是主人的电脑。主人电脑上的文件、登录过的网站这里都没有，浏览器要在这里单独登录。在这里工作区里的普通读写和只读命令不用问主人，联网、删除、移动、读写工作区外的东西照旧要问。",
};

/** 每次模型请求现拼，不进会话 JSONL，所以换机后不会留下过时的「我在 Mac 上」。 */
export function renderComputerSection(self: ComputerKind, view: ComputerView | null): string | null {
  if (self === "local" && view === null) return null;
  const lines = ["## 电脑", SELF[self]];
  const other = view?.other ?? null;
  if (other !== null) {
    lines.push(
      other.dispatchable
        ? `另一台是${NAME[other.kind]}，在线。需要换过去就调用 switch_computer（kind 填 ${other.kind}），这一轮会在那边接着做，不用让主人自己去点。`
        : `另一台是${NAME[other.kind]}，现在不在线，换不过去。`,
    );
    if (other.kind === view?.choice) {
      lines.push(
        `这个群里你选定的是${NAME[other.kind]}，这一轮在${NAME[self]}上跑完，下一条起会在${NAME[other.kind]}上。`,
      );
    }
  }
  return lines.join("\n");
}
