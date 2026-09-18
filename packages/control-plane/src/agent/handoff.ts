/** 交接报文渲染成给目标 Bot 的 prompt 正文。纯函数，不碰数据库。 */
export type HandoffReport = {
  readonly fromName: string;
  readonly done: string;
  readonly notDone: string;
  readonly next: string;
  readonly checklistIndex: number | null;
};

export function renderHandoffReport(report: HandoffReport): string {
  const lines = [
    `${report.fromName}把这件事交给你了。先 accept_handoff 确认接手，再往下干。`,
    `做了什么：${report.done}`,
    `没做什么：${report.notDone}`,
    `下一步：${report.next}`,
  ];
  // 清单指针在报文里从 0 数起，说给人和 Bot 听要从 1 数起。
  if (report.checklistIndex !== null) lines.push(`从清单第 ${report.checklistIndex + 1} 条接着做。`);
  return lines.join("\n");
}
