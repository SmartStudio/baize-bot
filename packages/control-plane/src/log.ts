export type LogFormat = "json" | "pretty";
type Level = "info" | "warn" | "error";

/** 有哪个带哪个。err 是 Error 时记 name、code、message、stack；concealed(error) 包过的只记 name、code 和调用栈。 */
export type LogFields = {
  readonly runId?: string | null | undefined;
  readonly computerId?: string | null | undefined;
  readonly groupId?: string | null | undefined;
  readonly botId?: string | null | undefined;
  readonly err?: unknown;
  readonly [field: string]: unknown;
};

const REDACTED = "[已隐去]";
// 太短的值替换掉会把日志里不相干的字一起抹掉，真密钥不会这么短。
const MIN_SECRET_LENGTH = 8;
const BEARER = /(Bearer\s+)[^\s"\\,;]+/giu;

let format: LogFormat = "json";
const secrets = new Set<string>();

export function configureLog(options: { readonly format: LogFormat }): void {
  format = options.format;
}

export function redactInLog(secret: string): void {
  if (secret.length >= MIN_SECRET_LENGTH) secrets.add(secret);
}

/** 异常原文可能夹着用户正文或凭据，这类地方只记类别和调用栈。 */
export function concealed(error: unknown): ConcealedError {
  return new ConcealedError(error);
}

class ConcealedError {
  readonly name: string;
  readonly code: string | undefined;
  readonly stack: string | undefined;

  constructor(error: unknown) {
    this.name = error instanceof Error ? error.name : typeof error;
    this.code = codeOf(error);
    this.stack = error instanceof Error ? frames(error.stack) : undefined;
  }
}

export const log = {
  info: (msg: string, fields?: LogFields): void => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => write("error", msg, fields),
};

function write(level: Level, msg: string, fields: LogFields = {}): void {
  const { err, ...rest } = fields;
  const error = err === undefined ? undefined : serializeError(err);
  const time = new Date();
  const line =
    format === "json"
      ? JSON.stringify({ time: time.toISOString(), level, msg, ...rest, err: error }, jsonValue)
      : pretty(time, level, msg, rest, error);
  const sink = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
  sink(redact(line));
}

type SerializedError = {
  readonly name: string;
  readonly code?: string;
  readonly message?: string;
  readonly stack?: string;
};

function serializeError(error: unknown): SerializedError {
  if (error instanceof ConcealedError)
    return withoutUndefined({ name: error.name, code: error.code, stack: error.stack });
  if (error instanceof Error) {
    return withoutUndefined({ name: error.name, code: codeOf(error), message: error.message, stack: error.stack });
  }
  return { name: typeof error, message: String(error) };
}

function withoutUndefined(error: { [K in keyof SerializedError]: SerializedError[K] | undefined }): SerializedError {
  return Object.fromEntries(Object.entries(error).filter(([, value]) => value !== undefined)) as SerializedError;
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** stack 的头一段是 message，可能有好几行，只留 at 那几行。 */
function frames(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const kept = stack.split("\n").filter((line) => /^\s+at /u.test(line));
  return kept.length === 0 ? undefined : kept.join("\n");
}

function jsonValue(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function pretty(
  time: Date,
  level: Level,
  msg: string,
  fields: Readonly<Record<string, unknown>>,
  error: SerializedError | undefined,
): string {
  const clock = time.toTimeString().slice(0, 8) + "." + String(time.getMilliseconds()).padStart(3, "0");
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value, jsonValue)}`);
  const head = [clock, level.toUpperCase().padEnd(5), msg, ...pairs].join(" ");
  if (error === undefined) return head;
  const summary = [error.name, error.code].filter((part) => part !== undefined).join(" ");
  const detail = error.message === undefined ? summary : `${summary}: ${error.message}`;
  const stack =
    error.stack
      ?.split("\n")
      .filter((line) => /^\s+at /u.test(line))
      .join("\n") ?? "";
  return stack === "" ? `${head}\n  ${detail}` : `${head}\n  ${detail}\n${stack}`;
}

function redact(line: string): string {
  let redacted = line.replace(BEARER, `$1${REDACTED}`);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) redacted = redacted.split(escaped).join(REDACTED);
  }
  return redacted;
}
