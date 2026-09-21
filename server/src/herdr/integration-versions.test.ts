import { expect, test } from "bun:test";
import { enrichIntegrationVersions } from "./integration-versions";

const current = {
  target: "sample_agent",
  label: "Sample Agent",
  command: "sample",
  available: true,
  state: "current",
};
const outdated = { ...current, state: "outdated" };

function cli(stdout: string) {
  return {
    ping: async () => ({ version: "1.2.3" }),
    findBinary: () => "/tmp/herdr-test/herdr",
    run: async (argv: string[], timeout: number) => {
      expect(timeout).toBe(5_000);
      expect(argv).toEqual(
        argv[1] === "--version"
          ? ["/tmp/herdr-test/herdr", "--version"]
          : ["/tmp/herdr-test/herdr", "integration", "status"],
      );
      return {
        code: 0,
        stderr: "",
        stdout: argv[1] === "--version" ? "herdr 1.2.3\n" : stdout,
      };
    },
  };
}

test("CLI supplements missing current/outdated versions without leaking paths or adding targets", async () => {
  const input = {
    type: "integrations",
    integrations: [current, { ...outdated, target: "other" }],
  };
  const result = await enrichIntegrationVersions(
    input,
    cli(
      [
        "sample-agent: current (v3) (/tmp/integration-test/path (copy)/hook.sh)",
        "other: outdated (v1 < v4) (C:\\integration-test\\hook.ps1)",
        "extra: current (v7)",
        "letta (experimental): current (v8)",
      ].join("\r\n"),
    ),
  );
  expect(result).toEqual({
    type: "integrations",
    integrations: [
      { ...current, installed_version: 3 },
      {
        ...outdated,
        target: "other",
        installed_version: 1,
        available_version: 4,
      },
    ],
  });
  expect(input.integrations[0]).not.toHaveProperty("installed_version");
});

test("RPC values take precedence and partial fields must agree with CLI metadata", async () => {
  for (const [fields, expected] of [
    [{ installed_version: 1 }, { installed_version: 1, available_version: 4 }],
    [{ available_version: 4 }, { installed_version: 1, available_version: 4 }],
    [{ installed_version: 2 }, { installed_version: 2 }],
    [{ available_version: 5 }, { available_version: 5 }],
  ]) {
    expect(
      await enrichIntegrationVersions(
        { integrations: [{ ...outdated, ...fields }] },
        cli("sample-agent: outdated (v1 < v4)"),
      ),
    ).toEqual({ integrations: [{ ...outdated, ...expected }] });
  }
});

test("unknown, malformed, duplicated, and inconsistent CLI records do not fabricate versions", async () => {
  for (const stdout of [
    "",
    "sample-agent: not installed",
    "sample-agent: current",
    "sample-agent: current (v-1)",
    "sample-agent: current (v1.5)",
    "sample-agent: current (v9007199254740992)",
    "sample-agent: current (v3)\nsample-agent: current (v4)",
    "sample-agent: current (v3)\nsample_agent: not installed",
    "sample-agent: outdated (v1 < v4)",
    "unknown: current (v3)",
    "x".repeat(65 * 1024),
  ]) {
    const input = { integrations: [current] };
    expect(await enrichIntegrationVersions(input, cli(stdout))).toEqual(input);
  }
  for (const stdout of [
    "sample-agent: outdated (v4 < v1)",
    "sample-agent: outdated (v1 < v1)",
    "sample-agent: outdated (v1 < v9007199254740992)",
  ]) {
    const input = { integrations: [outdated] };
    expect(await enrichIntegrationVersions(input, cli(stdout))).toEqual(input);
  }
});

test("complete, uninstalled, and invalid RPC results do not invoke the CLI", async () => {
  const forbidden = () => {
    throw new Error("unexpected metadata lookup");
  };
  let calls = 0;
  for (const input of [
    null,
    {},
    { integrations: [null] },
    { integrations: [] },
    {
      integrations: [
        { ...current, installed_version: 8, available_version: 2 },
      ],
    },
    {
      integrations: [
        { ...outdated, installed_version: 1, available_version: 4 },
      ],
    },
    { integrations: [{ ...current, state: "not_installed" }] },
  ]) {
    expect(
      await enrichIntegrationVersions(input, {
        ping: async () => {
          calls++;
          return forbidden();
        },
        run: forbidden,
        findBinary: forbidden,
      }),
    ).toBe(input);
  }
  expect(calls).toBe(0);
});

test("unavailable CLI, timeout, nonzero exit, ping failure, and binary mismatch retain the RPC list", async () => {
  const input = { integrations: [current] };
  for (const override of [
    { findBinary: () => null },
    {
      ping: async () => {
        throw new Error("offline");
      },
    },
    { ping: async () => ({ version: undefined }) },
    {
      run: async () => {
        throw new Error("command timed out");
      },
    },
    {
      run: async () => ({ code: 1, stdout: "herdr 1.2.3\n", stderr: "failed" }),
    },
    { run: async () => ({ code: 0, stdout: "herdr 9.9.9\n", stderr: "" }) },
    {
      run: async (argv: string[]) => ({
        code: argv[1] === "--version" ? 0 : 1,
        stdout:
          argv[1] === "--version"
            ? "herdr 1.2.3"
            : "sample-agent: current (v3)",
        stderr: "",
      }),
    },
  ]) {
    expect(
      await enrichIntegrationVersions(input, {
        ...cli("sample-agent: current (v3)"),
        ...override,
      }),
    ).toBe(input);
  }
});

test("SSH lookups stay on their selected host and never fall back to the local CLI", async () => {
  let localLookups = 0;
  const input = { integrations: [outdated] };
  const findBinary = () => {
    localLookups++;
    return "/tmp/herdr-test/herdr";
  };
  const results = await Promise.all(
    ["alpha.example.test", "beta.example.test"].map((sshHost, index) =>
      enrichIntegrationVersions(input, {
        sshHost,
        findBinary,
        ping: async () => ({ version: "1.2.3" }),
        run: async (argv, timeout) => {
          expect(timeout).toBe(5_000);
          expect(argv[0]).toBe("ssh");
          expect(argv).toContain("BatchMode=yes");
          expect(argv).toContain("StrictHostKeyChecking=yes");
          expect(argv.slice(-3, -1)).toEqual(["--", sshHost]);
          expect(argv.at(-1)).toContain(
            '"$bin" --version && "$bin" integration status',
          );
          expect(argv.at(-1)).toContain("$HOME/.local/bin/herdr");
          return {
            code: 0,
            stderr: "",
            stdout: `herdr 1.2.3\nsample-agent: outdated (v${index + 1} < v4)\n`,
          };
        },
      }),
    ),
  );
  expect(results).toEqual(
    [1, 2].map((installed_version) => ({
      integrations: [{ ...outdated, installed_version, available_version: 4 }],
    })),
  );
  for (const output of [
    { code: 255, stdout: "", stderr: "SSH failed" },
    {
      code: 0,
      stdout: "herdr 9.9.9\nsample-agent: outdated (v1 < v4)\n",
      stderr: "",
    },
    {
      code: 0,
      stdout: "login banner\nherdr 1.2.3\nsample-agent: outdated (v1 < v4)\n",
      stderr: "",
    },
  ]) {
    expect(
      await enrichIntegrationVersions(input, {
        sshHost: "alpha.example.test",
        findBinary,
        ping: async () => ({ version: "1.2.3" }),
        run: async () => output,
      }),
    ).toBe(input);
  }
  expect(localLookups).toBe(0);
});
