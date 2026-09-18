import { randomBytes, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}
