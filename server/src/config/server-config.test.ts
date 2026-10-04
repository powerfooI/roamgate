import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { runServiceCommand } from "./service-manager";
import { basename, dirname, join, resolve } from "node:path";
import {
  herdrConfigDir,
  nativeSocketPath,
  browserUrlFor,
  loadServerConfig,
  loadServerTls,
  resolveServerLogLevel,
  resolveServerProfile,
  type ServerConfig,
} from "./server-config";

describe("authentication configuration", () => {
  test("compiled authentication reads runtime NODE_ENV instead of the build value", () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-compiled-auth-"));
    try {
      const entry = join(dir, "entry.ts");
      const executable = join(
        dir,
        process.platform === "win32" ? "config.exe" : "config",
      );
      writeFileSync(
        entry,
        `import { loadServerConfig } from ${JSON.stringify(join(import.meta.dir, "server-config.ts"))}; console.log(JSON.stringify(loadServerConfig("test")));`,
      );
      const built = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          "--minify",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          entry,
          "--outfile",
          executable,
        ],
        {
          env: { ...process.env, NODE_ENV: "development" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (built.exitCode !== 0) throw new Error(built.stderr.toString());
      for (const [nodeEnv, host, authRequired] of [
        ["production", "127.0.0.1", true],
        ["development", "127.0.0.1", false],
        ["development", "0.0.0.0", true],
        [undefined, "127.0.0.1", true],
      ] as const) {
        const environment = { ...process.env };
        if (nodeEnv === undefined) delete environment.NODE_ENV;
        else environment.NODE_ENV = nodeEnv;
        const result = Bun.spawnSync(
          [executable, "--host", host, "--password", "compiled-test-password"],
          {
            env: environment,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(result.exitCode).toBe(0);
        const loaded = JSON.parse(result.stdout.toString());
        expect(loaded.authRequired).toBe(authRequired);
        expect(loaded.password).toBe(
          authRequired ? "compiled-test-password" : "",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production requires authentication and persists a token on every listen address", () => {
    const dir = mkdtempSync(join(tmpdir(), "roamgate-auth-config-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: dir,
        APPDATA: dir,
        NODE_ENV: "production",
      };
      delete env.ROAMGATE_PASSWORD;
      delete env.HERDR_GUI_PASSWORD;
      let token: string | undefined;
      for (const host of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) {
        const result = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `import {loadServerConfig} from ${JSON.stringify(join(import.meta.dir, "server-config.ts"))}; process.argv = [process.execPath, "roamgate", "--host", ${JSON.stringify(host)}]; console.log(JSON.stringify(loadServerConfig("test")));`,
          ],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        expect(result.exitCode).toBe(0);
        const config = JSON.parse(result.stdout.toString());
        expect(config.authRequired).toBe(true);
        expect(config.password).toMatch(/^[a-f0-9]{64}$/);
        expect(config.generatedAuthToken).toBe(config.password);
        expect(readFileSync(config.generatedAuthTokenPath, "utf8").trim()).toBe(
          config.password,
        );
        if (token) expect(config.password).toBe(token);
        token = config.password;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["development", "127.0.0.1", false],
    ["development", "localhost", false],
    ["development", "::1", false],
    ["development", "0.0.0.0", true],
    ["development", "::", true],
    ["development", "192.0.2.10", true],
    ["development", "127.0.0.2", true],
    ["development", "::ffff:127.0.0.1", true],
    ["production", "127.0.0.1", true],
    ["production", "localhost", true],
    ["production", "::1", true],
    ["test", "127.0.0.1", true],
    ["test", "localhost", true],
    ["test", "::1", true],
    [undefined, "127.0.0.1", true],
    [undefined, "localhost", true],
    [undefined, "::1", true],
  ] as const)(
    "NODE_ENV=%s HOST=%s requires authentication: %s",
    (nodeEnv, host, authRequired) => {
      const dir = mkdtempSync(join(tmpdir(), "roamgate-auth-config-"));
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: dir,
          APPDATA: dir,
          NODE_ENV: nodeEnv,
        };
        delete env.ROAMGATE_PASSWORD;
        delete env.HERDR_GUI_PASSWORD;
        if (nodeEnv === undefined) delete env.NODE_ENV;
        const result = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `import {loadServerConfig} from ${JSON.stringify(join(import.meta.dir, "server-config.ts"))}; process.argv = [process.execPath, "roamgate", "--host", ${JSON.stringify(host)}]; console.log(JSON.stringify(loadServerConfig("test")));`,
          ],
          { env, stdout: "pipe", stderr: "pipe" },
        );
        expect(result.exitCode).toBe(0);
        const config = JSON.parse(result.stdout.toString());
        expect(config.authRequired).toBe(authRequired);
        if (authRequired) {
          expect(config.password).toMatch(/^[a-f0-9]{64}$/);
          expect(config.generatedAuthToken).toBe(config.password);
        } else {
          expect(config.password).toBe("");
          expect(config.generatedAuthToken).toBeUndefined();
          expect(config.generatedAuthTokenPath).toBeUndefined();
          expect(existsSync(join(dir, ".config", "roamgate"))).toBe(false);
          expect(existsSync(join(dir, "roamgate"))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(["too-short", "a".repeat(1025)])(
    "rejects CLI and environment passwords outside 15..1024 characters",
    (password) => {
      const dir = mkdtempSync(join(tmpdir(), "roamgate-auth-config-"));
      try {
        for (const source of [
          "cli",
          "ROAMGATE_PASSWORD",
          "HERDR_GUI_PASSWORD",
        ]) {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: dir,
            APPDATA: dir,
            NODE_ENV: "production",
          };
          delete env.ROAMGATE_PASSWORD;
          delete env.HERDR_GUI_PASSWORD;
          const args = [process.execPath, "roamgate", "--host", "127.0.0.1"];
          if (source === "cli") args.push("--password", password);
          else env[source] = password;
          const result = Bun.spawnSync(
            [
              process.execPath,
              "-e",
              `import {loadServerConfig} from ${JSON.stringify(join(import.meta.dir, "server-config.ts"))}; process.argv = ${JSON.stringify(args)}; loadServerConfig("test");`,
            ],
            { env, stdout: "pipe", stderr: "pipe" },
          );
          expect(result.exitCode).toBe(2);
          expect(result.stderr.toString()).toContain(
            "at least 15 characters and at most 1024 characters",
          );
          expect(existsSync(join(dir, ".config", "roamgate"))).toBe(false);
          expect(existsSync(join(dir, "roamgate"))).toBe(false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("herdrConfigDir", () => {
  test("uses APPDATA on win32", () => {
    const appData = join("C:", "AppData", "Roaming");
    expect(herdrConfigDir("win32", appData)).toBe(join(appData, "herdr"));
  });

  test("falls back under the home directory on win32 without APPDATA", () => {
    expect(herdrConfigDir("win32", null)).toBe(
      join(homedir(), "AppData", "Roaming", "herdr"),
    );
  });

  test("uses the XDG-style config dir on other platforms", () => {
    expect(herdrConfigDir("darwin")).toBe(join(homedir(), ".config", "herdr"));
    expect(herdrConfigDir("linux")).toBe(join(homedir(), ".config", "herdr"));
  });
});

describe("resolveServerLogLevel", () => {
  test("prefers the CLI value over the environment", () => {
    expect(resolveServerLogLevel("debug", "error")).toBe("debug");
  });

  test("uses the environment and defaults to info", () => {
    expect(resolveServerLogLevel(undefined, "warn")).toBe("warn");
    expect(resolveServerLogLevel(undefined, undefined)).toBe("info");
  });
});

describe("CPU profile configuration", () => {
  test("is opt-in and bounds capture duration", () => {
    expect(resolveServerProfile(false, undefined, undefined)).toBeUndefined();
    expect(resolveServerProfile(true, undefined, undefined)).toMatchObject({
      durationMs: 30_000,
    });
    expect(resolveServerProfile(true, "300", tmpdir())).toEqual({
      durationMs: 300_000,
      directory: resolve(tmpdir()),
    });
    for (const duration of ["", "0", "-1", "301", "NaN", "Infinity", "1.5"])
      expect(() => resolveServerProfile(true, duration, undefined)).toThrow(
        "1 to 300",
      );
    expect(() => resolveServerProfile(true, "30", " ")).toThrow("empty");
  });

  test("loads CLI flags with precedence over environment settings", () => {
    const originalArgs = process.argv;
    const keys = [
      "NODE_ENV",
      "ROAMGATE_PROFILE",
      "ROAMGATE_PROFILE_DURATION",
      "ROAMGATE_PROFILE_DIR",
    ] as const;
    const originalEnv = keys.map((key) => process.env[key]);
    try {
      process.env.NODE_ENV = "production";
      process.env.ROAMGATE_PROFILE = "1";
      process.env.ROAMGATE_PROFILE_DURATION = "45";
      process.env.ROAMGATE_PROFILE_DIR = tmpdir();
      process.argv = [
        process.execPath,
        "roamgate",
        "--host",
        "127.0.0.1",
        "--password",
        "test-password-long",
      ];
      expect(loadServerConfig("test").profile?.durationMs).toBe(45_000);
      process.env.ROAMGATE_PROFILE = "0";
      expect(loadServerConfig("test").profile).toBeUndefined();
      process.argv.push(
        "--profile",
        "--profile-duration",
        "2",
        "--profile-dir",
        tmpdir(),
      );
      expect(loadServerConfig("test").profile?.durationMs).toBe(2_000);
    } finally {
      process.argv = originalArgs;
      keys.forEach((key, i) => {
        if (originalEnv[i] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[i];
      });
    }
  });
});

describe("native TLS", () => {
  test("keeps HTTP by default and rejects incomplete or unreadable TLS settings", () => {
    expect(loadServerTls(undefined, undefined)).toBeUndefined();
    expect(() => loadServerTls("cert.pem", undefined)).toThrow("requires both");
    expect(() => loadServerTls(undefined, "key.pem")).toThrow("requires both");
    expect(() =>
      loadServerTls(
        "/nonexistent-roamgate-test/cert.pem",
        "/nonexistent-roamgate-test/key.pem",
      ),
    ).toThrow("Invalid TLS configuration");
    expect(browserUrlFor("0.0.0.0", 8787)).toBe("http://localhost:8787");
    expect(browserUrlFor("0.0.0.0", 8443, true)).toBe("https://localhost:8443");
    expect(browserUrlFor("192.0.2.10", 8443, true)).toBe(
      "https://192.0.2.10:8443",
    );
    expect(browserUrlFor("2001:db8::1", 8443, true)).toBe(
      "https://[2001:db8::1]:8443",
    );
  });

  test.skipIf(!Bun.which("openssl"))(
    "loads PEM files, honors CLI precedence, and serves trusted HTTPS and WSS",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "roamgate-tls-test-"));
      const cert = join(dir, "cert.pem"),
        key = join(dir, "key.pem");
      const originalArgs = process.argv;
      const originalCert = process.env.ROAMGATE_TLS_CERT;
      const originalKey = process.env.ROAMGATE_TLS_KEY;
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        writeFileSync(
          join(dir, "openssl.cnf"),
          "[req]\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
        );
        const generated = Bun.spawnSync(
          [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-sha256",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-keyout",
            key,
            "-out",
            cert,
            "-config",
            join(dir, "openssl.cnf"),
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        expect(generated.exitCode).toBe(0);
        const tls = loadServerTls(cert, key)!;
        process.env.ROAMGATE_TLS_CERT = "missing-cert.pem";
        process.env.ROAMGATE_TLS_KEY = "missing-key.pem";
        process.argv = [
          process.execPath,
          "roamgate",
          "--host",
          "127.0.0.1",
          "--tls-cert",
          cert,
          "--tls-key",
          key,
          "--password",
          "test-password-long",
        ];
        expect(loadServerConfig("0.0.0").tls).toEqual(tls);
        process.argv = [
          process.execPath,
          "roamgate",
          "--host",
          "127.0.0.1",
          "--password",
          "test-password-long",
        ];
        process.env.ROAMGATE_TLS_CERT = cert;
        process.env.ROAMGATE_TLS_KEY = key;
        expect(loadServerConfig("0.0.0").tls).toEqual(tls);
        if (process.platform !== "win32") {
          const configDir = join(dir, ".config", "roamgate");
          mkdirSync(configDir, { recursive: true });
          writeFileSync(
            join(configDir, "roamgate.env"),
            `HOST=0.0.0.0\nPORT=8443\nROAMGATE_TLS_CERT=${JSON.stringify(cert)}\nROAMGATE_TLS_KEY=${JSON.stringify(key)}\n`,
          );
          const logs: string[] = [];
          expect(
            runServiceCommand(["service", "install"], {
              runtime: {
                platform: "linux",
                homeDir: dir,
                execPath: "/opt/roamgate-test/bin/roamgate",
                argv: ["/opt/roamgate-test/bin/roamgate", "service", "install"],
                uid: 1000,
              },
              runCommand: (argv) =>
                argv.includes("herdr-gui.service") ? 4 : 0,
              getLanIPs: () => ["192.0.2.10"],
              log: (message) => logs.push(message),
            }),
          ).toBe(0);
          expect(
            logs.some((line) =>
              line.startsWith("Open: https://localhost:8443/"),
            ),
          ).toBe(true);
          expect(
            logs.some((line) =>
              line.startsWith("LAN: https://192.0.2.10:8443/"),
            ),
          ).toBe(true);
        }
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          tls,
          fetch(req, server) {
            if (server.upgrade(req)) return;
            return new Response("secure");
          },
          websocket: {
            message(ws, data) {
              ws.send(data);
            },
          },
        });
        let socket: WebSocket | undefined;
        try {
          expect(
            await (
              await fetch(`https://127.0.0.1:${server.port}`, {
                tls: { ca: tls.cert },
              })
            ).text(),
          ).toBe("secure");
          socket = Reflect.construct(WebSocket, [
            `wss://127.0.0.1:${server.port}`,
            { tls: { ca: tls.cert } },
          ]) as WebSocket;
          const echoed = new Promise<string>((resolve, reject) => {
            socket!.onopen = () => socket!.send("hello");
            socket!.onmessage = (event) => resolve(String(event.data));
            socket!.onerror = () => reject(new Error("WSS connection failed"));
          });
          expect(await echoed).toBe("hello");
        } finally {
          socket?.close();
          server.stop(true);
        }
        const otherKey = join(dir, "other-key.pem");
        expect(
          Bun.spawnSync(["openssl", "genrsa", "-out", otherKey, "2048"], {
            stdout: "ignore",
            stderr: "pipe",
          }).exitCode,
        ).toBe(0);
        expect(() => loadServerTls(cert, otherKey)).toThrow(
          "Invalid TLS configuration",
        );
        writeFileSync(key, "not a PEM private key");
        expect(() => loadServerTls(cert, key)).toThrow(
          "Invalid TLS configuration",
        );
        writeFileSync(cert, "not a PEM certificate");
        expect(() => loadServerTls(cert, otherKey)).toThrow(
          "Invalid TLS configuration",
        );
      } finally {
        process.argv = originalArgs;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalCert === undefined) delete process.env.ROAMGATE_TLS_CERT;
        else process.env.ROAMGATE_TLS_CERT = originalCert;
        if (originalKey === undefined) delete process.env.ROAMGATE_TLS_KEY;
        else process.env.ROAMGATE_TLS_KEY = originalKey;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "SSH socket configuration",
  () => {
    function loadSocketConfig(
      args: string[],
      overrides: Record<string, string> = {},
    ): ServerConfig {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(HERDR_|ROAMGATE_)/.test(key),
        ),
      );
      const argv = [
        process.execPath,
        "roamgate",
        "--host",
        "127.0.0.1",
        "--password",
        "test-password-long",
        ...args,
      ];
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import {loadServerConfig} from ${JSON.stringify(join(import.meta.dir, "server-config.ts"))}; process.argv = ${JSON.stringify(argv)}; console.log(JSON.stringify(loadServerConfig("test")));`,
        ],
        {
          env: { ...env, NODE_ENV: "production", TMPDIR: "/tmp", ...overrides },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()) as ServerConfig;
    }

    test("uses stable 12-hex SHA-256 identifiers for each socket kind", () => {
      const args = ["--ssh-host", "alice@example.com", "--session", "work"];
      const first = loadSocketConfig(args);
      const second = loadSocketConfig(args);
      expect(first.socketPath).toBe("/tmp/roamgate-cce73172d55b-control.sock");
      expect(first.clientSocketPath).toBe(
        "/tmp/roamgate-4796b7bb06b9-client.sock",
      );
      expect(second.socketPath).toBe(first.socketPath);
      expect(second.clientSocketPath).toBe(first.clientSocketPath);
      expect(first.hasExplicitSocketPath).toBe(false);
      expect(first.hasExplicitClientSocketPath).toBe(false);
    });

    test("distinguishes hosts, sessions, and the default session", () => {
      const configs = [
        ["--ssh-host", "alice@example.com"],
        ["--ssh-host", "alice@example.com", "--session", "work"],
        ["--ssh-host", "bob@example.com", "--session", "work"],
        ["--ssh-host", "alice@example.com", "--session", "other"],
      ].map((args) => loadSocketConfig(args));
      expect(new Set(configs.map((config) => config.socketPath)).size).toBe(4);
      expect(
        new Set(configs.map((config) => config.clientSocketPath)).size,
      ).toBe(4);
      expect(configs[0].socketPath).toBe(
        "/tmp/roamgate-3c8b63447e14-control.sock",
      );
      expect(configs[0].clientSocketPath).toBe(
        "/tmp/roamgate-d2b2306369cc-client.sock",
      );
    });

    test("separates host and session fields before hashing", () => {
      const first = loadSocketConfig([
        "--ssh-host",
        "host-a",
        "--session",
        "bc",
      ]);
      const second = loadSocketConfig([
        "--ssh-host",
        "host-ab",
        "--session",
        "c",
      ]);
      expect(first.socketPath).not.toBe(second.socketPath);
      expect(first.clientSocketPath).not.toBe(second.clientSocketPath);
    });

    test("keeps long host and session inputs out of socket filenames", () => {
      const config = loadSocketConfig([
        "--ssh-host",
        `${"u".repeat(64)}@${"h".repeat(253)}`,
        "--session",
        "s".repeat(1_000),
      ]);
      for (const [path, kind] of [
        [config.socketPath, "control"],
        [config.clientSocketPath, "client"],
      ]) {
        expect(dirname(path)).toBe("/tmp");
        expect(basename(path)).toMatch(
          new RegExp(`^roamgate-[a-f0-9]{12}-${kind}\\.sock$`),
        );
        expect(basename(path).length).toBe(
          `roamgate-000000000000-${kind}.sock`.length,
        );
        expect(Buffer.byteLength(path)).toBeLessThan(100);
      }
    });

    test.each(["cli", "environment"] as const)(
      "preserves explicit %s socket paths",
      (source) => {
        const socketPath = "/tmp/explicit-control.sock";
        const clientSocketPath = "/tmp/explicit-client.sock";
        const args = ["--ssh-host", "alice@example.com", "--session", "work"];
        if (source === "cli") {
          args.push(
            "--socket-path",
            socketPath,
            "--client-socket-path",
            clientSocketPath,
          );
        }
        const config = loadSocketConfig(args, {
          HERDR_SOCKET_PATH:
            source === "cli" ? "/tmp/ignored-control.sock" : socketPath,
          HERDR_CLIENT_SOCKET_PATH:
            source === "cli" ? "/tmp/ignored-client.sock" : clientSocketPath,
        });
        expect(config.socketPath).toBe(socketPath);
        expect(config.clientSocketPath).toBe(clientSocketPath);
        expect(config.hasExplicitSocketPath).toBe(true);
        expect(config.hasExplicitClientSocketPath).toBe(true);
      },
    );

    test.each([undefined, "work"])(
      "preserves local Herdr socket paths for session %s",
      (session) => {
        const config = loadSocketConfig(session ? ["--session", session] : []);
        const base = session
          ? join(herdrConfigDir(), "sessions", session)
          : herdrConfigDir();
        expect(config.socketPath).toBe(join(base, "herdr.sock"));
        expect(config.clientSocketPath).toBe(join(base, "herdr-client.sock"));
        expect(config.hasExplicitSocketPath).toBe(false);
        expect(config.hasExplicitClientSocketPath).toBe(false);
      },
    );
  },
);

describe("nativeSocketPath", () => {
  test("maps Herdr's Windows socket name onto its named pipe", () => {
    const logical = String.raw`C:\AppData\Roaming\herdr\herdr.sock`;
    const native = String.raw`\\.\pipe\C:\AppData\Roaming\herdr\herdr.sock`;

    expect(nativeSocketPath(logical, "win32")).toBe(native);
    expect(nativeSocketPath(native, "win32")).toBe(native);
    const upperPrefix = String.raw`\\.\PIPE\existing`;
    expect(nativeSocketPath(upperPrefix, "win32")).toBe(upperPrefix);
    expect(nativeSocketPath(logical, "linux")).toBe(logical);
  });
});
