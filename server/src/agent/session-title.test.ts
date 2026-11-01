import { describe, expect, test } from "bun:test";
import { extractAgentSessionTitle } from "./session-title";
import type { SessionFile } from "./session-types";

describe("extractAgentSessionTitle", () => {
  const dummyFile: SessionFile = {
    path: "/home/user/.claude/projects/test/session-1.jsonl",
    mtimeMs: 1000,
  };

  describe("claude", () => {
    test("extracts ai-title from transcript records", () => {
      const records = [
        { type: "user", text: "hello" },
        { type: "ai-title", aiTitle: "Refactor Authentication Logic" },
      ];
      expect(extractAgentSessionTitle("claude", dummyFile, records)).toBe(
        "Refactor Authentication Logic",
      );
    });

    test("prioritizes latest ai-title when rewritten multiple times", () => {
      const records = [
        { type: "ai-title", aiTitle: "Initial Draft" },
        { type: "user", text: "now let's do tests" },
        { type: "ai-title", aiTitle: "Writing Authentication Tests" },
      ];
      expect(extractAgentSessionTitle("claude", dummyFile, records)).toBe(
        "Writing Authentication Tests",
      );
    });

    test("prioritizes custom-title when user renames session", () => {
      const records = [
        { type: "ai-title", aiTitle: "Auto Title" },
        { type: "custom-title", customTitle: "Manual Override By User" },
      ];
      expect(extractAgentSessionTitle("claude", dummyFile, records)).toBe(
        "Manual Override By User",
      );
    });

    test("returns null when no title records exist", () => {
      const records = [
        { type: "user", text: "hello" },
        { type: "assistant", text: "world" },
      ];
      expect(extractAgentSessionTitle("claude", dummyFile, records)).toBeNull();
    });

    test("ignores empty or whitespace-only titles", () => {
      const records = [{ type: "ai-title", aiTitle: "   " }];
      expect(extractAgentSessionTitle("claude", dummyFile, records)).toBeNull();
    });
  });

  describe("hermes", () => {
    test("extracts title from Hermes session record", () => {
      const records = [
        { type: "session_start", id: "sess-123" },
        { type: "metadata", title: "Hermes Kanban Worker Fix" },
      ];
      expect(extractAgentSessionTitle("hermes", dummyFile, records)).toBe(
        "Hermes Kanban Worker Fix",
      );
    });

    test("extracts name or custom_title from Hermes record", () => {
      const records = [{ name: "Fixing flaky test" }];
      expect(extractAgentSessionTitle("hermes", dummyFile, records)).toBe(
        "Fixing flaky test",
      );
    });

    test("returns null if no title is found", () => {
      const records = [{ step: 1, command: "ls" }];
      expect(extractAgentSessionTitle("hermes", dummyFile, records)).toBeNull();
    });
  });

  describe("agy", () => {
    test("extracts title from annotations pbtxt file", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const dir = await mkdtemp(join(tmpdir(), "agy-title-test-"));
      try {
        const convDir = join(dir, "conversations");
        const annoDir = join(dir, "annotations");
        mkdirSync(convDir, { recursive: true });
        mkdirSync(annoDir, { recursive: true });

        const sessionId = "session-123";
        const dbPath = join(convDir, `${sessionId}.db`);
        writeFileSync(dbPath, "");
        const pbtxtPath = join(annoDir, `${sessionId}.pbtxt`);
        writeFileSync(pbtxtPath, 'title: "Migrate Database Schema"\n');

        const file: SessionFile = { path: dbPath, mtimeMs: 1000 };
        expect(extractAgentSessionTitle("agy", file, [])).toBe(
          "Migrate Database Schema",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
