// 留存相关的数。控制面和工作记录按它们裁剪清理，数据与隐私页照它们写给用户看，两边不能各抄一份。

/** 每个例行任务留的运行记录条数。规格里的「运行记录（最近 20 条）」。 */
export const MAX_ROUTINE_RUNS = 20;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 过期会话读时已经认不出来，清理只是不让表一直涨，一小时一轮足够。 */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export const RETAIN_TEXT_LIMIT_BYTES = 16 * 1024;

export const KEPT_EDGE_BYTES = 2 * 1024;
