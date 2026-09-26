import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  createImageUploadHandler,
  IMAGE_UPLOAD_DIRECTORY_PREFIX,
} from "./image-upload";
import { terminalPathText } from "./terminal-path-text";

const isWindows = process.platform === "win32";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "roamgate-image-upload-test-"));
  roots.push(root);
  return root;
}

function localHandler(root: string) {
  return createImageUploadHandler({
    sshHost: () => undefined,
    tempRoot: () => root,
  });
}

function upload(bytes: number[], ext?: string) {
  return new Request("http://localhost/api/upload-image", {
    method: "POST",
    headers: ext ? { "x-image-ext": ext } : {},
    body: new Uint8Array(bytes),
  });
}

type UploadBody = { path: string; text: string; remote: boolean };

async function uploadOk(
  handle: ReturnType<typeof createImageUploadHandler>,
  bytes: number[] = [1],
  ext?: string,
) {
  const response = await handle(upload(bytes, ext));
  expect(response.status).toBe(200);
  return (await response.json()) as UploadBody;
}

test("local pastes are written to a private folder under the temp root", async () => {
  const root = await tempRoot();
  const bytes = [137, 80, 78, 71];

  const body = await uploadOk(localHandler(root), bytes, "PNG");

  expect(body.remote).toBe(false);
  expect(isAbsolute(body.path)).toBe(true);
  expect(dirname(dirname(body.path))).toBe(root);
  expect(basename(dirname(body.path))).toStartWith(
    IMAGE_UPLOAD_DIRECTORY_PREFIX,
  );
  expect(basename(body.path)).toMatch(/^img-\d+-[a-z0-9]+\.png$/);
  expect(body.text).toBe(terminalPathText(body.path, process.platform));
  expect([...(await readFile(body.path))]).toEqual(bytes);
});

test.skipIf(isWindows)(
  "the folder and files are readable only by the current user",
  async () => {
    const body = await uploadOk(localHandler(await tempRoot()));

    const folder = await stat(dirname(body.path));
    expect(folder.uid).toBe(process.getuid?.() ?? -1);
    expect(folder.mode & 0o777).toBe(0o700);
    expect((await stat(body.path)).mode & 0o777).toBe(0o600);
  },
);

test("each server gets its own folder, reused across uploads", async () => {
  const root = await tempRoot();
  const first = localHandler(root);
  const second = localHandler(root);

  const a = await uploadOk(first);
  const b = await uploadOk(first);
  const c = await uploadOk(second);

  expect(dirname(b.path)).toBe(dirname(a.path));
  expect(dirname(c.path)).not.toBe(dirname(a.path));
});

test("a deleted folder is replaced with a new private folder", async () => {
  const handle = localHandler(await tempRoot());
  const first = await uploadOk(handle);
  await rm(dirname(first.path), { recursive: true });

  const second = await uploadOk(handle);

  expect(dirname(second.path)).not.toBe(dirname(first.path));
  expect(await Bun.file(second.path).exists()).toBe(true);
});

test("a folder swapped for a link is not followed", async () => {
  const root = await tempRoot();
  const handle = localHandler(root);
  const first = await uploadOk(handle);
  const folder = dirname(first.path);
  const target = join(root, "attacker");
  await mkdir(target);
  await rm(folder, { recursive: true });
  await symlink(target, folder, "junction");

  const second = await uploadOk(handle);

  expect(dirname(second.path)).not.toBe(folder);
  expect(await readdir(target)).toEqual([]);
});

test.skipIf(isWindows)(
  "a folder whose permissions were loosened is not reused",
  async () => {
    const handle = localHandler(await tempRoot());
    const first = await uploadOk(handle);
    await chmod(dirname(first.path), 0o777);

    const second = await uploadOk(handle);

    expect(dirname(second.path)).not.toBe(dirname(first.path));
  },
);

test("unsafe extension characters are dropped from the file name", async () => {
  const root = await tempRoot();

  const body = await uploadOk(localHandler(root), [1], "../j.p-g");

  expect(dirname(dirname(body.path))).toBe(root);
  expect(basename(body.path)).toMatch(/^img-\d+-[a-z0-9]+\.jpg$/);
});

test("empty uploads are rejected without creating a folder", async () => {
  const root = await tempRoot();

  const response = await localHandler(root)(upload([]));

  expect(response.status).toBe(400);
  expect(await readdir(root)).toEqual([]);
});
