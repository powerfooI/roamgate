import { afterEach, expect, jest, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createTerminalUploadHandler,
  remoteTerminalCleanupScript,
  remoteTerminalUploadScript,
  sanitizeTerminalUploadName,
} from "./terminal-upload";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), "terminal-upload-test-"));
  roots.push(path);
  return path;
}

function request(body: string | ReadableStream<Uint8Array>) {
  return new Request("http://localhost/api/terminal-upload", {
    method: "POST",
    body,
  });
}

test.each([
  ["../../secret.txt", "secret.txt"],
  ["C:\\dir\\some file.txt", "some_file.txt"],
  ["'$(touch x)'.sh", "___touch_x__.sh"],
  ["line\nname ü.txt", "line_name__.txt"],
  ["a".repeat(150) + ".md", "a".repeat(117) + ".md"],
])("sanitizes terminal filename %s", (input, expected) => {
  expect(sanitizeTerminalUploadName(input)).toBe(expected);
});

test.each([
  ["CON.txt", "_CON.txt"],
  ["nul.tar.gz", "_nul.tar.gz"],
  ["COM1.log", "_COM1.log"],
  ["LPT9", "_LPT9"],
  ["report.", "report"],
  ["normal.txt", "normal.txt"],
])("keeps Windows upload name %s usable", (input, expected) => {
  expect(sanitizeTerminalUploadName(input, "win32")).toBe(expected);
});

test("streams a file to a private directory and retains an empty file", async () => {
  const temp = await root();
  const handle = createTerminalUploadHandler({
    sshHost: () => undefined,
    tempRoot: () => temp,
  });
  const response = await handle(
    request(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hel"));
          controller.enqueue(new TextEncoder().encode("lo"));
          controller.close();
        },
      }),
    ),
    "a file.txt",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { path: string; text: string };
  expect(basename(body.path)).toBe("a_file.txt");
  expect(await readFile(body.path, "utf8")).toBe("hello");
  if (process.platform !== "win32") {
    expect(
      (
        await stat(
          join(temp, `roamgate-uploads-${process.getuid?.() ?? "user"}`),
        )
      ).mode & 0o777,
    ).toBe(0o700);
    expect((await stat(body.path)).mode & 0o777).toBe(0o600);
  }
  const empty = await handle(request(""), "empty.txt");
  expect(empty.status).toBe(200);
  expect(basename(((await empty.json()) as { path: string }).path)).toBe(
    "empty.txt",
  );
});

test("size cap removes the partial file", async () => {
  const temp = await root();
  const handle = createTerminalUploadHandler({
    sshHost: () => undefined,
    tempRoot: () => temp,
    maxBytes: 3,
  });
  const response = await handle(
    request(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("123"));
          controller.enqueue(new TextEncoder().encode("4"));
          controller.close();
        },
      }),
    ),
    "too-big.txt",
  );
  expect(response.status).toBe(413);
  const uploadRoot = join(
    temp,
    `roamgate-uploads-${process.getuid?.() ?? "user"}`,
  );
  expect(await readdir(uploadRoot)).toEqual([]);
});

test("refuses a symlinked root and sweeps expired uploads", async () => {
  const temp = await root();
  const uploadRoot = join(
    temp,
    `roamgate-uploads-${process.getuid?.() ?? "user"}`,
  );
  const handle = createTerminalUploadHandler({
    sshHost: () => undefined,
    tempRoot: () => temp,
    retentionHours: 1,
  });
  const first = (await (await handle(request("old"), "old.txt")).json()) as {
    path: string;
  };
  const directory = join(uploadRoot, (await readdir(uploadRoot))[0]);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(directory, old, old);
  await handle(request("new"), "new.txt");
  expect(await Bun.file(first.path).exists()).toBe(false);

  await rm(uploadRoot, { recursive: true });
  await symlink(temp, uploadRoot, "junction");
  expect((await handle(request("blocked"), "blocked.txt")).status).toBe(500);
  expect(await readdir(temp)).toEqual([
    `roamgate-uploads-${process.getuid?.() ?? "user"}`,
  ]);
});

test("sweeps expired uploads at startup and without a later upload", async () => {
  jest.useFakeTimers();
  let handle: ReturnType<typeof createTerminalUploadHandler> | undefined;
  try {
    const temp = await root();
    handle = createTerminalUploadHandler({
      sshHost: () => undefined,
      tempRoot: () => temp,
      retentionHours: 1,
    });
    const first = (await (
      await handle(request("first"), "first.txt")
    ).json()) as {
      path: string;
    };
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dirname(first.path), old, old);
    await handle.startCleanup();
    expect(await Bun.file(first.path).exists()).toBe(false);

    const second = (await (
      await handle(request("second"), "second.txt")
    ).json()) as {
      path: string;
    };
    await utimes(dirname(second.path), old, old);
    jest.advanceTimersByTime(60 * 60 * 1000);
    await handle.startCleanup();
    expect(await Bun.file(second.path).exists()).toBe(false);
  } finally {
    handle?.stopCleanup();
    jest.useRealTimers();
  }
});

test.skipIf(process.platform === "win32")(
  "remote scripts create a private staged file and sweep it later",
  async () => {
    const temp = await root();
    const source = join(temp, "source");
    await writeFile(source, "remote bytes");
    const proc = Bun.spawn(
      ["sh", "-c", remoteTerminalUploadScript("a_file.txt", 60)],
      {
        env: { ...process.env, TMPDIR: temp },
        stdin: Bun.file(source),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, path, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(path, "utf8")).toBe("remote bytes");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(dirname(path), old, old);
    const cleanup = Bun.spawn(["sh", "-c", remoteTerminalCleanupScript(60)], {
      env: { ...process.env, TMPDIR: temp },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await cleanup.exited).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
  },
);
