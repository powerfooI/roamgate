import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { runServiceCommand } from "./service-manager";
import { join } from "node:path";
import {
  herdrConfigDir,
  nativeSocketPath,
  browserUrlFor,
  loadServerConfig,
  loadServerTls,
  resolveServerLogLevel,
} from "./server-config";

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
      try {
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
        ];
        expect(loadServerConfig("0.0.0").tls).toEqual(tls);
        process.argv = [process.execPath, "roamgate", "--host", "127.0.0.1"];
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
        if (originalCert === undefined) delete process.env.ROAMGATE_TLS_CERT;
        else process.env.ROAMGATE_TLS_CERT = originalCert;
        if (originalKey === undefined) delete process.env.ROAMGATE_TLS_KEY;
        else process.env.ROAMGATE_TLS_KEY = originalKey;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

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
