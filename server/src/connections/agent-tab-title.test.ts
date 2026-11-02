import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentTabTitleReader,
  readHermesSessionTitle,
} from "./agent-tab-title";
const folders: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-tab-titles-"));
  folders.push(root);
  process.env.HOME = root;
  await mkdir(join(root, ".hermes"));
  const path = join(root, ".hermes/state.db");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER)",
  );
  db.query("INSERT INTO sessions VALUES (?, ?, ?)").run(
    "older",
    "Correct older title",
    1,
  );
  db.query("INSERT INTO sessions VALUES (?, ?, ?)").run(
    "newer",
    "Other pane title",
    2,
  );
  db.close();
  return { root, path };
}
function fixture(
  agent = "hermes",
  id: string | null = "older",
  remote = false,
) {
  let info: any = {
    agent,
    agent_session: id === null ? null : { agent, kind: "id", value: id },
  };
  let summary: any = null;
  let afterRead: (() => void) | undefined;
  const commands: string[][] = [];
  const reader = createAgentTabTitleReader({
    herdrCall: async (method, params) => {
      expect(method).toBe("agent.get");
      expect(params).toEqual({ target: "p" });
      return { agent: structuredClone(info) };
    },
    readSummary: async () => {
      afterRead?.();
      return summary;
    },
    sshHost: remote ? "fixture-host" : undefined,
    run: async (argv) => {
      commands.push(argv);
      const child = Bun.spawn(["sh", "-c", argv.at(-1)!], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: Buffer.from(stdout), stderr, code };
    },
  });
  return {
    reader,
    commands,
    setInfo: (v: any) => {
      info = v;
    },
    setSummary: (v: any) => {
      summary = v;
    },
    onRead: (f: () => void) => {
      afterRead = f;
    },
  };
}
async function localTitle(root: string, agent: string, id: string) {
  const moduleUrl = new URL("./agent-tab-title.ts", import.meta.url).href;
  const code = `import {createAgentTabTitleReader} from ${JSON.stringify(moduleUrl)};
    const read = createAgentTabTitleReader({
      herdrCall: async () => (${JSON.stringify({ agent: { agent, agent_session: { agent, kind: "id", value: id } } })}),
      readSummary: async () => null,
      run: async () => {throw new Error("Unexpected SSH lookup");}
    });
    console.log(JSON.stringify(await read("p")));`;
  const child = Bun.spawn([process.execPath, "-e", code], {
    env: {
      ...process.env,
      HOME: root,
      ANTIGRAVITY_HOME: join(root, ".gemini/antigravity-cli"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(error);
  return JSON.parse(text);
}
test("Hermes selects the reported id rather than a newer concurrent session", async () => {
  const { root, path } = await home();
  expect(readHermesSessionTitle(path, "older")).toBe("Correct older title");
  expect(readHermesSessionTitle(path, "missing")).toBeNull();
  expect(await localTitle(root, "hermes", "older")).toBe("Correct older title");
});
test("missing or unmatched ids never adopt an unrelated Hermes session", async () => {
  const { root } = await home();
  for (const id of [
    null,
    "missing",
    "../newer",
    "older'; DROP TABLE sessions; --",
  ]) {
    expect(await localTitle(root, "hermes", id ?? "")).toBeNull();
  }
});
test.skipIf(process.platform === "win32")(
  "the actual SSH SQLite command is scoped and read-only",
  async () => {
    const { root, path } = await home();
    const f = fixture("hermes", "older", true);
    expect(await f.reader("p")).toBe("Correct older title");
    expect(f.commands[0]).toContain("fixture-host");
    const missing = fixture("hermes", "missing", true);
    expect(await missing.reader("p")).toBeNull();
    await rm(path);
    expect(await f.reader("p")).toBeNull();
    expect(await Bun.file(join(root, ".hermes/state.db")).exists()).toBe(false);
  },
);
test("Antigravity reads only the reported session annotation and handles escaped titles", async () => {
  const { root } = await home();
  const dir = join(root, ".gemini/antigravity-cli/annotations");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "older.pbtxt"),
    'title: "Correct \\"quoted\\" title"'.replaceAll("\\\\", "\\"),
  );
  await writeFile(join(dir, "newer.pbtxt"), 'title: "Wrong session"');
  expect(await localTitle(root, "agy", "older")).toBe('Correct "quoted" title');
  expect(await localTitle(root, "agy", "missing")).toBeNull();
  if (process.platform !== "win32")
    expect(await fixture("agy", "older", true).reader("p")).toBe(
      'Correct "quoted" title',
    );
});
test("Claude uses the existing bound summary and rejects a different session", async () => {
  const f = fixture("claude");
  f.setSummary({
    session: { kind: "id", value: "older" },
    title: "Bound Claude title",
  });
  expect(await f.reader("p")).toBe("Bound Claude title");
  f.setSummary({
    session: { kind: "id", value: "newer" },
    title: "Wrong pane",
  });
  expect(await f.reader("p")).toBeNull();
});
test("drops a result when the agent session changes while reading its title", async () => {
  const f = fixture("claude");
  f.setSummary({
    session: { kind: "id", value: "older" },
    title: "Stale title",
  });
  f.onRead(() =>
    f.setInfo({
      agent: "claude",
      agent_session: { agent: "claude", kind: "id", value: "newer" },
    }),
  );
  expect(await f.reader("p")).toBeNull();
});
test("uses only this pane's sanitized OSC title when no bound metadata is available", async () => {
  const f = fixture("codex", null);
  f.setInfo({
    agent: "codex",
    terminal_title: "\x1b[31m\u2733 Build UI\x1b[0m\u0007",
  });
  expect(await f.reader("p")).toBe("Build UI");
  f.setInfo({ agent: "codex", terminal_title: "codex" });
  expect(await f.reader("p")).toBeNull();
  f.setInfo({ agent: "codex", terminal_title: "user@host: ~/work" });
  expect(await f.reader("p")).toBeNull();
});
