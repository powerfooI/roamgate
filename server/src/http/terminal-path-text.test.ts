import { describe, expect, test } from "bun:test";
import { terminalPathText } from "./terminal-path-text";

describe("terminal path text", () => {
  test("keeps plain POSIX paths bare", () => {
    expect(terminalPathText("/tmp/img-1-abc.png", "linux")).toBe(
      "/tmp/img-1-abc.png",
    );
  });

  test("single-quotes POSIX paths with spaces or shell characters", () => {
    expect(terminalPathText("/var/folders/My Temp/$x/img.png", "darwin")).toBe(
      "'/var/folders/My Temp/$x/img.png'",
    );
    expect(terminalPathText("/tmp/o'brien/img.png", "linux")).toBe(
      "'/tmp/o'\\''brien/img.png'",
    );
  });

  test("uses forward slashes for Windows paths", () => {
    expect(
      terminalPathText(
        "C:\\Users\\me\\AppData\\Local\\Temp\\roamgate-images-a1\\img.png",
        "win32",
      ),
    ).toBe("C:/Users/me/AppData/Local/Temp/roamgate-images-a1/img.png");
  });

  test("quotes commas instead of treating them as PowerShell argument separators", () => {
    expect(
      terminalPathText("C:\\Users\\John,Doe\\Temp\\img.png", "win32"),
    ).toBe("'C:/Users/John,Doe/Temp/img.png'");
    expect(terminalPathText("/tmp/John,Doe/img.png", "linux")).toBe(
      "'/tmp/John,Doe/img.png'",
    );
  });

  test("single-quotes Windows paths with spaces", () => {
    expect(
      terminalPathText("C:\\Users\\John Doe\\Temp\\img.png", "win32"),
    ).toBe("'C:/Users/John Doe/Temp/img.png'");
  });

  test("double-quotes Windows paths with apostrophes", () => {
    expect(terminalPathText("C:\\Users\\O'Brien\\Temp\\img.png", "win32")).toBe(
      '"C:/Users/O\'Brien/Temp/img.png"',
    );
  });

  test("falls back to PowerShell quoting when both quote styles expand", () => {
    expect(terminalPathText("C:\\Users\\O'B$n\\img.png", "win32")).toBe(
      "'C:/Users/O''B$n/img.png'",
    );
  });

  test.skipIf(process.platform === "win32")(
    "POSIX shell receives each supported path as one unchanged argument",
    () => {
      for (const [path, platform] of [
        ["/tmp/John,Doe/img.png", "linux"],
        ["/tmp/John Doe/img.png", "linux"],
        ["/tmp/O'B$n/img.png", "linux"],
        ["C:\\Users\\John,Doe\\img.png", "win32"],
        ["C:\\Users\\John Doe\\img.png", "win32"],
        ["C:\\Users\\O'Brien\\img.png", "win32"],
      ] as const) {
        const result = Bun.spawnSync([
          "sh",
          "-c",
          `printf '%s\\n' ${terminalPathText(path, platform)}`,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe(
          `${platform === "win32" ? path.replaceAll("\\", "/") : path}\n`,
        );
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    "PowerShell receives comma and quoted paths as one unchanged argument",
    () => {
      const paths = [
        "C:\\Users\\John,Doe\\img.png",
        "C:\\Users\\John Doe\\img.png",
        "C:\\Users\\O'Brien\\img.png",
        "C:\\Users\\O'B$n\\img.png",
        "C:\\Users\\O'B`n\\img.png",
      ];
      const script = paths
        .map(
          (path) =>
            `ConvertTo-Json -Compress -InputObject @(Write-Output ${terminalPathText(path, "win32")})`,
        )
        .join("\n");
      const result = Bun.spawnSync([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ]);
      expect(result.exitCode).toBe(0);
      expect(
        result.stdout
          .toString()
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line)),
      ).toEqual(paths.map((path) => [path.replaceAll("\\", "/")]));
    },
    30_000,
  );
});
