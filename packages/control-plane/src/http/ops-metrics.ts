import { Hono } from "hono";
import { hashSecret, secretMatches } from "../ids.js";
import { bearerToken } from "./gateway.js";

export const METRICS_PATH = "/metrics";

export type RunStateCounts = { readonly running: number; readonly unsettled: number; readonly settled: number };

export type OpsSnapshot = {
  readonly computersOnline: number;
  readonly runs: RunStateCounts;
  readonly gatewayResponses: ReadonlyMap<number, number>;
  readonly continuationBacklog: number;
  readonly websockets: { readonly agent: number; readonly push: number; readonly live: number };
};

export type OpsMetricsDeps = {
  readonly token: string | null;
  read(): Promise<OpsSnapshot>;
};

/** 进程内的计数，重启归零，Prometheus 的 counter 本来就这么认。 */
export class StatusCounts {
  readonly #counts = new Map<number, number>();

  add(status: number): void {
    this.#counts.set(status, (this.#counts.get(status) ?? 0) + 1);
  }

  snapshot(): ReadonlyMap<number, number> {
    return new Map(this.#counts);
  }
}

export function createOpsMetrics(deps: OpsMetricsDeps): Hono {
  const app = new Hono();
  app.get(METRICS_PATH, async (c) => {
    if (deps.token === null) return c.json({ error: "没有这个对象" }, 404);
    const presented = bearerToken(c.req.header("authorization"));
    if (presented === null || !secretMatches(presented, hashSecret(deps.token)))
      return c.json({ error: "指标 token 不对" }, 401);
    return c.body(prometheusText(await deps.read()), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
  return app;
}

function prometheusText(snapshot: OpsSnapshot): string {
  const gateway = [...snapshot.gatewayResponses].toSorted(([left], [right]) => left - right);
  return [
    "# HELP baize_computers_online 这个控制面上能派活的电脑台数。",
    "# TYPE baize_computers_online gauge",
    `baize_computers_online ${snapshot.computersOnline}`,
    "# HELP baize_runs 库里的 run 按状态分：running 还没结束，unsettled 结束了账还没结，settled 账已结清。",
    "# TYPE baize_runs gauge",
    `baize_runs{state="running"} ${snapshot.runs.running}`,
    `baize_runs{state="unsettled"} ${snapshot.runs.unsettled}`,
    `baize_runs{state="settled"} ${snapshot.runs.settled}`,
    "# HELP baize_gateway_responses_total 网关 /chat/completions 回给电脑的状态码，含上游原样转回的和网关自己回的 401、429、502、504。",
    "# TYPE baize_gateway_responses_total counter",
    ...gateway.map(([code, count]) => `baize_gateway_responses_total{code="${code}"} ${count}`),
    "# HELP baize_continuation_backlog 换电脑后还欠着没起的接续，补扫每 30 秒捡一遍。",
    "# TYPE baize_continuation_backlog gauge",
    `baize_continuation_backlog ${snapshot.continuationBacklog}`,
    "# HELP baize_websocket_connections 当前开着的 WebSocket：agent 是电脑代理，push 是网页推送，live 是画面观看者。",
    "# TYPE baize_websocket_connections gauge",
    `baize_websocket_connections{kind="agent"} ${snapshot.websockets.agent}`,
    `baize_websocket_connections{kind="push"} ${snapshot.websockets.push}`,
    `baize_websocket_connections{kind="live"} ${snapshot.websockets.live}`,
    "",
  ].join("\n");
}
