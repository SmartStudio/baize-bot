import { expect } from "vitest";

/** 抓一遍 /metrics，按 `名字{标签}` 取值。HELP、TYPE 两行要成对出现在样本前面，不然 Prometheus 不认。 */
export async function scrapeMetrics(port: number, token: string): Promise<ReadonlyMap<string, number>> {
  const response = await fetch(`http://localhost:${port}/metrics`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  const samples = new Map<string, number>();
  const typed = new Set<string>();
  for (const line of (await response.text()).split("\n")) {
    if (line === "" || line.startsWith("# HELP ")) continue;
    const type = /^# TYPE (\w+) (gauge|counter)$/u.exec(line);
    if (type?.[1] !== undefined) {
      typed.add(type[1]);
      continue;
    }
    const sample = /^(\w+)(\{[^}]*\})? (\d+)$/u.exec(line);
    expect(sample, `不是合法的样本行：${line}`).not.toBeNull();
    const [, name = "", labels = "", value = ""] = sample ?? [];
    expect(typed.has(name), `${name} 前面没有 TYPE`).toBe(true);
    samples.set(`${name}${labels}`, Number(value));
  }
  return samples;
}
