import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sshReadCommandArgv } from "./ssh-command";
import {
  registerSshMaster,
  runSshCommand,
  unregisterSshMaster,
} from "./ssh-sessions";

/**
 * A fake `ssh` standing for a host with sshd's MaxSessions at
 * `FAKE_SSH_MAX`: a multiplexed command past it is refused as OpenSSH
 * reports it, then falls back to a login of its own unless its
 * ProxyCommand fails; a session stays open on the host a moment after its
 * client exits, as sshd closes it.
 */
const FAKE_SSH = `#!/bin/sh
state="$FAKE_SSH_STATE"
mux=0; muxonly=0
for a in "$@"; do
  [ "$a" = -S ] && mux=1
  [ "$a" = ProxyCommand=false ] && muxonly=1
done
cold() { echo x >> "$state/cold"; sleep 0.05; echo out; exit 0; }
[ $mux = 1 ] || cold
i=0; slot=
while [ $i -lt "$FAKE_SSH_MAX" ]; do
  if mkdir "$state/s$i" 2>/dev/null; then slot="$state/s$i"; break; fi
  i=$((i+1))
done
if [ -z "$slot" ]; then
  echo x >> "$state/refused"
  echo "mux_client_request_session: session request failed: Session open refused by peer" >&2
  [ $muxonly = 1 ] || cold
  echo "kex_exchange_identification: Connection closed by remote host" >&2
  exit 255
fi
sleep 0.05
echo out
(sleep 0.1; rmdir "$slot") >/dev/null 2>&1 &
exit 0
`;

let directory = "";
const owner = {};

beforeEach(() => {
  directory = mkdtempSync("/tmp/rg-ssh-refused-");
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  for (const dir of [bin, state]) Bun.spawnSync(["mkdir", "-p", dir]);
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  chmodSync(join(bin, "ssh"), 0o755);
  const controlPath = join(directory, "m.ctl");
  writeFileSync(controlPath, "");
  registerSshMaster(owner, {
    destination: "refusing-host",
    controlPath,
    isListening: () => existsSync(controlPath),
    isAlive: async () => true,
  });
});

afterEach(() => {
  unregisterSshMaster(owner);
  rmSync(directory, { recursive: true, force: true });
});

/** Runs argv as the process helpers do, with the fake in place of ssh. */
async function run(argv: string[]) {
  return runSshCommand(argv, async (attempt) => {
    expect(attempt[0]).toBe("ssh");
    const proc = Bun.spawn(
      [join(directory, "bin", "ssh"), ...attempt.slice(1)],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          FAKE_SSH_STATE: join(directory, "state"),
          FAKE_SSH_MAX: "3",
        },
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  });
}

function count(name: string): number {
  const file = join(directory, "state", name);
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).length
    : 0;
}

test("commands a host refuses past its sessions wait and run over the master", async () => {
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      run(sshReadCommandArgv("refusing-host", `read ${i}`)),
    ),
  );
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("");
  }
  // The host refused some (8 slots here, 3 sessions there): each waited
  // and ran over the master again, never logging in on its own.
  expect(count("refused")).toBeGreaterThan(0);
  expect(count("cold")).toBe(0);
}, 20_000);
