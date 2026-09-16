import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import legacyDefinitions from "./service-legacy-definitions.test.json";
import { tmpdir } from "node:os";
import {
  runServiceCommand as runServiceCommandWithLegacyCheck,
  queryWindowsTask,
  SERVICE_COMMAND_CONTINUE,
} from "./service-manager";
import {
  renderLaunchdService,
  renderSystemdService,
  renderWindowsTaskDefinition,
  resolveServicePaths,
  resolveLegacyServicePaths,
  escapeSystemdExecPath,
} from "./service-definitions";

// Existing lifecycle cases model a host without legacy services. Dedicated
// migration cases below exercise the real preflight command/error paths.
function runServiceCommand(
  args: string[],
  dependencies: Parameters<typeof runServiceCommandWithLegacyCheck>[1] = {},
) {
  return runServiceCommandWithLegacyCheck(args, {
    ...dependencies,
    runCommand: (argv, options) => {
      if (argv.includes("herdr-gui.service")) return 4;
      if (
        argv[0] === "launchctl" &&
        argv[1] === "print" &&
        /^gui\/\d+$/.test(argv[2] ?? "")
      )
        return 0;
      if (argv.join(" ").includes("dev.herdr.herdr-gui"))
        return argv[0] === "powershell.exe" ? 3 : 113;
      if (!dependencies.runCommand)
        throw new Error("native commands must be mocked");
      return dependencies.runCommand(argv, options);
    },
  });
}

const tempDirs: string[] = [];

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "roamgate-service-"));
  tempDirs.push(path);
  return path;
}

// Golden templates captured from tag v0.7.0, independent of current renderers.
function publishedLegacyDefinition(
  platform: keyof typeof legacyDefinitions,
  homeDir: string,
  binary = join(homeDir, "roamgate"),
): string {
  const paths = resolveLegacyServicePaths(platform, homeDir);
  const values: Record<string, string> = {
    BINARY_PATH: resolve(binary),
    CONFIG_PATH: paths.config,
    TASK_NAME: paths.taskName ?? "",
    STDOUT_PATH: join(homeDir, "Library", "Logs", "herdr-gui.stdout.log"),
    STDERR_PATH: join(homeDir, "Library", "Logs", "herdr-gui.stderr.log"),
  };
  return legacyDefinitions[platform].replace(
    /BINARY_PATH|CONFIG_PATH|TASK_NAME|STDOUT_PATH|STDERR_PATH/g,
    (key) => {
      const value = values[key];
      if (platform === "systemd") return escapeSystemdExecPath(value);
      if (platform === "windows-task") return value.replaceAll("'", "''");
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
    },
  );
}

function isWindowsTaskQuery(argv: string[]): boolean {
  const script = argv.at(-1) ?? "";
  return (
    argv[0] === "powershell.exe" &&
    argv.includes("-Command") &&
    script.includes("CmdletizationQuery_NotFound_TaskName") &&
    script.includes("$taskInfo.State -eq 'Running'")
  );
}

