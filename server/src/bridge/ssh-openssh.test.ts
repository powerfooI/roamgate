import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sshCommandArgv, sshMasterArgv } from "./ssh-command";
import {
  registerSshMaster,
  SSH_SESSION_LIMIT,
  unregisterSshMaster,
} from "./ssh-sessions";

// These tests check the argv contract against real processes: `ssh -G` for
// how OpenSSH resolves the options, and a fake ssh first on PATH for the
// retry and session limit around real child processes.

const directories: string[] = [];
const owners: object[] = [];

afterEach(() => {
  for (const owner of owners.splice(0)) unregisterSshMaster(owner);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory() {
  const directory = mkdtempSync("/tmp/rg-openssh-test-");
  directories.push(directory);
  return directory;
}

const realSsh = Bun.which("ssh");

/** OpenSSH's resolved options for argv, ignoring the user's ssh config. */
async function resolvedOptions(argv: string[]): Promise<Map<string, string>> {
  const proc = Bun.spawn(["ssh", "-F", "/dev/null", "-G", ...argv.slice(1)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const options = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) options.set(line.slice(0, space), line.slice(space + 1));
  }
  return options;
}

describe.skipIf(!realSsh || process.platform === "win32")(
  "OpenSSH resolves the command argv (ssh -G)",
  () => {
    test("a cold command uses no control socket", async () => {
      const options = await resolvedOptions(sshCommandArgv("dev-box", "true"));
      // ssh -G omits ControlPath when it is none.
      expect(options.has("controlpath")).toBeFalse();
      expect(options.get("controlmaster")).toBe("false");
      expect(options.get("batchmode")).toBe("yes");
    });

    test("-S overrides the ControlPath=none policy for a multiplexed command", async () => {
      const directory = tempDirectory();
      const controlPath = join(directory, "m.ctl");
      writeFileSync(controlPath, "");
      const owner = {};
      owners.push(owner);
      registerSshMaster(owner, {
        destination: "dev-box",
        controlPath,
        isListening: () => true,
        isAlive: async () => true,
      });
      const argv = sshCommandArgv("dev-box", "true");
      expect(argv).toContain("-S");
      const options = await resolvedOptions(argv);
      expect(options.get("controlpath")).toBe(controlPath);
      // A client of the master, never a master itself.
      expect(options.get("controlmaster")).toBe("false");
      expect(options.get("controlpersist")).toBe("no");
    });

    test("-M makes the master argv a master despite ControlMaster=no", async () => {
      const controlPath = join(tempDirectory(), "m.ctl");
      const options = await resolvedOptions(
        sshMasterArgv("dev-box", controlPath),
      );
      expect(options.get("controlmaster")).toBe("true");
      expect(options.get("controlpath")).toBe(controlPath);
    });
  },
);

// Logs each run as "start|end <mux|cold> <command>". A command named "hold"
// waits for the release file. A multiplexed run exits 255 with nothing on
// stderr once the dead-master marker exists, as a mux client whose master
// went away does.
const FAKE_SSH = `#!/bin/sh
mode=cold
last=
for arg in "$@"; do
  [ "$arg" = "-S" ] && mode=mux
  last="$arg"
done
echo "start $mode $last" >> "$FAKE_SSH_LOG"
if [ "$last" = hold ]; then
  while [ ! -e "$FAKE_SSH_RELEASE" ]; do sleep 0.02; done
fi
echo "end $mode $last" >> "$FAKE_SSH_LOG"
if [ "$mode" = mux ] && [ -e "$FAKE_SSH_MASTER_DEAD" ]; then exit 255; fi
echo "ran $mode"
`;

/**
 * Runs `scenario` in a child Bun whose PATH starts with the fake ssh: Bun
 * resolves a spawned program against the PATH it started with.
 */
function runWithFakeSsh(scenario: string) {
  const directory = tempDirectory();
  const bin = join(directory, "bin");
  const fakeSsh = join(bin, "ssh");
  mkdirSync(bin);
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  const paths = {
    log: join(directory, "ssh.log"),
    release: join(directory, "release"),
    masterDead: join(directory, "master-dead"),
    controlPath: join(directory, "m.ctl"),
  };
  writeFileSync(paths.log, "");
  const module = (name: string) => JSON.stringify(join(import.meta.dir, name));
  const driver = `
    import { runProcessWithCodeTimeout } from ${module("../utils/process-utils")};
    import { sshCommandArgv, sshReadCommandArgv } from ${module("./ssh-command")};
    import { registerSshMaster, SSH_SESSION_LIMIT } from ${module("./ssh-sessions")};
    import { writeFileSync } from "node:fs";
    const [scenario, controlPath, masterDead] = process.argv.slice(-3);
    if (scenario !== "cap") {
      writeFileSync(controlPath, "");
      writeFileSync(masterDead, "");
      registerSshMaster({}, {
        destination: "dev-box",
        controlPath,
        isListening: () => true,
        isAlive: async () => false,
      });
    }
    let results;
    if (scenario === "read") {
      results = [await runProcessWithCodeTimeout(sshReadCommandArgv("dev-box", "cat"), 5000)];
    } else if (scenario === "write") {
      results = [await runProcessWithCodeTimeout(sshCommandArgv("dev-box", "rm"), 5000)];
    } else {
      results = await Promise.all(
        Array.from({ length: SSH_SESSION_LIMIT + 2 }, () =>
          runProcessWithCodeTimeout(sshCommandArgv("dev-box", "hold"), 20000),
        ),
      );
    }
    console.log(JSON.stringify(results.map(({ code, stdout }) => ({ code, stdout }))));
  `;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      driver,
      scenario,
      paths.controlPath,
      paths.masterDead,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_SSH_LOG: paths.log,
        FAKE_SSH_RELEASE: paths.release,
        FAKE_SSH_MASTER_DEAD: paths.masterDead,
      },
    },
  );
  const results = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout) as Array<{ code: number; stdout: string }>;
  });
  const log = () => readFileSync(paths.log, "utf8").split("\n").filter(Boolean);
  return { results, log, release: () => writeFileSync(paths.release, "") };
}

