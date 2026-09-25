import { BotId, GroupId, OvernightResponse, RunId, UsageResponse } from "@baize/shared";
import { bots, groups } from "./store.js";

const WEEKLY_SPEND = [
  { botId: BotId.parse("bot_sales"), amount: 21.4, runs: 9 },
  { botId: BotId.parse("bot_service"), amount: 8.1, runs: 5 },
  { botId: BotId.parse("bot_buy"), amount: 8.7, runs: 4 },
];

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 60 * 60_000).toISOString();

const weekStart = (): string => {
  const shanghai = new Date(Date.now() + 8 * 60 * 60_000);
  shanghai.setUTCDate(shanghai.getUTCDate() - ((shanghai.getUTCDay() + 6) % 7));
  shanghai.setUTCHours(0, 0, 0, 0);
  return new Date(shanghai.getTime() - 8 * 60 * 60_000).toISOString();
};

export const usageOf = (): UsageResponse => {
  const recent = [
    { id: "quote", botId: "bot_sales", groupId: "grp_sales", title: "Globex X3 × 200 报价", hours: 1, amount: 4.6 },
    { id: "tickets", botId: "bot_service", groupId: "grp_service", title: "处理 14 张夜间工单", hours: 3, amount: 3.9 },
    { id: "supply", botId: "bot_buy", groupId: "grp_buy", title: "3 家供应商询价 · X3 现货", hours: 9, amount: 2.8 },
    {
      id: "leads",
      botId: "bot_sales",
      groupId: "grp_sales",
      title: "例行 · 每天 08:00 线索跟进",
      hours: 25,
      amount: 1.1,
    },
    {
      id: "reply",
      botId: "bot_service",
      groupId: "grp_service",
      title: "回复 Globex 交期问题",
      hours: 30,
      amount: 0.7,
    },
  ];
  return UsageResponse.parse({
    weekStartsAt: weekStart(),
    total: WEEKLY_SPEND.reduce((sum, line) => sum + line.amount, 0),
    bots: [...bots.values()]
      .map((bot) => {
        const spend = WEEKLY_SPEND.find((line) => line.botId === bot.id);
        return { botId: bot.id, amount: spend?.amount ?? 0, runs: spend?.runs ?? 0 };
      })
      .sort((a, b) => b.amount - a.amount),
    recent: recent.map((run) => ({
      runId: RunId.parse(`run_usage_${run.id}`),
      botId: bots.has(run.botId) ? BotId.parse(run.botId) : null,
      groupId: groups.has(run.groupId) ? GroupId.parse(run.groupId) : null,
      title: run.title,
      startedAt: hoursAgo(run.hours),
      endedAt: hoursAgo(run.hours - 0.1),
      steps: 6,
      amount: run.amount,
    })),
  });
};

export const overnightOf = (): OvernightResponse =>
  OvernightResponse.parse({
    since: hoursAgo(12),
    items: [
      {
        botId: "bot_buy",
        groupId: "grp_buy",
        text: "3 家供应商报价齐了，X3 现货 160 台，其余 10-20 到。",
        status: "done",
        at: hoursAgo(1),
      },
      {
        botId: "bot_service",
        groupId: "grp_service",
        text: "清了 14 张工单。Globex 要改交期，等你点头。",
        status: "waiting",
        at: hoursAgo(2),
      },
      {
        botId: "bot_sales",
        groupId: "grp_sales",
        text: "08:00 例行：跟进了 6 条线索，2 条有回复。",
        status: "working",
        at: hoursAgo(3),
      },
    ].filter((item) => bots.has(item.botId)),
  });