function isWindowsTaskWait(argv: string[]): boolean {
  const script = argv.at(-1) ?? "";
  return (
    argv[0] === "powershell.exe" &&
    argv.includes("-Command") &&
    script.includes("Get-ScheduledTask") &&
    script.includes("AddSeconds(15)")
  );
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

test("Windows task queries distinguish registration from running state", () => {
  for (const [code, expected] of [
    [0, { status: "exists", active: true }],
    [4, { status: "exists", active: false }],
    [3, { status: "missing" }],
    [5, { status: "error", code: 5 }],
  ] as const) {
    expect(
      queryWindowsTask("Herdr's task", (argv) => {
        const script = argv.at(-1)!;
        expect(script).toContain("-TaskName 'Herdr''s task'");
        expect(script).toContain(
          "if ($taskInfo.State -eq 'Running') { exit 0 }; exit 4",
        );
        return code;
      }),
    ).toEqual(expected);
  }
});

describe("service definition rendering", () => {
  test("escapes systemd paths without quoting them", () => {
    const definition = renderSystemdService(
      "/opt/Herdr % GUI/roamgate",
      "/srv/herdr gui/config/roamgate.env",
    );

    expect(definition).toContain(
      "EnvironmentFile=-/srv/herdr\\x20gui/config/roamgate.env",
    );
    expect(definition).not.toContain('EnvironmentFile="');
    expect(definition).toContain(
      "ExecStart=/opt/Herdr\\x20%%\\x20GUI/roamgate",
    );
    expect(definition).not.toContain('ExecStart="');
    expect(definition).toContain("Restart=always");
  });

  test("passes launchd paths as arguments without interpolating shell code", () => {
    const definition = renderLaunchdService("/Applications/Herdr & GUI", {
      config: "/srv/herdr & gui/config/roamgate.env",
      definition: "/unused.plist",
      stdoutLog: "/srv/herdr & gui/logs/out.log",
      stderrLog: "/srv/herdr & gui/logs/error.log",
    });

    expect(definition).toContain(
      "<string>/Applications/Herdr &amp; GUI</string>",
    );
    expect(definition).toContain(
      "<string>/srv/herdr &amp; gui/config/roamgate.env</string>",
    );
    expect(definition).toContain("<key>KeepAlive</key>");
    expect(definition).not.toContain("RESTART_SUPERVISOR");
    expect(definition).toContain("exec &quot;$2&quot;");
  });

  test("renders a direct-executable Windows login task", () => {
    const definition = renderWindowsTaskDefinition(
      "C:\\Program Files\\Herdr's GUI\\roamgate.exe",
      {
        config: "C:\\Users\\tester\\AppData\\Roaming\\roamgate\\roamgate.env",
        definition: "C:\\unused.ps1",
        taskName: "dev.roamgate-test-user",
      },
    );

    expect(definition.charCodeAt(0)).toBe(0xfeff);
    expect(definition).toContain(
      "New-ScheduledTaskAction -Execute 'C:\\Program Files\\Herdr''s GUI\\roamgate.exe'",
    );
    expect(definition).toContain(
      'service run "C:\\Users\\tester\\AppData\\Roaming\\roamgate\\roamgate.env"',
    );
    expect(definition).toContain("$taskName = 'dev.roamgate-test-user'");
    expect(definition).toContain("-AllowStartIfOnBatteries");
    expect(definition).toContain("Generated by roamgate service install.");
  });

  test("isolates Windows task names by user config directory", () => {
    const first = resolveServicePaths(
      "windows-task",
      "C:\\Users\\first",
      "C:\\Users\\first\\AppData\\Roaming",
    );
    const second = resolveServicePaths(
      "windows-task",
      "C:\\Users\\second",
      "C:\\Users\\second\\AppData\\Roaming",
    );

    expect(first.taskName).toStartWith("dev.roamgate-");
    expect(first.taskName).not.toBe(second.taskName);
  });
});

describe("service commands", () => {
  test("installs and starts a systemd user service", () => {
    if (process.platform === "win32") return;
    const homeDir = tempHome();
    const commands: Array<{ argv: string[]; quiet: boolean }> = [];
    const logs: string[] = [];
    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate", "service", "install"],
        uid: 1000,
      },
      runCommand: (argv, options) => {
        commands.push({ argv, quiet: options?.quiet === true });
        return 0;
      },
      getLanIPs: () => ["192.0.2.23"],
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      {
        argv: ["systemctl", "--user", "daemon-reload"],
        quiet: false,
      },
      {
        argv: ["systemctl", "--user", "enable", "roamgate.service"],
        quiet: false,
      },
      {
        argv: ["systemctl", "--user", "restart", "roamgate.service"],
        quiet: false,
      },
    ]);
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    const configPath = join(homeDir, ".config", "roamgate", "roamgate.env");
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "ExecStart=/opt/roamgate-test/bin/roamgate",
    );
    expect(readFileSync(configPath, "utf8")).toContain("HOST=0.0.0.0");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const tokenPath = join(homeDir, ".config", "roamgate", "auth-token");
    const token = readFileSync(tokenPath, "utf8").trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("Installed systemd service");
    expect(logs.join("\n")).toContain(`Login token: ${token}`);
    expect(logs.join("\n")).toContain(
      `Open: http://localhost:8787/?token=${token}`,
    );
    expect(logs.join("\n")).toContain(
      `LAN: http://192.0.2.23:8787/?token=${token}`,
    );
  });

  test("reloads the systemd definition before restarting", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/bin/true\n");
    const commands: string[][] = [];

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate", "service", "reload"],
      },
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", "roamgate.service"],
    ]);
  });

  test("does not restart systemd when daemon-reload fails", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/bin/true\n");
    let commandCount = 0;

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate", "service", "reload"],
      },
      runCommand: () => {
        commandCount += 1;
        return 5;
      },
    });

    expect(code).toBe(5);
    expect(commandCount).toBe(1);
  });

  test("reports a missing service definition during reload", () => {
    const errors: string[] = [];
    let commandCount = 0;

    const code = runServiceCommand(["service", "reload"], {
      runtime: {
        platform: "linux",
        homeDir: tempHome(),
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate", "service", "reload"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(commandCount).toBe(0);
    expect(errors.join("\n")).toContain(
      "cannot reload missing systemd service",
    );
  });

  test("preserves an existing environment file during reinstall", () => {
    const homeDir = tempHome();
    const configPath = join(homeDir, ".config", "roamgate", "roamgate.env");
    mkdirSync(join(homeDir, ".config", "roamgate"), { recursive: true });
    writeFileSync(configPath, "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=secret\n");
    chmodSync(configPath, 0o644);

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/usr/local/bin/roamgate",
        argv: ["/usr/local/bin/roamgate", "service", "install"],
      },
      runCommand: () => 0,
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(
      "HOST=0.0.0.0\nHERDR_GUI_PASSWORD=secret\n",
    );
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(homeDir, ".config", "roamgate", "auth-token"))).toBe(
      false,
    );
  });

  test("preserves a managed custom wrapper command", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    const binaryPath = join(homeDir, ".local", "bin", "roamgate");
    const wrapperPath = join(homeDir, ".local", "libexec", "service-wrapper");
    const wrapperCommand =
      `${wrapperPath} --service example -- ` + `${binaryPath} --host 0.0.0.0`;
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(
      definitionPath,
      `# Generated by roamgate service install.\n` +
        `[Service]\nExecStart=${wrapperCommand}\n`,
    );
    const logs: string[] = [];

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: binaryPath,
        argv: [binaryPath, "service", "install"],
      },
      runCommand: () => 0,
      getLanIPs: () => [],
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    const definition = readFileSync(definitionPath, "utf8");
    expect(definition).toContain(`ExecStart=${wrapperCommand}`);
    expect(definition).toContain("Restart=always");
    expect(logs).toContain(`Preserved custom ExecStart: ${wrapperCommand}`);
  });

  test("replaces a stale custom command that does not invoke this binary", () => {
    if (process.platform === "win32") return;
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(
      definitionPath,
      `# Generated by roamgate service install.\n` +
        `[Service]\n` +
        `ExecStart=/usr/local/bin/service-wrapper -- ` +
        `/opt/roamgate-test/bin/roamgate-old\n`,
    );

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate", "service", "install"],
      },
      runCommand: () => 0,
      getLanIPs: () => [],
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "ExecStart=/opt/roamgate-test/bin/roamgate",
    );
  });

  test("refuses to overwrite an unmanaged service without force", () => {
    const homeDir = tempHome();
    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    mkdirSync(join(homeDir, ".config", "systemd", "user"), {
      recursive: true,
    });
    writeFileSync(definitionPath, "[Service]\nExecStart=/custom/wrapper\n");
    const errors: string[] = [];
    let commandCount = 0;

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "linux",
        homeDir,
        execPath: "/usr/local/bin/roamgate",
        argv: ["/usr/local/bin/roamgate", "service", "install"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      log: () => undefined,
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(commandCount).toBe(0);
    expect(readFileSync(definitionPath, "utf8")).toContain("/custom/wrapper");
    expect(errors.join("\n")).toContain("rerun with --force");
  });

  test("validates launchd identity before writing service files", () => {
    const homeDir = tempHome();
    const errors: string[] = [];

    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "darwin",
        homeDir,
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate"],
      },
      runCommand: () => {
        throw new Error("should not run");
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "cannot determine the current user id for launchd",
    );
    expect(() =>
      readFileSync(
        join(homeDir, ".config", "roamgate", "roamgate.env"),
        "utf8",
      ),
    ).toThrow();
    expect(() =>
      readFileSync(
        join(homeDir, "Library", "LaunchAgents", "dev.roamgate.plist"),
        "utf8",
      ),
    ).toThrow();
  });

  test("installs, inspects, restarts, reloads, and removes a launchd agent", () => {
    const homeDir = tempHome();
    const commands: Array<{ argv: string[]; quiet: boolean }> = [];
    const runtime = {
      platform: "darwin",
      homeDir,
      execPath: "/opt/roamgate-test/bin/roamgate",
      argv: ["/opt/roamgate-test/bin/roamgate"],
      uid: 501,
    };
    let launchdLoaded = false;
    const runCommand = (argv: string[], options?: { quiet?: boolean }) => {
      commands.push({ argv, quiet: options?.quiet === true });
      if (argv[1] === "print") return launchdLoaded ? 0 : 1;
      if (argv[1] === "bootstrap") launchdLoaded = true;
      if (argv[1] === "bootout") launchdLoaded = false;
      return 0;
    };

    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "status"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "restart"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "reload"], {
        runtime,
        runCommand,
      }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "uninstall"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);

    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "dev.roamgate.plist",
    );
    expect(() => readFileSync(plistPath, "utf8")).toThrow();
    expect(commands).toEqual([
      {
        argv: ["launchctl", "print", "gui/501/dev.roamgate"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootstrap", "gui/501", plistPath],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.roamgate"],
        quiet: false,
      },
      {
        argv: ["launchctl", "kickstart", "-k", "gui/501/dev.roamgate"],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.roamgate"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootout", "gui/501/dev.roamgate"],
        quiet: false,
      },
      {
        argv: ["launchctl", "bootstrap", "gui/501", plistPath],
        quiet: false,
      },
      {
        argv: ["launchctl", "print", "gui/501/dev.roamgate"],
        quiet: true,
      },
      {
        argv: ["launchctl", "bootout", "gui/501/dev.roamgate"],
        quiet: false,
      },
    ]);
    expect(
      readFileSync(
        join(homeDir, ".config", "roamgate", "roamgate.env"),
        "utf8",
      ),
    ).toContain("HOST=0.0.0.0");
  });

  test("manages a Windows login task", () => {
    const homeDir = tempHome();
    const appDataDir = join(homeDir, "AppData", "Roaming");
    const executable = join(homeDir, "bin", "roamgate.exe");
    const paths = resolveServicePaths("windows-task", homeDir, appDataDir);
    const definitionPath = paths.definition;
    const configPath = paths.config;
    const taskName = paths.taskName!;
    const runtime = {
      platform: "win32",
      homeDir,
      appDataDir,
      execPath: executable,
      argv: [executable],
    };
    const commands: Array<{ argv: string[]; quiet: boolean }> = [];
    let taskExists = false;
    const runCommand = (argv: string[], options?: { quiet?: boolean }) => {
      commands.push({ argv, quiet: options?.quiet === true });
      if (isWindowsTaskQuery(argv)) return taskExists ? 0 : 3;
      if (argv.includes("-File")) taskExists = true;
      if (argv[1] === "/Delete") taskExists = false;
      return 0;
    };

    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);
    const definition = readFileSync(definitionPath, "utf8");
    expect(definition.charCodeAt(0)).toBe(0xfeff);
    expect(definition).toContain(
      `New-ScheduledTaskAction -Execute '${executable}'`,
    );
    expect(definition).toContain(`service run "${configPath}"`);
    expect(readFileSync(configPath, "utf8")).toContain("HOST=0.0.0.0");
    expect(
      readFileSync(join(appDataDir, "roamgate", "auth-token"), "utf8").trim(),
    ).toMatch(/^[a-f0-9]{64}$/);

    expect(
      runServiceCommand(["service", "status"], { runtime, runCommand }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "restart"], { runtime, runCommand }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "reload"], { runtime, runCommand }),
    ).toBe(0);
    expect(
      runServiceCommand(["service", "uninstall"], {
        runtime,
        runCommand,
        log: () => undefined,
      }),
    ).toBe(0);

    expect(isWindowsTaskQuery(commands[0].argv)).toBeTrue();
    expect(commands[0].quiet).toBeFalse();
    expect(commands[0].argv.at(-1)).toContain(taskName);
    expect(commands.find(({ argv }) => argv.includes("-File"))?.argv).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      definitionPath,
    ]);
    expect(commands.filter(({ argv }) => argv.includes("-File"))).toHaveLength(
      2,
    );
    expect(commands.filter(({ argv }) => argv[1] === "/Run")).toHaveLength(3);
    expect(
      commands
        .filter(({ argv }) => argv.includes("/TN"))
        .every(({ argv }) => argv[argv.indexOf("/TN") + 1] === taskName),
    ).toBeTrue();
    expect(commands.some(({ argv }) => isWindowsTaskWait(argv))).toBeTrue();
    expect(commands.some(({ argv }) => argv[1] === "/Delete")).toBeTrue();
    expect(taskExists).toBeFalse();
    expect(existsSync(definitionPath)).toBeFalse();
    expect(existsSync(configPath)).toBeTrue();
  });

  test("uninstalls an inactive Windows task when its helper script is missing", () => {
    const homeDir = tempHome();
    const appDataDir = join(homeDir, "AppData", "Roaming");
    const paths = resolveServicePaths("windows-task", homeDir, appDataDir);
    const taskName = paths.taskName!;
    const commands: string[][] = [];
    let taskExists = true;

    const code = runServiceCommand(["service", "uninstall"], {
      runtime: {
        platform: "win32",
        homeDir,
        appDataDir,
        execPath: join(homeDir, "roamgate.exe"),
        argv: [],
      },
      runCommand: (argv) => {
        commands.push(argv);
        if (isWindowsTaskQuery(argv)) return taskExists ? 4 : 3;
        if (argv[1] === "/Delete") {
          taskExists = false;
          return 1;
        }
        return 0;
      },
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(commands.some((argv) => argv[1] === "/End")).toBeTrue();
    expect(commands.some((argv) => argv[1] === "/Delete")).toBeTrue();
    expect(commands.filter(isWindowsTaskQuery)).toHaveLength(2);
    expect(taskExists).toBeFalse();
    expect(existsSync(paths.definition)).toBeFalse();
    expect(
      commands
        .filter((argv) => argv.includes("/TN"))
        .every((argv) => argv[argv.indexOf("/TN") + 1] === taskName),
    ).toBeTrue();
  });

  test("removes a stale Windows helper when its task is already absent", () => {
    const homeDir = tempHome();
    const appDataDir = join(homeDir, "AppData", "Roaming");
    const paths = resolveServicePaths("windows-task", homeDir, appDataDir);
    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(
      paths.definition,
      "# Generated by roamgate service install.\n",
    );
    const commands: string[][] = [];

    expect(
      runServiceCommand(["service", "uninstall"], {
        runtime: {
          platform: "win32",
          homeDir,
          appDataDir,
          execPath: join(homeDir, "roamgate.exe"),
          argv: [],
        },
        runCommand: (argv) => {
          commands.push(argv);
          return isWindowsTaskQuery(argv) ? 3 : 0;
        },
        log: () => undefined,
      }),
    ).toBe(0);

    expect(commands.filter(isWindowsTaskQuery)).toHaveLength(1);
    expect(commands.some((argv) => argv[1] === "/Delete")).toBeFalse();
    expect(existsSync(paths.definition)).toBeFalse();
  });

  test("propagates Windows task query failures without changing state", () => {
    const homeDir = tempHome();
    const appDataDir = join(homeDir, "AppData", "Roaming");
    const executable = join(homeDir, "roamgate.exe");
    const paths = resolveServicePaths("windows-task", homeDir, appDataDir);
    const runtime = {
      platform: "win32",
      homeDir,
      appDataDir,
      execPath: executable,
      argv: [executable],
    };
    const installCommands: string[][] = [];

    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand: (argv) => {
          installCommands.push(argv);
          return isWindowsTaskQuery(argv) ? 5 : 0;
        },
        log: () => undefined,
      }),
    ).toBe(5);
    expect(installCommands).toHaveLength(1);
    expect(isWindowsTaskQuery(installCommands[0])).toBeTrue();
    expect(existsSync(paths.definition)).toBeFalse();
    expect(existsSync(paths.config)).toBeFalse();

    mkdirSync(dirname(paths.definition), { recursive: true });
    writeFileSync(
      paths.definition,
      "# Generated by roamgate service install.\n",
    );
    const uninstallCommands: string[][] = [];
    expect(
      runServiceCommand(["service", "uninstall"], {
        runtime,
        runCommand: (argv) => {
          uninstallCommands.push(argv);
          return isWindowsTaskQuery(argv) ? 5 : 0;
        },
        log: () => undefined,
      }),
    ).toBe(5);
    expect(uninstallCommands).toHaveLength(1);
    expect(isWindowsTaskQuery(uninstallCommands[0])).toBeTrue();
    expect(existsSync(paths.definition)).toBeTrue();
  });

  test("does not restart when task-state confirmation fails", () => {
    const homeDir = tempHome();
    const executable = join(homeDir, "roamgate.exe");
    const commands: string[][] = [];

    expect(
      runServiceCommand(["service", "restart"], {
        runtime: {
          platform: "win32",
          homeDir,
          appDataDir: join(homeDir, "AppData", "Roaming"),
          execPath: executable,
          argv: [executable],
        },
        runCommand: (argv) => {
          commands.push(argv);
          return isWindowsTaskWait(argv) ? 7 : 0;
        },
      }),
    ).toBe(7);
    expect(commands.some((argv) => argv[1] === "/End")).toBeTrue();
    expect(commands.some(isWindowsTaskWait)).toBeTrue();
    expect(commands.some((argv) => argv[1] === "/Run")).toBeFalse();
  });

  test("loads environment for the direct Windows task process", () => {
    const homeDir = tempHome();
    const configPath = join(homeDir, "roamgate.env");
    writeFileSync(
      configPath,
      [
        "# service environment",
        "HOST=127.0.0.1",
        'export PORT="9123"',
        "HERDR_SESSION=gui-test",
      ].join("\n"),
    );
    const keys = [
      "HOST",
      "PORT",
      "HERDR_SESSION",
      "HERDR_GUI_RESTART_SUPERVISOR",
      "ROAMGATE_RESTART_SUPERVISOR",
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));

    try {
      for (const key of keys) delete process.env[key];
      expect(runServiceCommand(["service", "run", configPath])).toBe(
        SERVICE_COMMAND_CONTINUE,
      );
      expect(process.env.HOST).toBe("127.0.0.1");
      expect(process.env.PORT).toBe("9123");
      expect(process.env.HERDR_SESSION).toBe("gui-test");
      expect(process.env.ROAMGATE_RESTART_SUPERVISOR).toBe("1");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("does not install a development runtime as a service", () => {
    const errors: string[] = [];
    const code = runServiceCommand(["service", "install"], {
      runtime: {
        platform: "darwin",
        homeDir: tempHome(),
        execPath: "/opt/homebrew/bin/bun",
        argv: ["/opt/homebrew/bin/bun", "src/index.ts", "service", "install"],
        uid: 501,
      },
      runCommand: () => {
        throw new Error("should not run");
      },
      error: (message) => errors.push(message),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "service install requires the standalone roamgate binary",
    );
  });

  test("does not bootstrap launchd when stopping the loaded job fails", () => {
    const homeDir = tempHome();
    const runtime = {
      platform: "darwin",
      homeDir,
      execPath: "/opt/roamgate-test/bin/roamgate",
      argv: ["/opt/roamgate-test/bin/roamgate"],
      uid: 501,
    };
    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand: (argv) => (argv[1] === "print" ? 1 : 0),
        log: () => undefined,
      }),
    ).toBe(0);

    let bootstrapCalled = false;
    const code = runServiceCommand(["service", "install"], {
      runtime,
      runCommand: (argv) => {
        if (argv[1] === "print") return 0;
        if (argv[1] === "bootout") return 5;
        if (argv[1] === "bootstrap") bootstrapCalled = true;
        return 0;
      },
      log: () => undefined,
    });

    expect(code).toBe(5);
    expect(bootstrapCalled).toBe(false);
  });

  test("keeps a managed systemd definition when stopping fails", () => {
    const homeDir = tempHome();
    const runtime = {
      platform: "linux",
      homeDir,
      execPath: "/opt/roamgate-test/bin/roamgate",
      argv: ["/opt/roamgate-test/bin/roamgate"],
    };
    expect(
      runServiceCommand(["service", "install"], {
        runtime,
        runCommand: () => 0,
        log: () => undefined,
      }),
    ).toBe(0);

    const definitionPath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      "roamgate.service",
    );
    const code = runServiceCommand(["service", "uninstall"], {
      runtime,
      runCommand: (argv) => (argv.includes("disable") ? 1 : 0),
      log: () => undefined,
    });

    expect(code).toBe(1);
    expect(readFileSync(definitionPath, "utf8")).toContain(
      "Generated by roamgate service install.",
    );
  });

  test("treats uninstall without a managed definition as a no-op", () => {
    let commandCount = 0;
    const logs: string[] = [];
    const code = runServiceCommand(["service", "uninstall"], {
      runtime: {
        platform: "linux",
        homeDir: tempHome(),
        execPath: "/opt/roamgate-test/bin/roamgate",
        argv: ["/opt/roamgate-test/bin/roamgate"],
      },
      runCommand: () => {
        commandCount += 1;
        return 0;
      },
      log: (message) => logs.push(message),
    });

    expect(code).toBe(0);
    expect(commandCount).toBe(0);
    expect(logs.join("\n")).toContain("No managed systemd service found");
  });
});

