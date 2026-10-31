import { describe, expect, test } from "bun:test";
import {
  sshCommandArgv,
  sshTunnelArgv,
  validateSshDestination,
} from "./ssh-command";

describe("secure SSH command construction", () => {
  test("accepts only bounded aliases and user@host destinations", () => {
    expect(validateSshDestination("dev-box.example")).toBe("dev-box.example");
    expect(validateSshDestination("operator@dev-box")).toBe("operator@dev-box");
    for (const value of [
      "-oProxyCommand=touch /tmp/pwned",
      "host name",
      "ssh://host",
      "host:2222",
      "user@@host",
      "@host",
      "user@host/path",
      "user@host=bad",
      "user@host,bad",
      "",
      "a".repeat(321),
    ]) {
      expect(() => validateSshDestination(value)).toThrow("OpenSSH alias");
    }
  });

  test("places fixed policy and sentinel before destination and command", () => {
    const argv = sshCommandArgv("operator@dev-box", "printf ok");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("RequestTTY=no");
    expect(argv).toContain("PermitLocalCommand=no");
    expect(argv).toContain("ControlMaster=no");
    // A session that stalls after connecting ends instead of hanging.
    expect(argv).toContain("ServerAliveInterval=10");
    expect(argv).toContain("ServerAliveCountMax=3");
    expect(argv).not.toContain("StrictHostKeyChecking=no");
    expect(argv).not.toContain("UserKnownHostsFile=/dev/null");
    expect(argv.slice(-3)).toEqual(["--", "operator@dev-box", "printf ok"]);
  });

  test("builds explicit stream-local forwards without profile options", () => {
    const argv = sshTunnelArgv("dev-box", [
      { local: "/tmp/a/control.sock", remote: "/remote/control.sock" },
      { local: "/tmp/a/render.sock", remote: "/remote/render.sock" },
    ]);
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("StreamLocalBindMask=0177");
    expect(argv.filter((value) => value.startsWith("ServerAlive"))).toEqual([
      "ServerAliveInterval=10",
      "ServerAliveCountMax=3",
    ]);
    expect(argv.slice(-2)).toEqual(["--", "dev-box"]);
    expect(argv.filter((value) => value === "-L")).toHaveLength(2);
  });
});