describe.skipIf(process.platform === "win32")(
  "SSH commands as real child processes (fake ssh on PATH)",
  () => {
    test("a read whose master died reruns once cold", async () => {
      const run = runWithFakeSsh("read");
      expect(await run.results).toEqual([{ code: 0, stdout: "ran cold\n" }]);
      expect(run.log()).toEqual([
        "start mux cat",
        "end mux cat",
        "start cold cat",
        "end cold cat",
      ]);
    });

    test("a write whose master died reports 255 and never runs twice", async () => {
      const run = runWithFakeSsh("write");
      expect(await run.results).toEqual([{ code: 255, stdout: "" }]);
      expect(run.log()).toEqual(["start mux rm", "end mux rm"]);
    });

    test("runs at most SSH_SESSION_LIMIT ssh processes per destination", async () => {
      const run = runWithFakeSsh("cap");
      const starts = () =>
        run.log().filter((line) => line.startsWith("start")).length;
      for (let i = 0; i < 500 && starts() < SSH_SESSION_LIMIT; i++) {
        await Bun.sleep(10);
      }
      expect(starts()).toBe(SSH_SESSION_LIMIT);
      // Give a ninth process the chance to start if the limit leaked.
      await Bun.sleep(300);
      expect(starts()).toBe(SSH_SESSION_LIMIT);
      run.release();
      const results = await run.results;
      expect(results).toHaveLength(SSH_SESSION_LIMIT + 2);
      expect(results.every((result) => result.code === 0)).toBeTrue();
      let live = 0;
      let most = 0;
      for (const line of run.log()) {
        live += line.startsWith("start") ? 1 : -1;
        most = Math.max(most, live);
      }
      expect(most).toBe(SSH_SESSION_LIMIT);
    });
  },
);