describe("management after a 0.7.0 in-place update", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const action of ["status", "restart", "reload", "uninstall"]) {
      test(`${platform} ${action} manages the generated legacy service without migrating it`, () => {
        const homeDir = tempHome();
        const servicePlatform =
          platform === "linux"
            ? "systemd"
            : platform === "darwin"
              ? "launchd"
              : "windows-task";
        const legacy = resolveLegacyServicePaths(servicePlatform, homeDir);
        const current = resolveServicePaths(servicePlatform, homeDir);
        mkdirSync(dirname(legacy.definition), { recursive: true });
        mkdirSync(dirname(legacy.config), { recursive: true });
        const definition = publishedLegacyDefinition(servicePlatform, homeDir);
        writeFileSync(legacy.definition, definition);
        writeFileSync(legacy.config, "HOST=127.0.0.1\nPORT=8899\n");
        const tokenPath = join(dirname(legacy.config), "auth-token");
        writeFileSync(tokenPath, "a".repeat(64), { mode: 0o600 });
        const commands: string[][] = [];
        const logs: string[] = [];
        expect(
          runServiceCommandWithLegacyCheck(["service", "install", "--force"], {
            runtime: {
              platform,
              homeDir,
              execPath: join(homeDir, "roamgate"),
              argv: [],
              uid: 501,
            },
            runCommand: () => {
              throw new Error("must not activate a new service");
            },
            error: () => undefined,
          }),
        ).toBe(1);
        const code = runServiceCommandWithLegacyCheck(["service", action], {
          runtime: {
            platform,
            homeDir,
            execPath: join(homeDir, "roamgate"),
            argv: [],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            if (argv.includes("roamgate.service")) return 4;
            if (argv.includes("gui/501/dev.roamgate")) return 113;
            if (
              isWindowsTaskQuery(argv) &&
              argv.at(-1)?.includes(current.taskName!)
            )
              return 3;
            return 0;
          },
          log: (message) => logs.push(message),
        });
        expect(code).toBe(0);
        const last = commands.at(-1)!;
        if (action === "uninstall") {
          expect(
            commands.some(
              (argv) =>
                argv.includes("disable") ||
                argv.includes("bootout") ||
                argv.includes("/Delete"),
            ),
          ).toBeTrue();
          expect(existsSync(legacy.definition)).toBeFalse();
        } else {
          expect(last.join(" ")).toContain("herdr-gui");
          expect(readFileSync(legacy.definition, "utf8")).toBe(definition);
        }
        // Probes may inspect the new identity, but no mutation may target it.
        for (const argv of commands) {
          if (
            argv.includes("status") ||
            argv[1] === "print" ||
            isWindowsTaskQuery(argv)
          )
            continue;
          if (argv.includes("daemon-reload")) continue;
          expect(argv.join(" ")).toContain("herdr-gui");
        }
        expect(readFileSync(legacy.config, "utf8")).toBe(
          "HOST=127.0.0.1\nPORT=8899\n",
        );
        expect(readFileSync(tokenPath, "utf8")).toBe("a".repeat(64));
        expect(existsSync(current.definition)).toBeFalse();
        expect(existsSync(current.config)).toBeFalse();
        expect(logs.join("\n")).toContain("legacy service");
      });
    }
  }
});

