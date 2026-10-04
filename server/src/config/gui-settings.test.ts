import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repoSettingsKey,
  workspaceAutoSyncSettingsKey,
  workspaceRepoSettingsKey,
} from "./gui-settings";

test("terminal codec preferences survive a fresh process and default to enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-"));
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const run = async (script: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { readGuiSettings, updateGuiSettings, terminalSurfaceCodecsEnabled } from ${source}; ${script}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, "AppData"),
          ROAMGATE_SETTINGS_PATH: undefined,
          HERDR_GUI_SETTINGS_PATH: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    expect(
      await run(
        `const settings = await readGuiSettings(); console.log(JSON.stringify([terminalSurfaceCodecsEnabled(settings), terminalSurfaceCodecsEnabled(settings, "alpha")]));`,
      ),
    ).toEqual([true, true]);
    expect(
      await run(
        `await updateGuiSettings(s => ({ ...s, custom: { keep: "yes" }, terminal_transport: { "legacy-default": { surface_codecs: false }, alpha: { surface_codecs: false }, beta: { surface_codecs: true } } })); console.log("true");`,
      ),
    ).toBe(true);
    expect(
      await run(
        `const s = await readGuiSettings(); console.log(JSON.stringify([terminalSurfaceCodecsEnabled(s), terminalSurfaceCodecsEnabled(s, "alpha"), terminalSurfaceCodecsEnabled(s, "beta"), terminalSurfaceCodecsEnabled(s, "new"), s.custom.keep]));`,
      ),
    ).toEqual([false, false, true, true, "yes"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit settings paths isolate writes and bypass legacy migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "roamgate-settings-override-"));
  const source = JSON.stringify(import.meta.resolve("./gui-settings"));
  const legacyPath = join(home, ".config", "herdr-gui", "settings.json");
  const defaultPath = join(home, ".config", "roamgate", "settings.json");
  const overridePath = join(home, "isolated", "settings.json");
  const aliasPath = join(home, "alias", "settings.json");
  const legacySettings = JSON.stringify({
    version: 1,
    custom: { legacy: true },
  });
  const run = async (
    currentPath: string | undefined,
    legacyOverride: string | undefined,
    script: string,
  ) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { guiSettingsPath, readGuiSettings, updateGuiSettings } from ${source}; ${script}`,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          APPDATA: join(home, "AppData"),
          ROAMGATE_SETTINGS_PATH: currentPath,
          HERDR_GUI_SETTINGS_PATH: legacyOverride,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    await mkdir(join(home, ".config", "herdr-gui"), { recursive: true });
    await writeFile(legacyPath, legacySettings);
    expect(
      await run(
        overridePath,
        aliasPath,
        `const before = await readGuiSettings(); await updateGuiSettings(s => ({ ...s, custom: { isolated: true } })); console.log(JSON.stringify([guiSettingsPath(), before.custom]));`,
      ),
    ).toEqual([overridePath, {}]);
    expect(JSON.parse(await readFile(overridePath, "utf8")).custom).toEqual({
      isolated: true,
    });
    expect(await readFile(legacyPath, "utf8")).toBe(legacySettings);
    expect(await Bun.file(defaultPath).exists()).toBe(false);
    expect(await Bun.file(aliasPath).exists()).toBe(false);
    expect(
      await run(
        undefined,
        aliasPath,
        `console.log(JSON.stringify(guiSettingsPath()));`,
      ),
    ).toBe(aliasPath);
    expect(
      await run(
        "",
        aliasPath,
        `console.log(JSON.stringify(guiSettingsPath()));`,
      ),
    ).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("settings keys preserve legacy format and isolate connection identities", () => {
  const workspace = {
    worktree: {
      repo_key: "same-repo",
      checkout_path: "/same/checkout",
    },
  };

  expect(repoSettingsKey("same-repo")).toBe("local:same-repo");
  expect(repoSettingsKey("same-repo", undefined, "legacy-default")).toBe(
    "local:same-repo",
  );
  expect(repoSettingsKey("same-repo", "same-host", "legacy-default")).toBe(
    "ssh:same-host:same-repo",
  );

  expect(workspaceRepoSettingsKey(workspace, undefined, "alpha")).toBe(
    "connection:alpha:local:same-repo",
  );
  expect(workspaceRepoSettingsKey(workspace, undefined, "beta")).toBe(
    "connection:beta:local:same-repo",
  );
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "alpha"),
  ).toBe("connection:alpha:ssh:same-host:/same/checkout");
  expect(
    workspaceAutoSyncSettingsKey("/same/checkout", "same-host", "beta"),
  ).toBe("connection:beta:ssh:same-host:/same/checkout");
  expect(repoSettingsKey("same", undefined, "alpha:local:beta")).toBe(
    "connection:alpha%3Alocal%3Abeta:local:same",
  );
});
