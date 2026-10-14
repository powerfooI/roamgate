import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-generator";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./command";
import { runCli } from "./index";
import { renderTerminalQr } from "./qr";
import { createTestCli, type TestCli } from "./test-context";

const TOKEN = "a".repeat(64);
let cli: TestCli;
afterEach(() => cli?.cleanup());

function writeToken(testCli: TestCli) {
  writeFileSync(
    join(testCli.home, ".config", "roamgate", "auth-token"),
    `${TOKEN}\n`,
    {
      mode: 0o600,
    },
  );
}

describe("renderTerminalQr", () => {
  test("draws exactly the library's modules with a quiet zone", () => {
    const text = `http://192.168.1.20:8787/?token=${TOKEN}`;
    const code = qrcode(0, "M");
    code.addData(text, "Byte");
    code.make();
    const size = code.getModuleCount();
    // Strip colors and rebuild the module grid from the half-block glyphs.
    const rows = renderTerminalQr(text)
      .split("\n")
      .map((line) => Array.from(line.replace(/\x1b\[[0-9;]*m/g, "")));
    const grid: boolean[][] = [];
    for (const row of rows) {
      grid.push(row.map((glyph) => glyph === "█" || glyph === "▀"));
      grid.push(row.map((glyph) => glyph === "█" || glyph === "▄"));
    }
    for (let row = -4; row < size + 4; row++) {
      for (let col = -4; col < size + 4; col++) {
        const expected =
          row >= 0 &&
          row < size &&
          col >= 0 &&
          col < size &&
          code.isDark(row, col);
        expect(grid[row + 4][col + 4]).toBe(expected);
      }
    }
  });
});

describe("roamgate url", () => {
  test("prints tokenized local and LAN URLs from the service config", async () => {
    cli = createTestCli();
    cli.writeConfig("HOST=0.0.0.0\nPORT=9100\n");
    writeToken(cli);
    expect(await runCli(["url", "--json"], cli.context)).toBe(EXIT_OK);
    const result = JSON.parse(cli.output.join("\n"));
    expect(result.local).toBe(`http://localhost:9100/?token=${TOKEN}`);
    expect(result.auth).toBe("token");
    expect(Array.isArray(result.lan)).toBe(true);
  });

  test("omits the token for fixed-password services and applies --address", async () => {
    cli = createTestCli();
    cli.writeConfig("ROAMGATE_PASSWORD=correct-horse-battery\n");
    writeToken(cli);
    await runCli(
      ["url", "--json", "--address", "box.tailnet.ts.net"],
      cli.context,
    );
    const result = JSON.parse(cli.output.join("\n"));
    expect(result.local).toBe("http://localhost:8787");
    expect(result.address).toBe("http://box.tailnet.ts.net:8787");
  });

  test("refuses a QR code that only this machine could open", async () => {
    cli = createTestCli();
    cli.writeConfig("HOST=127.0.0.1\n");
    writeToken(cli);
    expect(await runCli(["url", "--qr"], cli.context)).toBe(EXIT_FAILURE);
    expect(cli.errors[0]).toContain("only listens on this machine");
  });

  test("prints a QR code for an explicit address with a token warning", async () => {
    cli = createTestCli();
    cli.writeConfig("HOST=127.0.0.1\n");
    writeToken(cli);
    expect(
      await runCli(["url", "--qr", "--address", "10.0.0.5"], cli.context),
    ).toBe(EXIT_OK);
    expect(cli.output).toContain("QR code opens: http://10.0.0.5:8787");
    expect(cli.output.at(-1)).toContain("contains your login token");
  });

  test("validates options", async () => {
    cli = createTestCli();
    expect(await runCli(["url", "--qr", "--json"], cli.context)).toBe(
      EXIT_USAGE,
    );
    expect(await runCli(["url", "--address", "a/b"], cli.context)).toBe(
      EXIT_USAGE,
    );
  });

  test("the loopback hint is a command that works", async () => {
    cli = createTestCli();
    cli.writeConfig("HOST=127.0.0.1\n");
    await runCli(["url", "--qr"], cli.context);
    const hint = cli.errors.find((line) => line.includes("config set"));
    const command = /`roamgate (config set [^`]+)`/.exec(hint ?? "")?.[1];
    expect(command).toBe("config set HOST=0.0.0.0 --restart");
    expect(await runCli(command!.split(" "), cli.context)).toBe(EXIT_OK);
    expect(readFileSync(cli.configPath, "utf8")).toContain("HOST=0.0.0.0");
  });
});