describe("legacy management safety", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    const servicePlatform =
      platform === "linux"
        ? "systemd"
        : platform === "darwin"
          ? "launchd"
          : "windows-task";
    for (const state of [
      "both definitions",
      "current loaded",
      "query failure",
      "custom legacy",
      "custom generated identity",
      "custom generated script",
      "another binary",
      "legacy loaded only",
    ]) {
      test(`${platform} refuses ambiguous or unverified management: ${state}`, () => {
        const homeDir = tempHome();
        const legacy = resolveLegacyServicePaths(servicePlatform, homeDir);
        const current = resolveServicePaths(servicePlatform, homeDir);
        let definition = publishedLegacyDefinition(
          servicePlatform,
          homeDir,
          state === "another binary" ? "/other/roamgate" : "/opt/roamgate",
        );
        if (state === "custom legacy") definition = "custom definition";
        if (state === "custom generated identity") {
          definition =
            platform === "linux"
              ? definition.replace("ExecStart=", "ExecStart=/custom/wrapper ")
              : platform === "darwin"
                ? definition.replace(
                    "<string>dev.herdr.herdr-gui</string>",
                    "<string>dev.roamgate</string>",
                  )
                : definition.replace(
                    "$taskName = ",
                    "$taskName = 'custom'; # ",
                  );
        }
        if (state === "custom generated script")
          definition += "\nWrite-Output 'custom command'\n";
        if (state !== "legacy loaded only") {
          mkdirSync(dirname(legacy.definition), { recursive: true });
          writeFileSync(legacy.definition, definition);
        }
        if (state === "both definitions") {
          mkdirSync(dirname(current.definition), { recursive: true });
          writeFileSync(
            current.definition,
            "# Generated by roamgate service install.\n",
          );
        }
        const customized =
          state.startsWith("custom") || state === "another binary";
        for (const action of ["status", "restart", "reload", "uninstall"]) {
          const commands: string[][] = [];
          expect(
            runServiceCommandWithLegacyCheck(["service", action], {
              runtime: {
                platform,
                homeDir,
                execPath: "/opt/roamgate",
                argv: [],
                uid: 501,
              },
              runCommand: (argv) => {
                commands.push(argv);
                if (argv[0] === "launchctl" && argv[2] === "gui/501") return 0;
                if (customized) {
                  if (argv.includes("roamgate.service")) return 4;
                  if (argv.includes("gui/501/dev.roamgate")) return 113;
                  if (
                    isWindowsTaskQuery(argv) &&
                    argv.at(-1)?.includes(current.taskName!)
                  )
                    return 3;
                }
                return state === "query failure" ? 5 : 0;
              },
              log: () => undefined,
              error: () => undefined,
            }),
          ).toBe(1);
          expect(
            commands.every(
              (argv) =>
                argv.includes("status") ||
                argv[1] === "print" ||
                isWindowsTaskQuery(argv),
            ),
          ).toBeTrue();
          if (customized) expect(commands).toHaveLength(0);
          expect(existsSync(legacy.definition)).toBe(
            state !== "legacy loaded only",
          );
          if (state !== "legacy loaded only")
            expect(readFileSync(legacy.definition, "utf8")).toBe(definition);
          expect(existsSync(current.definition)).toBe(
            state === "both definitions",
          );
        }
      });
    }

    test(`${platform} preserves the legacy definition when stopping fails`, () => {
      const homeDir = tempHome();
      const legacy = resolveLegacyServicePaths(servicePlatform, homeDir);
      const current = resolveServicePaths(servicePlatform, homeDir);
      mkdirSync(dirname(legacy.definition), { recursive: true });
      const definition = publishedLegacyDefinition(
        servicePlatform,
        homeDir,
        "/opt/roamgate",
      );
      writeFileSync(legacy.definition, definition);
      const commands: string[][] = [];
      expect(
        runServiceCommandWithLegacyCheck(["service", "uninstall"], {
          runtime: {
            platform,
            homeDir,
            execPath: "/opt/roamgate",
            argv: [],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            if (argv.includes("roamgate.service")) return 4;
            if (argv.includes("gui/501/dev.roamgate")) return 113;
            if (
              isWindowsTaskQuery(argv) &&
              argv.at(-1)?.includes(current.taskName!)
            )
              return 3;
            if (
              argv.includes("disable") ||
              argv.includes("bootout") ||
              isWindowsTaskWait(argv)
            )
              return 7;
            return 0;
          },
          log: () => undefined,
        }),
      ).toBe(7);
      expect(readFileSync(legacy.definition, "utf8")).toBe(definition);
      expect(commands.some((argv) => argv.includes("/Delete"))).toBeFalse();
    });
  }

  test("restores the original systemd definition and permissions if daemon-reload fails", () => {
    const homeDir = tempHome();
    const legacy = resolveLegacyServicePaths("systemd", homeDir);
    const definition = publishedLegacyDefinition(
      "systemd",
      homeDir,
      "/opt/roamgate",
    );
    mkdirSync(dirname(legacy.definition), { recursive: true });
    mkdirSync(dirname(legacy.config), { recursive: true });
    writeFileSync(legacy.definition, definition, { mode: 0o640 });
    writeFileSync(legacy.config, "HOST=127.0.0.1\n");
    const tokenPath = join(dirname(legacy.config), "auth-token");
    writeFileSync(tokenPath, "a".repeat(64));
    for (const throws of [false, true]) {
      expect(
        runServiceCommandWithLegacyCheck(["service", "uninstall"], {
          runtime: {
            platform: "linux",
            homeDir,
            execPath: "/opt/roamgate",
            argv: [],
          },
          runCommand: (argv) => {
            if (argv.includes("roamgate.service")) return 4;
            if (argv.includes("daemon-reload")) {
              expect(existsSync(legacy.definition)).toBeFalse();
              if (throws) throw new Error("daemon-reload failed");
              return 7;
            }
            return 0;
          },
          log: () => undefined,
          error: () => undefined,
        }),
      ).toBe(throws ? 1 : 7);
      expect(readFileSync(legacy.definition, "utf8")).toBe(definition);
      if (process.platform !== "win32")
        expect(statSync(legacy.definition).mode & 0o777).toBe(0o640);
      expect(readFileSync(legacy.config, "utf8")).toBe("HOST=127.0.0.1\n");
      expect(readFileSync(tokenPath, "utf8")).toBe("a".repeat(64));
      expect(
        existsSync(`${legacy.definition}.uninstall-${process.pid}`),
      ).toBeFalse();
    }
  });

  test("refuses symlinked legacy definitions without touching the target", () => {
    if (process.platform === "win32") return;
    const homeDir = tempHome();
    const legacy = resolveLegacyServicePaths("systemd", homeDir);
    const target = join(homeDir, "other.service");
    writeFileSync(target, "# Generated by herdr-gui service install.\n");
    mkdirSync(dirname(legacy.definition), { recursive: true });
    symlinkSync(target, legacy.definition);
    for (const action of ["status", "restart", "reload", "uninstall"]) {
      expect(
        runServiceCommandWithLegacyCheck(["service", action], {
          runtime: {
            platform: "linux",
            homeDir,
            execPath: "/opt/roamgate",
            argv: [],
          },
          runCommand: () => {
            throw new Error("must not call native commands");
          },
          error: () => undefined,
        }),
      ).toBe(1);
      expect(readFileSync(target, "utf8")).toContain("Generated by herdr-gui");
    }
  });

  test("keeps the legacy launchd definition on query errors during uninstall or reload", () => {
    const homeDir = tempHome();
    const legacy = resolveLegacyServicePaths("launchd", homeDir);
    mkdirSync(dirname(legacy.definition), { recursive: true });
    writeFileSync(
      legacy.definition,
      publishedLegacyDefinition("launchd", homeDir, "/opt/roamgate"),
    );
    for (const action of ["uninstall", "reload"]) {
      const commands: string[][] = [];
      expect(
        runServiceCommandWithLegacyCheck(["service", action], {
          runtime: {
            platform: "darwin",
            homeDir,
            execPath: "/opt/roamgate",
            argv: [],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            if (argv[2] === "gui/501/dev.roamgate") return 113;
            return argv[2] === "gui/501/dev.herdr.herdr-gui" ? 5 : 0;
          },
          log: () => undefined,
        }),
      ).toBe(5);
      expect(commands.every((argv) => argv[1] === "print")).toBeTrue();
      expect(existsSync(legacy.definition)).toBeTrue();
    }
  });
});

