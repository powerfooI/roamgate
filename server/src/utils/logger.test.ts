import { describe, expect, test } from "bun:test";
import {
  createLogger,
  createRecoveryReporter,
  formatLogLine,
  parseLogLevel,
} from "./logger";

const NOW = new Date("2026-01-02T03:04:05.678Z");

describe("server logger", () => {
  test("filters below the configured level and routes warnings to stderr", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = createLogger({
      level: "info",
      scope: "bridge",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: () => NOW,
    });

    logger.debug("hidden request", { method: "workspace.list" });
    logger.info("listening", { port: 8787 });
    logger.warn("degraded", { connection: "default" });

    expect(stdout).toEqual([
      "2026-01-02T03:04:05.678Z INFO bridge listening port=8787",
    ]);
    expect(stderr).toEqual([
      "2026-01-02T03:04:05.678Z WARN bridge degraded connection=default",
    ]);
  });

  test("formats child scopes and sanitizes bounded context", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      scope: "bridge",
      stdout: (line) => lines.push(line),
      now: () => NOW,
    }).child("terminal");

    logger.debug("frame\nreceived", {
      terminal: "term-1",
      detail: `token=private-value ${"x".repeat(400)}`,
      token: "private-value",
      url: "https://example.com/login?token=private-value&next=%2F",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(
      "2026-01-02T03:04:05.678Z DEBUG bridge.terminal frame received",
    );
    expect(lines[0]).toContain("terminal=term-1");
    expect(lines[0]).toContain("token=***");
    expect(lines[0]).toContain("?token=***&next=%2F");
    expect(lines[0]).not.toContain("private-value");
    expect(lines[0]!.length).toBeLessThan(800);
  });

  test("formats arbitrary lines without control-character injection", () => {
    expect(
      formatLogLine({
        timestamp: NOW,
        level: "error",
        scope: "bridge\nspoofed",
        message: "failed\r\nFAKE ERROR",
        fields: { "bad key": "a\tb" },
      }),
    ).toBe(
      '2026-01-02T03:04:05.678Z ERROR bridge spoofed failed FAKE ERROR bad_key="a b"',
    );
  });
});

describe("log level parsing", () => {
  test("accepts supported levels case-insensitively", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
  });

  test("rejects unsupported levels with the accepted values", () => {
    expect(() => parseLogLevel("trace")).toThrow(
      'invalid log level "trace"; expected error, warn, info, debug',
    );
  });

  test("rejects unstringifiable values without masking the error", () => {
    expect(() => parseLogLevel(10n)).toThrow(
      "invalid log level 10; expected error, warn, info, debug",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseLogLevel(circular)).toThrow(
      "invalid log level [object Object]; expected error, warn, info, debug",
    );
  });
});

describe("recovery reporter", () => {
  test("deduplicates equivalent failures and summarizes recovery", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let now = 1_000;
    const logger = createLogger({
      level: "info",
      scope: "bridge.events",
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: () => NOW,
    });
    const reporter = createRecoveryReporter({
      logger,
      failureMessage: "subscription failed",
      recoveryMessage: "subscription recovered",
      now: () => now,
    });

    reporter.failure(new Error("socket unavailable"), {
      connection: "default",
    });
    now += 500;
    reporter.failure(new Error("socket unavailable"), {
      connection: "default",
    });
    now += 1_500;
    expect(reporter.recovered({ connection: "default" })).toBe(true);
    expect(reporter.recovered({ connection: "default" })).toBe(false);

    expect(stderr).toEqual([
      '2026-01-02T03:04:05.678Z WARN bridge.events subscription failed connection=default error="socket unavailable"',
    ]);
    expect(stdout).toEqual([
      "2026-01-02T03:04:05.678Z INFO bridge.events subscription recovered connection=default failures=2 suppressed=1 duration_ms=2000",
    ]);
  });
});

test("redacts PINs and session signing material from log fields and messages", () => {
  const line = formatLogLine({
    timestamp: NOW,
    level: "warn",
    scope: "bridge",
    message:
      'ROAMGATE_PIN=123456 pin=654321 {"pin":"987654"} sessionSecret=abcdef',
    fields: {
      pin: "123456",
      ROAMGATE_PIN: "654321",
      HERDR_GUI_PIN: "987654",
      sessionSecret: "abcdef",
      url: "https://example.test/?pin=123456",
    },
  });
  for (const secret of ["123456", "654321", "987654", "abcdef"])
    expect(line).not.toContain(secret);
});
