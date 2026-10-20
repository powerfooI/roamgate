import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFileAccess,
  localAgentSessionFiles,
} from "./session-file-access";
import {
  createAgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";
import { shQuote } from "../utils/process-utils";

const id = "00000000-0000-4000-8000-000000000001";
const previousHome = process.env.CODEX_HOME;
const roots: string[] = [];

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "codex session's-"));
  roots.push(root);
  process.env.CODEX_HOME = root;
  const directory = join(root, "sessions", "2026", "10", "20");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-20T20-19-45-${id}.jsonl`);
  await writeFile(
    path,
    JSON.stringify({ type: "session_meta", payload: { id, cwd: "/repo" } }) +
      "\n",
  );
  return { root, path };
}

const agent = () => ({
  agent: { agent: "codex", agent_session: { kind: "id", value: id } },
});

describe("Codex transcript lookup", () => {
  test("uses CODEX_HOME, exact IDs and archived sessions", async () => {
    const { root, path } = await setup();
    expect((await localAgentSessionFiles.findCodexSessionById(id))?.path).toBe(
      path,
    );
    await expect(
      localAgentSessionFiles.findCodexSessionById(id.slice(0, 8)),
    ).rejects.toThrow("complete");
    await rm(path);
    const archive = join(root, "archived_sessions");
    await mkdir(archive);
    const archived = join(archive, `rollout-${id}.jsonl`);
    await writeFile(archived, "{}\n");
    expect((await localAgentSessionFiles.findCodexSessionById(id))?.path).toBe(
      archived,
    );
    await writeFile(path, "{}\n");
    await expect(
      localAgentSessionFiles.findCodexSessionById(id),
    ).rejects.toThrow("Multiple");
  });

  test("remote IDs never search or stat local paths", async () => {
    await setup();
    const stats: string[] = [];
    let lookups = 0;
    const files = {
      ...localAgentSessionFiles,
      remote: true,
      async findCodexSessionById() {
        lookups++;
        return { path: "/remote/rollout.jsonl", mtimeMs: 1000 };
      },
      async statFile(path: string) {
        stats.push(path);
        return { path, mtimeMs: 1000 };
      },
    };
    const context = createAgentSessionResolverContext();
    for (let i = 0; i < 2; i++) {
      const result = await resolveAgentSession(
        { pane_id: "p1" },
        async () => agent(),
        files,
        context,
      );
      expect(result.path).toBe("/remote/rollout.jsonl");
    }
    expect(lookups).toBe(1);
    expect(stats).toEqual(["/remote/rollout.jsonl"]);
  });

  test("executes the SSH lookup script with quoted paths and rejects invalid IDs before SSH", async () => {
    const { path } = await setup();
    let calls = 0;
    const files = createAgentSessionFileAccess({
      sshHost: "fixture",
      shQuote,
      async runBinaryProcessWithTimeout(argv) {
        calls++;
        const proc = Bun.spawn(["sh", "-c", argv.at(-1)!], {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, stdout: Buffer.from(stdout), stderr };
      },
    });
    expect((await files.findCodexSessionById(id))?.path).toBe(
      await realpath(path),
    );
    expect(calls).toBe(2);
    await expect(files.findCodexSessionById("$(whoami)")).rejects.toThrow(
      "complete",
    );
    expect(calls).toBe(2);
    await rm(path);
    expect(await files.findCodexSessionById(id)).toBeNull();
  });

  test("missing association does not claim the integration is uninstalled", async () => {
    const result = await resolveAgentSession({ pane_id: "p1" }, async () => ({
      agent: { agent: "codex" },
    }));
    expect(result.status).toBe("missing_session");
    expect(result.detail).toContain("not linked");
    expect(result.command).toBeUndefined();
  });
});
