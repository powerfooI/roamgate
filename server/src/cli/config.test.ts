import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DEFAULT_SERVICE_ENV_FILE } from "../config/service-definitions";
import { parseServiceEnvironment } from "../config/service-manager";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./command";
import {
  configCommand,
  encodeEnvironmentValue,
  updateEnvironmentFile,
} from "./config";
import { runCli } from "./index";
import { createTestCli, type TestCli } from "./test-context";

let cli: TestCli;
afterEach(() => cli?.cleanup());

const update = (contents: string, entries: Record<string, string | null>) =>
  updateEnvironmentFile(contents, new Map(Object.entries(entries)));

describe("updateEnvironmentFile", () => {
  test("replaces the last assignment and drops earlier duplicates", () => {
    expect(update("A=1\n# note\nexport A=2\nB=3\n", { A: "4" })).toBe(
      "# note\nA=4\nB=3\n",
    );
  });

  test("inserts below a commented placeholder, else appends", () => {
    expect(update("# A=example\nB=1\n", { A: "x" })).toBe(
      "# A=example\nA=x\nB=1\n",
    );
    expect(update("B=1", { A: "x" })).toBe("B=1\nA=x\n");
  });

  test("removes every assignment on unset and keeps comments", () => {
    expect(update("# A=example\nA=1\nB=2\nA=3\n", { A: null })).toBe(
      "# A=example\nB=2\n",
    );
  });

  test("keeps CRLF line endings", () => {
    expect(update("A=1\r\nB=2\r\n", { B: "3" })).toBe("A=1\r\nB=3\r\n");
  });

  test("leaves similarly named keys alone", () => {
    expect(update("PORTAL=1\n", { PORT: "2" })).toBe("PORTAL=1\nPORT=2\n");
  });
});

describe("encodeEnvironmentValue", () => {
  test("quotes only when needed", () => {
    expect(encodeEnvironmentValue("/a/b.pem")).toBe("/a/b.pem");
    expect(encodeEnvironmentValue("")).toBe("''");
    expect(encodeEnvironmentValue("a b$c")).toBe("'a b$c'");
    expect(encodeEnvironmentValue("C:\\Users\\me")).toBe("'C:\\Users\\me'");
  });

  test("every service manager reads back exactly the value written", () => {
    for (const value of [
      "plain",
      "two words",
      "it's my long passphrase",
      "$HOME and `cmd`",
      "C:\\Program Files\\x",
      "",
    ]) {
      const line = `KEY=${encodeEnvironmentValue(value)}\n`;
      for (const platform of ["systemd", "launchd", "windows-task"] as const) {
        expect(
          parseServiceEnvironment(line, "/env", platform, "/home/me").KEY,
        ).toBe(value);
      }
    }
    expect(encodeEnvironmentValue("it's")).toBe(`"it's"`);
  });

  test("rejects values no service manager reads identically", () => {
    expect(() => encodeEnvironmentValue("a\nb")).toThrow("single line");
    expect(() => encodeEnvironmentValue(`it's $HOME`)).toThrow(
      "edit the file directly",
    );
  });
});

