export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

type LogSink = (line: string) => void;

type LoggerState = {
  level: LogLevel;
  stdout: LogSink;
  stderr: LogSink;
  now: () => Date;
};

export type Logger = {
  enabled(level: LogLevel): boolean;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  child(scope: string): Logger;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const MAX_MESSAGE_LENGTH = 500;
const MAX_FIELD_LENGTH = 300;
const MAX_FIELDS = 24;
const SENSITIVE_FIELD =
  /^(?:password|passphrase|(?:roamgate_|herdr_gui_)?pin|sessionSecret|token|secret|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function parseLogLevel(value: unknown): LogLevel {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as LogLevel;
  }
  const rendered =
    typeof value === "string" ? JSON.stringify(value) : renderValue(value);
  throw new Error(
    `invalid log level ${rendered}; expected ${LOG_LEVELS.join(", ")}`,
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@")
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|pin|token|secret)=)[^&#\s]+/gi,
      "$1***",
    )
    .replace(
      /\b((?:proxy-)?authorization)\s*:\s*(bearer|basic)\s+[^\s,;]+/gi,
      "$1: $2 ***",
    )
    .replace(
      /(["']?)(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passphrase|pin|sessionSecret|token|secret)\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
      "$1$2$1$3***",
    );
}

function sanitizeText(value: string, limit: number): string {
  return redactSensitiveText(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function renderValue(value: unknown): string {
  if (value instanceof Error)
    return sanitizeText(value.message, MAX_FIELD_LENGTH);
  if (typeof value === "string") return sanitizeText(value, MAX_FIELD_LENGTH);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return sanitizeText(JSON.stringify(value), MAX_FIELD_LENGTH);
  } catch {
    try {
      return sanitizeText(String(value), MAX_FIELD_LENGTH);
    } catch {
      return "[unprintable]";
    }
  }
}

function fieldText(key: string, value: unknown): string {
  if (SENSITIVE_FIELD.test(key)) return "***";
  return renderValue(value);
}

function quoteField(value: string): string {
  return value && !/[\s="\\]/.test(value) ? value : JSON.stringify(value);
}

export function formatLogLine(args: {
  timestamp: Date;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: LogFields;
}): string {
  const parts = [
    args.timestamp.toISOString(),
    args.level.toUpperCase(),
    sanitizeText(args.scope, MAX_FIELD_LENGTH) || "bridge",
    sanitizeText(args.message, MAX_MESSAGE_LENGTH) || "log",
  ];
  if (args.fields) {
    let emitted = 0;
    for (const [rawKey, value] of Object.entries(args.fields)) {
      if (value === undefined || emitted >= MAX_FIELDS) continue;
      const key = rawKey.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
      if (!key) continue;
      parts.push(`${key}=${quoteField(fieldText(key, value))}`);
      emitted += 1;
    }
  }
  return parts.join(" ");
}

function createScopedLogger(state: LoggerState, scope: string): Logger {
  function enabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[state.level];
  }

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (!enabled(level)) return;
    const line = formatLogLine({
      timestamp: state.now(),
      level,
      scope,
      message,
      fields,
    });
    (level === "error" || level === "warn" ? state.stderr : state.stdout)(line);
  }

  return {
    enabled,
    error: (message, fields) => emit("error", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    info: (message, fields) => emit("info", message, fields),
    debug: (message, fields) => emit("debug", message, fields),
    child: (childScope) =>
      createScopedLogger(
        state,
        [scope, sanitizeText(childScope, 100)].filter(Boolean).join("."),
      ),
  };
}

export function createLogger(
  args: {
    level?: LogLevel;
    scope?: string;
    stdout?: LogSink;
    stderr?: LogSink;
    now?: () => Date;
  } = {},
): Logger {
  return createScopedLogger(
    {
      level: args.level ?? "info",
      stdout: args.stdout ?? defaultStdout,
      stderr: args.stderr ?? defaultStderr,
      now: args.now ?? (() => new Date()),
    },
    args.scope ?? "bridge",
  );
}

const serverLoggerState: LoggerState = {
  level: "info",
  stdout: defaultStdout,
  stderr: defaultStderr,
  now: () => new Date(),
};

export const serverLogger = createScopedLogger(serverLoggerState, "bridge");

export function configureServerLogger(level: LogLevel): void {
  serverLoggerState.level = level;
}

export const silentLogger: Logger = {
  enabled: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

type ActiveFailure = {
  signature: string;
  failures: number;
  startedAt: number;
};

export type RecoveryReporter = {
  failure(error: unknown, fields?: LogFields): void;
  recovered(fields?: LogFields): boolean;
  active(): boolean;
};

export function createRecoveryReporter(args: {
  logger: Logger;
  failureMessage: string;
  recoveryMessage: string;
  now?: () => number;
}): RecoveryReporter {
  const now = args.now ?? Date.now;
  let current: ActiveFailure | null = null;

  return {
    failure(error, fields) {
      const detail = fieldText("error", error);
      if (current?.signature === detail) {
        current.failures += 1;
        args.logger.debug(args.failureMessage, {
          ...fields,
          error: detail,
          repeat: current.failures,
        });
        return;
      }
      current = {
        signature: detail,
        failures: 1,
        startedAt: now(),
      };
      args.logger.warn(args.failureMessage, { ...fields, error: detail });
    },
    recovered(fields) {
      if (!current) return false;
      const durationMs = Math.max(0, now() - current.startedAt);
      args.logger.info(args.recoveryMessage, {
        ...fields,
        failures: current.failures,
        suppressed: Math.max(0, current.failures - 1),
        duration_ms: durationMs,
      });
      current = null;
      return true;
    },
    active: () => current !== null,
  };
}
