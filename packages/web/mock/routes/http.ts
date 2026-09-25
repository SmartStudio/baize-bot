import { type IncomingMessage, type ServerResponse } from "node:http";
import { type ServerPush, type Routine } from "@baize/shared";

export type Push = (event: ServerPush) => void;

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  push: Push;
};

export type Route = (context: RouteContext) => Promise<boolean>;

export const send = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

const MALFORMED = Symbol("malformed json");

export const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return MALFORMED;
  }
};

export const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;

export type FireRoutine = (routineId: string, push: Push) => Routine | null;
