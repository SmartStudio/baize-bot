import { z } from "zod";

export const WorkStream = z.enum(["chat", "table"]);
export type WorkStream = z.infer<typeof WorkStream>;

export const EMPTY_WORK_HEAD = "0".repeat(64);

const hexToBytes = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("工作记录 head 必须是 64 位小写十六进制");
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer));

export const advanceWorkHead = async (head: string, lines: readonly string[]): Promise<string> => {
  let current = hexToBytes(head);
  const encoder = new TextEncoder();
  for (const line of lines) {
    const lineHash = await sha256(encoder.encode(line));
    const input = new Uint8Array(current.length + lineHash.length);
    input.set(current);
    input.set(lineHash, current.length);
    current = await sha256(input);
  }
  return bytesToHex(current);
};

export const PiWorkEntry = z
  .object({ type: z.string().min(1), id: z.string().min(1), parentId: z.string().nullable() })
  .passthrough()
  .refine((entry) => entry.type !== "session", { message: "Pi session header 不能作为工作记录" });
export type PiWorkEntry = z.infer<typeof PiWorkEntry>;

export const extractWorkSearchText = (entry: unknown): string => {
  if (typeof entry !== "object" || entry === null || !("message" in entry)) return "";
  const message = entry.message;
  if (typeof message !== "object" || message === null || !("role" in message) || !("content" in message)) return "";
  const { role, content } = message;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
};

export const LaneIdentity = z.object({
  botId: z.string().min(1),
  groupId: z.string().min(1),
  epoch: z.number().int().positive(),
});
export type LaneIdentity = z.infer<typeof LaneIdentity>;

export const WorkAppendResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  z.object({ kind: z.literal("stale_epoch") }),
  z.object({ kind: z.literal("not_holder") }),
  z.object({ kind: z.literal("seq_mismatch"), nextSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("head_mismatch") }),
  z.object({ kind: z.literal("invalid") }),
]);
export type WorkAppendResult = z.infer<typeof WorkAppendResult>;

export const HubLaneSnapshot = z.object({
  entries: z.array(z.object({ seq: z.number().int().nonnegative(), line: z.string() })),
  nextSeq: z.number().int().nonnegative(),
  head: z.string().regex(/^[0-9a-f]{64}$/),
  piSessionVersion: z.number().int().positive().nullable(),
});
export type HubLaneSnapshot = z.infer<typeof HubLaneSnapshot>;
