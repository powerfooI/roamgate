import { describe, expect, test } from "bun:test";
import {
  createEchoProbe,
  formatLatencyLine,
  isTypedCharacter,
} from "./latencyDebug";

describe("latency debug", () => {
  test("formats grep-friendly key=value lines", () => {
    expect(
      formatLatencyLine("refresh call", {
        connection: "conn_1",
        method: "pane.list",
        skipped: undefined,
        total_ms: 412,
        error: "timed out",
      }),
    ).toBe(
      '[latency] refresh call connection=conn_1 method=pane.list total_ms=412 error="timed out"',
    );
  });

  test("samples only single typed characters", () => {
    expect(isTypedCharacter("a")).toBe(true);
    expect(isTypedCharacter("é")).toBe(true);
    expect(isTypedCharacter("\u{1f600}")).toBe(true);
    expect(isTypedCharacter("ab")).toBe(false);
    expect(isTypedCharacter("\r")).toBe(false);
    expect(isTypedCharacter("\x7f")).toBe(false);
    expect(isTypedCharacter("\x1b[A")).toBe(false);
    expect(isTypedCharacter("")).toBe(false);
  });

  test("times the oldest unanswered key to the next frame", () => {
    let clock = 0;
    const probe = createEchoProbe(() => clock);
    expect(probe.presented()).toBeNull();

    probe.sent("\x1b[A");
    clock = 10;
    expect(probe.presented()).toBeNull();

    probe.sent("a");
    clock = 30;
    probe.sent("b");
    clock = 290;
    expect(probe.presented()).toBe(280);
    expect(probe.presented()).toBeNull();
  });
});
