import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAgentSessionFiles } from "./session-file-access";
import {
  createAgentSessionResolverContext,
  resolveAgentSession,
} from "./session-resolver";

const tempDirectories: string[] = [];
const originalHome = process.env.HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalPiDirectory = process.env.PI_CODING_AGENT_DIR;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDirectory;
  if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
  else process.env.PI_CONFIG_DIR = originalPiConfigDir;
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function resolveOmpSessionInFreshProcess(sessionId: string) {
  const resolverUrl = new URL("./session-resolver.ts", import.meta.url).href;
  const filesUrl = new URL("./session-file-access.ts", import.meta.url).href;
  const script = `
    import { resolveAgentSession } from ${JSON.stringify(resolverUrl)};
    import { localAgentSessionFiles } from ${JSON.stringify(filesUrl)};
    const result = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({ agent: { agent: "omp", agent_session: { agent: "omp", kind: "id", value: ${JSON.stringify(sessionId)} } } }),
      localAgentSessionFiles,
    );
    console.log(JSON.stringify({ status: result.status, path: result.path }));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: "",
      XDG_DATA_HOME: "",
    },
  });
  if (child.status !== 0)
    throw new Error(child.stderr || "OMP resolver subprocess failed");
  return JSON.parse(child.stdout.trim()) as { status: string; path: string };
}

describe("agent session resolver context", () => {
  test("keeps session path caches isolated per connection context", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-gui-session-cache-"));
    tempDirectories.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(root, "sessions", "project");
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    const herdrCall = async () => ({
      agent: {
        agent: "pi",
        workspace_id: "w1",
        tab_id: "t1",
        cwd: "/repo",
        agent_session: {
          source: "herdr:pi",
          agent: "pi",
          kind: "id",
          value: sessionId,
        },
      },
    });
    const first = createAgentSessionResolverContext();
    const second = createAgentSessionResolverContext();

    const firstResult = await resolveAgentSession(
      { pane_id: "p1" },
      herdrCall,
      localAgentSessionFiles,
      first,
    );
    expect(firstResult.path).toBe(sessionPath);
    expect(first.pathCache.get(`pi:${sessionId}`)).toBe(sessionPath);
    expect(second.pathCache.size).toBe(0);

    const secondResult = await resolveAgentSession(
      { pane_id: "p1" },
      herdrCall,
      localAgentSessionFiles,
      second,
    );
    expect(secondResult.path).toBe(sessionPath);
    expect(second.pathCache.get(`pi:${sessionId}`)).toBe(sessionPath);
    expect(first.pathCache).not.toBe(second.pathCache);
  });
});

describe("OMP session resolution", () => {
  test("finds ids in the default OMP session directory", async () => {
    delete process.env.PI_CONFIG_DIR;
    const root = await mkdtemp(join(tmpdir(), "roamgate-omp-"));
    tempDirectories.push(root);
    process.env.HOME = root;
    delete process.env.PI_CODING_AGENT_DIR;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(root, ".omp", "agent", "sessions");
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    const result = resolveOmpSessionInFreshProcess(sessionId);
    expect(result.status).toBe("ok");
    expect(result.path).toBe(sessionPath);
  });

  test("finds ids in a configured session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-omp-configured-"));
    tempDirectories.push(root);
    process.env.HOME = root;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(root, "custom-agent", "sessions");
    const sessionPath = join(sessionDirectory, `prefix_${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    process.env.PI_CODING_AGENT_DIR = join(root, "custom-agent");
    const result = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "omp",
          agent_session: { agent: "omp", kind: "id", value: sessionId },
        },
      }),
      localAgentSessionFiles,
      createAgentSessionResolverContext(),
    );
    expect(result.status).toBe("ok");
    expect(result.path).toBe(sessionPath);
  });

  test.each([".omp-custom", "/absolute-omp-custom"])(
    "finds sessions under PI_CONFIG_DIR=%s relative to home",
    async (configDir) => {
      const root = await mkdtemp(join(tmpdir(), "roamgate-omp-config-root-"));
      tempDirectories.push(root);
      process.env.HOME = root;
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.XDG_DATA_HOME;
      process.env.PI_CONFIG_DIR = configDir;
      const sessionId = `session-${crypto.randomUUID()}`;
      const sessionDirectory = join(root, configDir, "agent", "sessions");
      const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(sessionPath, "{}\n");
      const result = resolveOmpSessionInFreshProcess(sessionId);
      expect(result.status).toBe("ok");
      expect(result.path).toBe(sessionPath);
    },
  );

  test("finds ids under a profile agent session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-omp-profile-"));
    tempDirectories.push(root);
    process.env.HOME = root;
    delete process.env.PI_CONFIG_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(
      root,
      ".omp",
      "profiles",
      "test-profile",
      "agent",
      "sessions",
    );
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    const result = resolveOmpSessionInFreshProcess(sessionId);
    expect(result.status).toBe("ok");
    expect(result.path).toBe(sessionPath);
  });

  test("finds ids in the default XDG OMP session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-omp-xdg-"));
    tempDirectories.push(root);
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = join(root, "data");
    delete process.env.PI_CODING_AGENT_DIR;
    const sessionId = `session-${crypto.randomUUID()}`;
    const sessionDirectory = join(root, "data", "omp", "sessions");
    const sessionPath = join(sessionDirectory, `${sessionId}.jsonl`);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(sessionPath, "{}\n");
    const result = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "omp",
          agent_session: { agent: "omp", kind: "id", value: sessionId },
        },
      }),
      localAgentSessionFiles,
      createAgentSessionResolverContext(),
    );
    expect(result.status).toBe("ok");
    expect(result.path).toBe(sessionPath);
  });
  test("uses reported remote transcript paths without local ID discovery", async () => {
    const remotePath =
      "/remote/.omp/profiles/work/agent/sessions/session.jsonl";
    const files = {
      remote: true,
      statFile: async (path: string) => ({
        path,
        mtimeMs: 1,
        size: 1,
        sessionId: null,
      }),
    } as unknown as typeof localAgentSessionFiles;
    const direct = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "omp",
          agent_session: { agent: "omp", kind: "path", value: remotePath },
        },
      }),
      files,
      createAgentSessionResolverContext(),
    );
    expect(direct.status).toBe("ok");
    expect(direct.path).toBe(remotePath);

    const remoteId = `remote-${crypto.randomUUID()}`;
    const byId = await resolveAgentSession(
      { pane_id: "p1" },
      async () => ({
        agent: {
          agent: "omp",
          agent_session: { agent: "omp", kind: "id", value: remoteId },
        },
      }),
      files,
      createAgentSessionResolverContext(),
    );
    expect(byId.status).toBe("missing_file");
    expect(byId.path).toBe("");
  });
});
