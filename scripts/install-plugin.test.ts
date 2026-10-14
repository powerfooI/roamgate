import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("plugin manifest runs system installers and the native executable", () => {
  const manifest = Bun.TOML.parse(
    readFileSync(join(import.meta.dir, "../herdr-plugin.toml"), "utf8"),
  ) as any;
  expect(manifest.min_herdr_version).toBe("0.7.2");
  expect(manifest.build.map((entry: any) => entry.platforms)).toEqual([
    ["linux", "macos"],
    ["windows"],
  ]);
  expect(manifest.build.map((entry: any) => entry.command[0])).toEqual([
    "sh",
    "powershell.exe",
  ]);
  for (const entry of [...manifest.actions, ...manifest.panes]) {
    expect(entry.command).toEqual(["./server/roamgate", "plugin", entry.id]);
  }
});

for (const failure of [
  "none",
  "checksum",
  "metadata",
  "native-command",
  "native-exit",
  "download",
] as const) {
  test(`plugin installer stages a matching native release without Bun: ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate plugin install "));
    roots.push(root);
    const scripts = join(root, "scripts");
    const assets = join(root, "assets");
    const bin = join(root, "bin");
    const server = join(root, "server");
    for (const dir of [scripts, assets, bin, server]) mkdirSync(dir);
    for (const name of ["install-plugin.sh", "install-roamgate.sh"])
      copyFileSync(join(import.meta.dir, name), join(scripts, name));
    writeFileSync(join(root, "herdr-plugin.toml"), 'version = "9.8.7"\n');
    const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
    const packageDir = `roamgate-${platform}`;
    const packagePath = join(assets, packageDir);
    mkdirSync(packagePath);
    writeFileSync(
      join(packagePath, "roamgate"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'roamgate 9.8.7'; exit 0; fi
if [ "$1 $2" = "plugin version" ] && [ "${failure}" != "native-command" ]; then echo 'roamgate 9.8.7'; [ "${failure}" != "native-exit" ]; exit $?; fi
exit 2
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(packagePath, "VERSION"),
      `roamgate ${failure === "metadata" ? "9.8.6" : "9.8.7"} ${platform}\n`,
    );
    const archiveName = `roamgate-v9.8.7-${platform}.tar.xz`;
    const archive = join(assets, archiveName);
    expect(
      Bun.spawnSync(["tar", "-C", assets, "-cJf", archive, packageDir], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      }).exitCode,
    ).toBe(0);
    const digest =
      failure === "checksum"
        ? "0".repeat(64)
        : createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(`${archive}.sha256`, `${digest}  ${archiveName}\n`);
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh
[ "${failure}" != "download" ] || exit 22
while [ "$#" -gt 0 ]; do
 case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac
done
cp "$FIXTURE_ASSETS/\${url##*/}" "$out"
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    writeFileSync(join(server, "roamgate"), "previous binary", { mode: 0o755 });
    const result = Bun.spawnSync(["sh", join(scripts, "install-plugin.sh")], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        FIXTURE_ASSETS: assets,
        ROAMGATE_RELEASE_BASE_URL: "http://127.0.0.1/releases",
        ROAMGATE_VERSION: "ignored",
        ROAMGATE_INSTALL_DIR: join(root, "ignored"),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(
      failure === "none" ? 0 : failure === "download" ? 22 : 1,
    );
    if (failure === "none")
      expect(
        Bun.spawnSync([join(server, "roamgate"), "plugin", "version"])
          .stdout.toString()
          .trim(),
      ).toBe("roamgate 9.8.7");
    else
      expect(readFileSync(join(server, "roamgate"), "utf8")).toBe(
        "previous binary",
      );
    expect(readdirSync(server)).toEqual(["roamgate"]);
    expect(existsSync(join(root, "ignored"))).toBe(false);
  });
}