describe("legacy service activation preflight", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const action of ["install", "restart", "reload"]) {
      test(`refuses an installed legacy ${platform} definition before ${action}, even with force`, () => {
        const homeDir = tempHome();
        const servicePlatform =
          platform === "linux"
            ? "systemd"
            : platform === "darwin"
              ? "launchd"
              : "windows-task";
        const legacy = resolveLegacyServicePaths(servicePlatform, homeDir);
        const current = resolveServicePaths(servicePlatform, homeDir);
        mkdirSync(dirname(legacy.definition), { recursive: true });
        writeFileSync(legacy.definition, "custom old definition");
        const errors: string[] = [];
        let commands = 0;
        const code = runServiceCommandWithLegacyCheck(
          ["service", action, ...(action === "install" ? ["--force"] : [])],
          {
            runtime: {
              platform,
              homeDir,
              execPath: "/opt/roamgate",
              argv: ["/opt/roamgate"],
              uid: 501,
            },
            runCommand: () => {
              commands++;
              return 0;
            },
            error: (message) => errors.push(message),
          },
        );
        expect(code).toBe(1);
        expect(commands).toBe(0);
        expect(existsSync(current.config)).toBeFalse();
        expect(existsSync(current.definition)).toBeFalse();
        expect(readFileSync(legacy.definition, "utf8")).toBe(
          "custom old definition",
        );
        expect(errors.join("\n")).toContain(
          "previous binary's service uninstall",
        );
      });
    }
  }

  for (const platform of ["linux", "darwin", "win32"]) {
    test(`detects loaded legacy ${platform} service without its on-disk definition`, () => {
      const homeDir = tempHome();
      const commands: string[][] = [];
      expect(
        runServiceCommandWithLegacyCheck(["service", "install", "--force"], {
          runtime: {
            platform,
            homeDir,
            execPath: "/opt/roamgate",
            argv: ["/opt/roamgate"],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            return 0;
          },
          error: () => undefined,
        }),
      ).toBe(1);
      expect(commands.at(-1)?.join(" ")).toContain("herdr-gui");
      expect(existsSync(join(homeDir, ".config", "roamgate"))).toBeFalse();
    });
  }

  for (const args of [
    ["service", "install"],
    ["service", "install", "--force"],
    ["service", "restart"],
    ["service", "reload"],
  ]) {
    for (const existing of [false, true]) {
      for (const queryCode of [1, 2, 5]) {
        test(`launchd query error ${queryCode} blocks ${args.join(" ")} with ${existing ? "existing" : "no"} current files`, () => {
          const homeDir = tempHome();
          const current = resolveServicePaths("launchd", homeDir);
          const tokenPath = join(dirname(current.config), "auth-token");
          const files = [current.definition, current.config, tokenPath];
          if (existing) {
            for (const path of files) {
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, "preserve this fixture", { mode: 0o600 });
            }
          }
          const commands: string[][] = [];
          const errors: string[] = [];
          expect(
            runServiceCommandWithLegacyCheck(args, {
              runtime: {
                platform: "darwin",
                homeDir,
                execPath: "/opt/roamgate",
                argv: ["/opt/roamgate"],
                uid: 501,
              },
              runCommand: (argv) => {
                commands.push(argv);
                return argv[2] === "gui/501/dev.herdr.herdr-gui"
                  ? queryCode
                  : 0;
              },
              error: (message) => errors.push(message),
              log: () => undefined,
            }),
          ).toBe(1);
          expect(commands).toEqual([
            ["launchctl", "print", "gui/501"],
            ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
          ]);
          expect(errors.join("\n")).toContain(
            `cannot check legacy launchd service (exit ${queryCode}); no service changes made`,
          );
          for (const path of files) {
            expect(existsSync(path)).toBe(existing);
            if (existing) {
              expect(readFileSync(path, "utf8")).toBe("preserve this fixture");
              expect(statSync(path).mode & 0o777).toBe(0o600);
            }
          }
        });
      }
    }

    test(`confirmed launchd legacy absence permits ${args.join(" ")}`, () => {
      const homeDir = tempHome();
      const current = resolveServicePaths("launchd", homeDir);
      mkdirSync(dirname(current.definition), { recursive: true });
      writeFileSync(
        current.definition,
        renderLaunchdService("/opt/roamgate", current),
      );
      const commands: string[][] = [];
      expect(
        runServiceCommandWithLegacyCheck(args, {
          runtime: {
            platform: "darwin",
            homeDir,
            execPath: "/opt/roamgate",
            argv: ["/opt/roamgate"],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            return argv[2] === "gui/501/dev.herdr.herdr-gui" ? 113 : 0;
          },
          getLanIPs: () => [],
          log: () => undefined,
        }),
      ).toBe(0);
      expect(commands.slice(0, 2)).toEqual([
        ["launchctl", "print", "gui/501"],
        ["launchctl", "print", "gui/501/dev.herdr.herdr-gui"],
      ]);
      expect(commands.at(-1)?.[1]).toBe(
        args[1] === "restart" ? "kickstart" : "bootstrap",
      );
    });

    test(`missing launchd domain blocks ${args.join(" ")} before the service query`, () => {
      const homeDir = tempHome();
      const commands: string[][] = [];
      const errors: string[] = [];
      expect(
        runServiceCommandWithLegacyCheck(args, {
          runtime: {
            platform: "darwin",
            homeDir,
            execPath: "/opt/roamgate",
            argv: ["/opt/roamgate"],
            uid: 501,
          },
          runCommand: (argv) => {
            commands.push(argv);
            return 113;
          },
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
      expect(commands).toEqual([["launchctl", "print", "gui/501"]]);
      expect(errors.join("\n")).toContain("cannot check launchd user domain");
      const current = resolveServicePaths("launchd", homeDir);
      expect(existsSync(current.config)).toBeFalse();
      expect(existsSync(current.definition)).toBeFalse();
    });
  }

  test("unknown legacy Windows query errors refuse activation without replacing files", () => {
    const homeDir = tempHome();
    const errors: string[] = [];
    expect(
      runServiceCommandWithLegacyCheck(["service", "install", "--force"], {
        runtime: {
          platform: "win32",
          homeDir,
          execPath: "/opt/roamgate",
          argv: ["/opt/roamgate"],
        },
        runCommand: () => 1,
        error: (message) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors.join("\n")).toContain("cannot check legacy scheduled task");
    expect(
      existsSync(resolveServicePaths("windows-task", homeDir).config),
    ).toBeFalse();
  });

  test("legacy Windows task hash stays tied to its old per-user config directory", () => {
    const homeDir = tempHome();
    const old = resolveLegacyServicePaths("windows-task", homeDir);
    const current = resolveServicePaths("windows-task", homeDir);
    expect(old.taskName).toStartWith("dev.herdr.herdr-gui-");
    expect(current.taskName).toStartWith("dev.roamgate-");
    expect(old.taskName?.split("-").at(-1)).not.toBe(
      current.taskName?.split("-").at(-1),
    );
  });

  test("after explicit legacy removal install preserves old env and token", () => {
    const homeDir = tempHome();
    const legacy = resolveLegacyServicePaths("systemd", homeDir);
    const current = resolveServicePaths("systemd", homeDir);
    mkdirSync(dirname(legacy.config), { recursive: true, mode: 0o700 });
    writeFileSync(
      legacy.config,
      "HOST=0.0.0.0\nPORT=8899\nHERDR_GUI_LOG_LEVEL=debug\n",
      { mode: 0o600 },
    );
    const token = "a".repeat(64);
    writeFileSync(join(dirname(legacy.config), "auth-token"), `${token}\n`, {
      mode: 0o600,
    });
    const commands: string[][] = [];
    expect(
      runServiceCommandWithLegacyCheck(["service", "install"], {
        runtime: {
          platform: "linux",
          homeDir,
          execPath: "/opt/roamgate",
          argv: ["/opt/roamgate"],
        },
        runCommand: (argv) => {
          commands.push(argv);
          return argv.includes("herdr-gui.service") ? 4 : 0;
        },
        getLanIPs: () => [],
        log: () => undefined,
      }),
    ).toBe(0);
    expect(commands[0]).toEqual([
      "systemctl",
      "--user",
      "--no-pager",
      "status",
      "herdr-gui.service",
    ]);
    expect(commands.at(-1)).toEqual([
      "systemctl",
      "--user",
      "restart",
      "roamgate.service",
    ]);
    expect(readFileSync(current.config, "utf8")).toBe(
      readFileSync(legacy.config, "utf8"),
    );
    expect(
      readFileSync(join(dirname(current.config), "auth-token"), "utf8"),
    ).toBe(`${token}\n`);
    expect(
      readFileSync(join(dirname(legacy.config), "auth-token"), "utf8"),
    ).toBe(`${token}\n`);
  });
});

test("service run honors explicit new and legacy supervisor overrides", () => {
  const homeDir = tempHome();
  const configPath = join(homeDir, "roamgate.env");
  const previousNew = process.env.ROAMGATE_RESTART_SUPERVISOR;
  const previousOld = process.env.HERDR_GUI_RESTART_SUPERVISOR;
  try {
    delete process.env.ROAMGATE_RESTART_SUPERVISOR;
    delete process.env.HERDR_GUI_RESTART_SUPERVISOR;
    writeFileSync(configPath, "HERDR_GUI_RESTART_SUPERVISOR=0\n");
    expect(runServiceCommand(["service", "run", configPath])).toBe(
      SERVICE_COMMAND_CONTINUE,
    );
    expect(process.env.ROAMGATE_RESTART_SUPERVISOR).toBeUndefined();
    expect(process.env.HERDR_GUI_RESTART_SUPERVISOR as string | undefined).toBe(
      "0",
    );
    writeFileSync(
      configPath,
      "HERDR_GUI_RESTART_SUPERVISOR=1\nROAMGATE_RESTART_SUPERVISOR=\n",
    );
    runServiceCommand(["service", "run", configPath]);
    expect(process.env.ROAMGATE_RESTART_SUPERVISOR as string | undefined).toBe(
      "",
    );
  } finally {
    if (previousNew === undefined)
      delete process.env.ROAMGATE_RESTART_SUPERVISOR;
    else process.env.ROAMGATE_RESTART_SUPERVISOR = previousNew;
    if (previousOld === undefined)
      delete process.env.HERDR_GUI_RESTART_SUPERVISOR;
    else process.env.HERDR_GUI_RESTART_SUPERVISOR = previousOld;
  }
});
