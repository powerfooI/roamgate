import { expect, test } from "bun:test";
import {
  attachmentDisplay,
  REMEMBERED_ATTACHMENTS,
  rememberComposerAttachment,
  withoutAttachment,
} from "./composerAttachments";

const first = "/tmp/roamgate-uploads-501/upload-a/img-1.png";
const second = "/tmp/roamgate-uploads-501/upload-b/img-2.png";
rememberComposerAttachment(first, new File([], "shot.png"));
rememberComposerAttachment(second, new File([], "other.png"));

test("attached images show as [Image #N] and go back to their paths", () => {
  const draft = `look ${first} and ${second} then ${first} `;
  const shown = attachmentDisplay(draft);
  expect(shown.text).toBe("look [Image #1] and [Image #2] then [Image #1] ");
  expect(shown.attachments.map((a) => a.name)).toEqual([
    "shot.png",
    "other.png",
  ]);
  expect(shown.toDraft(shown.text)).toBe(draft);
  // Typing after the first image keeps it.
  expect(shown.toDraft("look [Image #1] here and [Image #2] then ")).toBe(
    `look ${first} here and ${second} then `,
  );
  // A broken placeholder drops its image.
  expect(shown.toDraft("look [Image #1")).toBe("look [Image #1");
  // Cursor positions map into the draft.
  expect(shown.draftOffset(shown.text, 5)).toBe(5);
  expect(shown.draftOffset(shown.text, 15)).toBe(5 + first.length);
  expect(shown.shownOffset(5 + first.length)).toBe(15);
  expect(shown.shownOffset(8)).toBe(15);
  expect(shown.shownOffset(draft.length)).toBe(shown.text.length);
});

test("a draft without attachments shows as it is", () => {
  const shown = attachmentDisplay("plain /other/path.png");
  expect(shown.text).toBe("plain /other/path.png");
  expect(shown.attachments).toEqual([]);
});

test("removing an attachment takes its trailing space too", () => {
  expect(withoutAttachment(`see ${first} now`, first)).toBe("see now");
});

test("remembers a bounded number of images and releases older thumbnails", () => {
  const revoked: string[] = [];
  const { createObjectURL, revokeObjectURL } = URL;
  let created = 0;
  URL.createObjectURL = () => `blob:test-${created++}`;
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  try {
    const path = (n: number) => `/tmp/roamgate-uploads-501/u/bounded-${n}.png`;
    for (let n = 0; n <= REMEMBERED_ATTACHMENTS; n++)
      rememberComposerAttachment(path(n), new File([], `${n}.png`));
    // The oldest went: its thumbnail released, its path shown as typed.
    expect(revoked).toContain("blob:test-0");
    expect(attachmentDisplay(path(0)).text).toBe(path(0));
    expect(attachmentDisplay(path(REMEMBERED_ATTACHMENTS)).text).toBe(
      "[Image #1]",
    );
  } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});

test("a reload shows a draft's images as [Image #N] again, without thumbnails", async () => {
  const values = new Map<string, string>();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  try {
    type Attachments = typeof import("./composerAttachments");
    const fresh = (tab: string): Promise<Attachments> =>
      import(`./composerAttachments.ts?${tab}`);
    const before = await fresh("before-reload");
    before.rememberComposerAttachment(first, new File([], "shot.png"));
    // A reload: a fresh module, the same tab.
    const after = await fresh("after-reload");
    const shown = after.attachmentDisplay(`look ${first}`);
    expect(shown.text).toBe("look [Image #1]");
    expect(shown.attachments).toEqual([{ path: first, name: "shot.png" }]);
  } finally {
    if (saved) Object.defineProperty(globalThis, "sessionStorage", saved);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
