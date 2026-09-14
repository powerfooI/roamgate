import { describe, expect, test } from "bun:test";
import {
  cleanMessageText,
  integrationInstallCommand,
  normalizeAgentName,
  textFromContent,
  timestampMs,
} from "./session-utils";

describe("agent session utility helpers", () => {
  test("normalizes agent names and integration commands", () => {
    expect(normalizeAgentName("Claude-Code")).toBe("claude");
    expect(normalizeAgentName("Kimi Code")).toBe("kimi");
    expect(normalizeAgentName("Grok Build")).toBe("grok");
    expect(normalizeAgentName("Antigravity")).toBe("agy");
    expect(normalizeAgentName("antigravity-cli")).toBe("agy");
    expect(integrationInstallCommand("codex")).toBe(
      "herdr integration install codex",
    );
    expect(integrationInstallCommand("agy")).toBe(
      "herdr integration install antigravity-cli",
    );
  });

  test("extracts text while ignoring tool and thinking payloads", () => {
    expect(
      textFromContent([
        { type: "text", text: "hello" },
        { type: "tool_use", text: "ignored" },
        { content: [{ type: "text", text: "world" }] },
      ]),
    ).toBe("hello\nworld");
  });

  test("cleans command wrapper noise from user messages", () => {
    expect(
      cleanMessageText(
        "<command-name>cmd</command-name>\nhello\n<local-command-stdout>noise</local-command-stdout>",
      ),
    ).toBe("hello");
    expect(cleanMessageText("[Request interrupted by user]")).toBe("");
  });

  test("parses common timestamp formats with deterministic fallback", () => {
    expect(
      timestampMs({ timestamp: "2026-07-07T00:00:00.000Z" }, 1000, 2),
    ).toBe(Date.parse("2026-07-07T00:00:00.000Z"));
    expect(timestampMs({ created_at: 1_700_000_000 }, 1000, 2)).toBe(
      1_700_000_000_000,
    );
    expect(timestampMs({ time: 1_700_000_000_123 }, 1000, 2)).toBe(
      1_700_000_000_123,
    );
    expect(timestampMs({ ts: "2026-07-07T00:00:01.000Z" }, 1000, 2)).toBe(
      Date.parse("2026-07-07T00:00:01.000Z"),
    );
    expect(timestampMs({}, 1000, 2)).toBe(1002);
  });
});
