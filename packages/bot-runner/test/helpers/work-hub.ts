import { createServer } from "node:http";
import { EMPTY_WORK_HEAD, advanceWorkHead, type HubLaneSnapshot, type WorkAppend } from "@baize/shared";

/** 假 Hub：内存里一条流，`append` 当运行器的 workAppend，GET 按 after/limit 分页回快照。 */
export async function startWorkHub() {
  let lines: string[] = [];
  const frames: WorkAppend[] = [];
  const readHeaders: Array<string | undefined> = [];
  const snapshot = async (): Promise<HubLaneSnapshot> => ({
    entries: lines.map((line, seq) => ({ seq, line })),
    nextSeq: lines.length,
    head: await advanceWorkHead(EMPTY_WORK_HEAD, lines),
    piSessionVersion: lines.length ? 3 : null,
  });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const after = Number(url.searchParams.get("after") ?? -1);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const lane = req.headers["x-baize-lane"];
      readHeaders.push(Array.isArray(lane) ? lane.join(",") : lane);
      const data = await snapshot();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...data, entries: data.entries.filter((entry) => entry.seq > after).slice(0, limit) }));
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Hub 没有监听端口");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/hub/v1`,
    frames,
    readHeaders,
    snapshot,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    reset: (next: string[]) => {
      lines = [...next];
    },
    append: async (frame: WorkAppend) => {
      frames.push(frame);
      if (frame.lines.length === 0) return { kind: "ok" as const };
      if (frame.fromSeq !== lines.length) return { kind: "seq_mismatch" as const, nextSeq: lines.length };
      if ((await advanceWorkHead((await snapshot()).head, frame.lines)) !== frame.head)
        return { kind: "head_mismatch" as const };
      lines.push(...frame.lines);
      return { kind: "ok" as const };
    },
  };
}
