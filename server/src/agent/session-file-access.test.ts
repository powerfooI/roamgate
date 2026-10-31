import { describe, expect, test } from "bun:test";
import { createAgentSessionFileAccess } from "./session-file-access";

const remotePath = "/srv/herdr-gui-test/sessions/pi-session.jsonl";
const metadata = `42\t1784872800\t${Buffer.from(remotePath).toString("base64")}\t1:42\t1784872800.123:1784872800.456\n`;

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("agent session file access", () => {
  test("reads reported session files through SSH", async () => {
    const commands: string[][] = [];
    const files = createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      async runBinaryProcessWithTimeout(argv) {
        commands.push(argv);
        const command = argv.at(-1) ?? "";
        if (command.includes("head -c")) {
          return {
            code: 0,
            stdout: Buffer.from('{"type":"session"}\n'),
            stderr: "",
          };
        }
        if (command.includes("cat ")) {
          return {
            code: 0,
            stdout: Buffer.from('{"type":"session"}\n{"type":"message"}\n'),
            stderr: "",
          };
        }
        return { code: 0, stdout: Buffer.from(metadata), stderr: "" };
      },
    });

    expect(await files.statFile(remotePath)).toEqual({
      path: remotePath,
      size: 42,
      mtimeMs: 1_784_872_800_000,
      identity: "1:42",
      changeToken: "1784872800.123:1784872800.456",
    });
    expect(await files.readText(remotePath)).toContain('"type":"message"');
    expect(
      new TextDecoder().decode(await files.readPrefix(remotePath, 20)),
    ).toBe('{"type":"session"}\n');
    expect(
      new TextDecoder().decode(
        await new Response(
          await files.readDownloadBody(remotePath),
        ).arrayBuffer(),
      ),
    ).toContain('"type":"message"');
    expect(
      commands.every(
        (command) =>
          command[0] === "ssh" &&
          command.includes("BatchMode=yes") &&
          command.includes("StrictHostKeyChecking=yes") &&
          command.at(-2) === "operator@example.com" &&
          command.at(-3) === "--",
      ),
    ).toBe(true);
  });

  test("returns null when a remote session file is missing", async () => {
    const files = createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      async runBinaryProcessWithTimeout() {
        return { code: 44, stdout: Buffer.alloc(0), stderr: "" };
      },
    });

    expect(await files.statFile(remotePath)).toBeNull();
    expect(await files.findPiSessionById("missing")).toBeNull();
  });

  test("finds a remote Claude session by ID, following linked project folders", async () => {
    const commands: string[] = [];
    const files = createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      async runBinaryProcessWithTimeout(argv) {
        commands.push(argv.at(-1) ?? "");
        return { code: 44, stdout: Buffer.alloc(0), stderr: "" };
      },
    });
    expect(
      await files.findClaudeSessionById("8b7109b8-e5d2-4744-ac9a-9a8c7d2dd3dc"),
    ).toBeNull();
    expect(commands[0]).toContain("find -L ");
    expect(commands[0]).toContain("CLAUDE_CONFIG_DIR");
    // Not a UUID: never put in a command.
    expect(await files.findClaudeSessionById("../x")).toBeNull();
    expect(commands).toHaveLength(1);
  });
});
