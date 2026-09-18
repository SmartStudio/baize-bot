const DEFAULT_DATABASE_URL = "postgres://baize:baize@localhost:5434/baize";
const DEFAULT_PORT = 3001;

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

export function secureCookie(): boolean {
  return (process.env["COOKIE_SECURE"] ?? "") === "1";
}

export function port(): number {
  const raw = process.env["PORT"];
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT 不是合法端口: ${raw}`);
  }
  return parsed;
}
