import { expect, test } from "bun:test";
import {
  type UploadProgress,
  uploadedPaths,
  uploadFailureMessage,
  uploadInOrder,
} from "./uploadInOrder";

function files(count: number) {
  return Array.from(
    { length: count },
    (_, index) => new File(["x"], `photo-${index + 1}.jpg`),
  );
}

/** An upload each test settles by hand, in the order it wants. */
function manualUploads() {
  const pending = new Map<
    string,
    { resolve: (path: string) => void; reject: (error: Error) => void }
  >();
  let running = 0;
  let most = 0;
  const upload = (file: File) =>
    new Promise<string>((resolve, reject) => {
      running++;
      most = Math.max(most, running);
      pending.set(file.name, {
        resolve: (path) => {
          running--;
          resolve(path);
        },
        reject: (error) => {
          running--;
          reject(error);
        },
      });
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    upload,
    pending,
    tick,
    started: () => [...pending.keys()],
    most: () => most,
  };
}

test("keeps the picked order whatever order the uploads finish in", async () => {
  const uploads = manualUploads();
  const done = uploadInOrder(files(5), uploads.upload);
  await uploads.tick();
  for (const name of [
    "photo-3.jpg",
    "photo-1.jpg",
    "photo-2.jpg",
    "photo-5.jpg",
    "photo-4.jpg",
  ]) {
    await uploads.tick();
    uploads.pending.get(name)?.resolve(`/tmp/${name}`);
    await uploads.tick();
  }
  expect(uploadedPaths(await done)).toEqual([
    "/tmp/photo-1.jpg",
    "/tmp/photo-2.jpg",
    "/tmp/photo-3.jpg",
    "/tmp/photo-4.jpg",
    "/tmp/photo-5.jpg",
  ]);
});

test("uploads at most three at a time, starting the next as one ends", async () => {
  const uploads = manualUploads();
  const done = uploadInOrder(files(8), uploads.upload);
  await uploads.tick();
  expect(uploads.started()).toEqual([
    "photo-1.jpg",
    "photo-2.jpg",
    "photo-3.jpg",
  ]);
  uploads.pending.get("photo-2.jpg")!.resolve("/b");
  await uploads.tick();
  expect(uploads.started()).toHaveLength(4);
  expect(uploads.started()[3]).toBe("photo-4.jpg");
  for (let index = 1; index <= 8; index++) {
    uploads.pending.get(`photo-${index}.jpg`)?.resolve(`/${index}`);
    await uploads.tick();
  }
  await done;
  expect(uploads.most()).toBe(3);
});

test("honours another limit, and a single file", async () => {
  const uploads = manualUploads();
  const done = uploadInOrder(files(4), uploads.upload, { concurrency: 2 });
  await uploads.tick();
  expect(uploads.started()).toHaveLength(2);
  for (let index = 1; index <= 4; index++) {
    uploads.pending.get(`photo-${index}.jpg`)?.resolve(`/${index}`);
    await uploads.tick();
  }
  await done;
  expect(uploads.most()).toBe(2);
  expect(
    uploadedPaths(await uploadInOrder(files(1), async () => "/only")),
  ).toEqual(["/only"]);
  expect(await uploadInOrder([], async () => "/never")).toEqual([]);
});

test("counts each file as it settles, failed ones too", async () => {
  const seen: UploadProgress[] = [];
  const indexes: number[] = [];
  await uploadInOrder(
    files(4),
    async (file) => {
      if (file.name === "photo-2.jpg") throw new Error("too large");
      return `/${file.name}`;
    },
    {
      onSettled: (progress, _result, index) => {
        seen.push(progress);
        indexes.push(index);
      },
    },
  );
  expect(seen.map(({ done }) => done)).toEqual([1, 2, 3, 4]);
  expect(seen.every(({ total }) => total === 4)).toBe(true);
  expect([...indexes].sort()).toEqual([0, 1, 2, 3]);
});

test("keeps the others when one fails, and says which", async () => {
  const results = await uploadInOrder(files(4), async (file) => {
    if (file.name === "photo-3.jpg") throw new Error("Upload too large");
    return `/${file.name}`;
  });
  expect(uploadedPaths(results)).toEqual([
    "/photo-1.jpg",
    "/photo-2.jpg",
    "/photo-4.jpg",
  ]);
  expect(uploadFailureMessage(results)).toBe(
    "photo-3.jpg did not upload: Upload too large",
  );
});

test("names every failed file, and the fallback for a reasonless error", async () => {
  const results = await uploadInOrder(files(3), async (file) => {
    if (file.name === "photo-1.jpg") throw new Error("offline");
    if (file.name === "photo-3.jpg") throw "nope";
    return `/${file.name}`;
  });
  expect(uploadFailureMessage(results, "Image upload failed")).toBe(
    "2 of 3 files did not upload (photo-1.jpg, photo-3.jpg): offline; Image upload failed",
  );
  expect(
    uploadFailureMessage(await uploadInOrder(files(2), async () => "/ok")),
  ).toBeNull();
});
