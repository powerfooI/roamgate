import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFileAccess,
  piSessionDirectoryName,
} from "./session-file-access";

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
        if (command.includes("head -c") && !command.includes("known=")) {
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

  // The "host" is this machine: the remote commands run here, through bash.
  function localHost(outputs: number[], keptTextBytes?: number) {
    return createAgentSessionFileAccess({
      sshHost: "operator@example.com",
      shQuote: quote,
      keptTextBytes,
      async runBinaryProcessWithTimeout(argv) {
        const command = (argv.at(-1) ?? "").replace(/^bash -lc /, "");
        const proc = Bun.spawn(["bash", "-c", `eval ${command}`], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = Buffer.from(
          await new Response(proc.stdout).arrayBuffer(),
        );
        outputs.push(stdout.length);
        return {
          code: await proc.exited,
          stdout,
          stderr: await new Response(proc.stderr).text(),
        };
      },
    });
  }

  test("reads again only what was appended to a remote transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-remote-read-"));
    const path = join(dir, "session.jsonl");
    const outputs: number[] = [];
    const files = localHost(outputs);
    try {
      const first = `${'{"text":"\u00e9"}\n'.repeat(1000)}`;
      writeFileSync(path, first);
      expect(await files.readText(path)).toBe(first);
      appendFileSync(path, '{"text":"more"}\n');
      expect(await files.readText(path)).toBe(`${first}{"text":"more"}\n`);
      // The second read fetched the checked end and the new line only.
      expect(outputs[1]).toBeLessThan(5000);
      // Rewritten in place: the end no longer matches, so it is read whole.
      const rewritten = first.replaceAll("\u00e9", "e");
      writeFileSync(path, rewritten);
      expect(await files.readText(path)).toBe(rewritten);
      // A rewrite outside the overlap followed by an append still invalidates
      // the prefix; matching the last 4 KB alone cannot detect this.
      const corrected = "X" + rewritten.slice(1) + '{"text":"after edit"}\n';
      writeFileSync(path, corrected);
      expect(await files.readText(path)).toBe(corrected);
      // Cut shorter: read whole too.
      writeFileSync(path, '{"text":"short"}\n');
      expect(await files.readText(path)).toBe('{"text":"short"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps remote transcripts within its byte budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-remote-budget-"));
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    const outputs: number[] = [];
    // Room for one 6 KB transcript, not two.
    const files = localHost(outputs, 10_000);
    try {
      writeFileSync(a, "a".repeat(6000));
      writeFileSync(b, "b".repeat(6000));
      await files.readText(a);
      await files.readText(b);
      // a was dropped to keep b, so it is read whole again, then kept.
      await files.readText(a);
      expect(outputs[2]).toBeGreaterThan(6000);
      await files.readText(a);
      expect(outputs[3]).toBeLessThan(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a remote Pi directory search names only a safe directory", async () => {
  const commands: string[] = [];
  const files = createAgentSessionFileAccess({
    sshHost: "operator@example.com",
    shQuote: quote,
    async runBinaryProcessWithTimeout(argv) {
      commands.push(argv.at(-1) ?? "");
      return { code: 44, stdout: Buffer.alloc(0), stderr: "" };
    },
  });
  expect(await files.findPiSessionForCwd("/a/$(rm -rf ~)")).toBeNull();
  expect(commands).toEqual([]);
  expect(await files.findPiSessionForCwd("/srv/app")).toBeNull();
  expect(commands[0]).toContain("/sessions/--srv-app--");
});

test("Pi names a directory's sessions after its path", () => {
  expect(piSessionDirectoryName("/home/user/src/my-app.example.com/pi")).toBe(
    "--home-user-src-my-app.example.com-pi--",
  );
  expect(piSessionDirectoryName("relative/path")).toBeNull();
  expect(piSessionDirectoryName('/a/"b')).toBeNull();
  expect(piSessionDirectoryName("/a/$(rm)")).toBeNull();
});
