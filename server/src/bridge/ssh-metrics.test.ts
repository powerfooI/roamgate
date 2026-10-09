import { describe, expect, test } from "bun:test";
import { createLogger } from "../utils/logger";
import { sshCommandArgv } from "./ssh-command";
import { annotateSshArgv, createSshProcessMonitor } from "./ssh-metrics";

function monitorWithClock() {
  const lines: string[] = [];
  let clock = 1000;
  const monitor = createSshProcessMonitor({
    logger: createLogger({
      level: "debug",
      scope: "ssh",
      stdout: (line) => lines.push(line),
      now: () => new Date(0),
    }),
    now: () => clock,
  });
  return {
    monitor,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("ssh process monitor", () => {
  test("logs tag, connection, host, exit code and live children", async () => {
    const { monitor, lines, advance } = monitorWithClock();
    const first = Promise.withResolvers<number>();
    const second = Promise.withResolvers<number>();
    const argv = annotateSshArgv(
      sshCommandArgv("desktop", "git status", [], "git.status"),
      { connection: "conn_1" },
    );
    monitor.track(argv, first.promise, Promise.resolve(""));
    monitor.track(sshCommandArgv("desktop", "true"), second.promise);
    expect(monitor.liveCount()).toBe(2);

    advance(640);
    first.resolve(0);
    await first.promise;
    await Bun.sleep(0);
    expect(monitor.liveCount()).toBe(1);
    expect(lines).toEqual([
      "1970-01-01T00:00:00.000Z DEBUG ssh ssh process exited tag=git.status connection=conn_1 host=desktop code=0 total_ms=640 live_at_start=1 live=1",
    ]);

    second.resolve(255);
    await Bun.sleep(0);
    expect(monitor.liveCount()).toBe(0);
    expect(lines[1]).toContain("tag=untagged");
    expect(lines[1]).toContain("code=255 total_ms=640 live_at_start=2 live=0");
  });

  test("counts sshd startup drops reported on stderr", async () => {
    const { monitor, lines } = monitorWithClock();
    const stderr =
      "kex_exchange_identification: read: Connection reset by peer\r\n";
    monitor.track(
      sshCommandArgv("desktop", "true"),
      Promise.resolve(255),
      Promise.resolve(stderr),
    );
    monitor.track(
      sshCommandArgv("desktop", "true"),
      Promise.resolve(255),
      Promise.resolve("ssh_exchange_identification: Connection closed"),
    );
    monitor.track(
      sshCommandArgv("desktop", "true"),
      Promise.resolve(255),
      Promise.resolve("Permission denied (publickey)."),
    );
    await Bun.sleep(0);
    expect(monitor.startupFailureCount()).toBe(2);
    expect(lines[0]).toContain("startup_failure=true startup_failures=1");
    expect(lines[1]).toContain("startup_failure=true startup_failures=2");
    expect(lines[2]).not.toContain("startup_failure=");
    expect(lines[2]).toContain("startup_failures=2");
  });

  test("ignores other programs and survives failed process promises", async () => {
    const { monitor, lines } = monitorWithClock();
    monitor.track(["git", "status"], Promise.resolve(0));
    expect(monitor.liveCount()).toBe(0);

    monitor.track(
      sshCommandArgv("desktop", "true"),
      Promise.reject(new Error("spawn failed")),
      Promise.reject(new Error("stream failed")),
    );
    await Bun.sleep(0);
    expect(monitor.liveCount()).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code=null");
  });
});