describe("roamgate config", () => {
  test("set creates the file from the template with private permissions", async () => {
    cli = createTestCli();
    expect(
      await runCli(
        ["config", "set", "PORT=9123", "HOST=127.0.0.1"],
        cli.context,
      ),
    ).toBe(EXIT_OK);
    const contents = readFileSync(cli.configPath, "utf8");
    expect(contents).toContain("HOST=127.0.0.1\nPORT=9123\n");
    expect(contents).toContain("# ROAMGATE_PASSWORD=");
    expect(statSync(cli.configPath).mode & 0o777).toBe(0o600);
  });

  test("rejects invalid values before writing anything", async () => {
    cli = createTestCli();
    expect(await runCli(["config", "set", "PORT=70000"], cli.context)).toBe(
      EXIT_USAGE,
    );
    expect(cli.errors[0]).toContain("PORT: must be a port number");
    expect(
      await runCli(["config", "set", "ROAMGATE_PASSWORD=short"], cli.context),
    ).toBe(EXIT_USAGE);
    expect(await runCli(["config", "set", "NOPE=1"], cli.context)).toBe(
      EXIT_USAGE,
    );
    expect(existsSync(cli.configPath)).toBe(false);
  });

  test("validates the whole file, so TLS halves must be set together", async () => {
    cli = createTestCli();
    expect(
      await runCli(
        ["config", "set", "ROAMGATE_TLS_CERT=/missing.pem"],
        cli.context,
      ),
    ).toBe(EXIT_FAILURE);
    expect(cli.errors[0]).toContain("TLS requires both");
    expect(existsSync(cli.configPath)).toBe(false);
  });

  test("writes Roamgate names and removes legacy aliases", async () => {
    cli = createTestCli();
    cli.writeConfig("HERDR_GUI_LOG_LEVEL=warn\n");
    expect(
      await runCli(["config", "set", "HERDR_GUI_LOG_LEVEL=debug"], cli.context),
    ).toBe(EXIT_OK);
    expect(readFileSync(cli.configPath, "utf8")).toBe(
      "ROAMGATE_LOG_LEVEL=debug\n",
    );
    expect(
      await runCli(["config", "unset", "ROAMGATE_LOG_LEVEL"], cli.context),
    ).toBe(EXIT_OK);
    expect(readFileSync(cli.configPath, "utf8")).toBe("");
  });

  test("get prints effective values and fallbacks", async () => {
    cli = createTestCli();
    cli.writeConfig("PORT=9000\nHERDR_GUI_PIN=123456\n");
    await runCli(["config", "get", "PORT"], cli.context);
    await runCli(["config", "get", "ROAMGATE_PIN"], cli.context);
    await runCli(["config", "get", "ROAMGATE_LOG_LEVEL"], cli.context);
    expect(cli.output).toEqual(["9000", "123456", "info"]);
    expect(await runCli(["config", "get", "HERDR_SSH_HOST"], cli.context)).toBe(
      EXIT_FAILURE,
    );
  });

  test("show hides secrets unless revealed", async () => {
    cli = createTestCli();
    cli.writeConfig("ROAMGATE_PASSWORD=correct-horse-battery\nCUSTOM=1\n");
    await runCli(["config", "show", "--json"], cli.context);
    const shown = JSON.parse(cli.output.join("\n"));
    expect(shown.settings.ROAMGATE_PASSWORD).toEqual({
      value: "(hidden)",
      source: "file",
    });
    expect(shown.settings.HOST).toEqual({
      value: "127.0.0.1",
      source: "default",
    });
    expect(shown.other).toEqual(["CUSTOM"]);
    cli.output.length = 0;
    await runCli(["config", "show", "--json", "--reveal"], cli.context);
    expect(
      JSON.parse(cli.output.join("\n")).settings.ROAMGATE_PASSWORD.value,
    ).toBe("correct-horse-battery");
  });

  test("set --restart restarts only a running service", async () => {
    cli = createTestCli({ runCommand: () => 0 });
    cli.writeConfig(DEFAULT_SERVICE_ENV_FILE);
    // No service definition exists, so nothing is restarted.
    expect(
      await runCli(["config", "set", "PORT=9001", "--restart"], cli.context),
    ).toBe(EXIT_OK);
    expect(cli.commands).toEqual([]);
    expect(cli.output.at(-1)).toContain("not running");
  });

  test("existing values the server accepts never block unrelated changes", async () => {
    cli = createTestCli();
    cli.writeConfig("ROAMGATE_WEB_PUSH_PATH=web-push.json\nHOST=my host\n");
    expect(await runCli(["config", "set", "PORT=9000"], cli.context)).toBe(
      EXIT_OK,
    );
    expect(readFileSync(cli.configPath, "utf8")).toContain("PORT=9000");
    // Settings the server refuses to start with are still always checked.
    cli.writeConfig("ROAMGATE_LOG_LEVEL=loud\n");
    expect(await runCli(["config", "set", "PORT=9001"], cli.context)).toBe(
      EXIT_FAILURE,
    );
    expect(cli.errors.at(-1)).toContain("ROAMGATE_LOG_LEVEL");
  });

  test("path and edit still work when the file cannot be parsed", async () => {
    let script = "";
    cli = createTestCli({
      runCommand: (argv) => {
        if (argv[0] !== "fake-editor") return 4;
        cli.writeConfig(script);
        return 0;
      },
    });
    cli.context.runtime.env.EDITOR = "fake-editor";
    cli.writeConfig("this is not an assignment\n");
    expect(await runCli(["config", "path"], cli.context)).toBe(EXIT_OK);
    expect(cli.output.at(-1)).toBe(cli.configPath);
    expect(await runCli(["config", "show"], cli.context)).toBe(EXIT_FAILURE);

    // Saving a still-broken file is reported with guidance, not thrown.
    script = "still broken\n";
    expect(await runCli(["config", "edit"], cli.context)).toBe(EXIT_FAILURE);
    expect(cli.errors.at(-2)).toContain("the edited file is invalid");
    expect(cli.errors.at(-1)).toContain("roamgate config edit");

    script = "PORT=9002\n";
    expect(await runCli(["config", "edit"], cli.context)).toBe(EXIT_OK);
    expect(cli.commands[0]).toEqual(["fake-editor", cli.configPath]);
  });

  test("edit applies strict checks only to settings that changed", async () => {
    cli = createTestCli({
      runCommand: () => {
        cli.writeConfig("HOST=my host\nROAMGATE_WEB_PUSH_PATH=relative.json\n");
        return 0;
      },
    });
    cli.context.runtime.env.EDITOR = "fake-editor";
    cli.writeConfig("HOST=my host\n");
    expect(await runCli(["config", "edit"], cli.context)).toBe(EXIT_FAILURE);
    expect(cli.errors.at(-2)).toContain("ROAMGATE_WEB_PUSH_PATH");
  });

  test("help and unknown actions", async () => {
    cli = createTestCli();
    expect(await configCommand.run([], cli.context)).toBe(EXIT_OK);
    expect(await runCli(["config", "frobnicate"], cli.context)).toBe(
      EXIT_USAGE,
    );
  });
});
