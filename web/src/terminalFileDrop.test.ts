import { expect, test } from "bun:test";
import {
  filesFromTerminalDrop,
  isNativeFileDrag,
  terminalUploadedPathsText,
} from "./terminalFileDrop";
import { WORKSPACE_PATH_DRAG_TYPE } from "./workspacePathDrag";

const file = new File(["content"], "note.txt");

test("native files are distinct from explorer path drags", () => {
  expect(isNativeFileDrag({ types: ["Files"] })).toBe(true);
  expect(isNativeFileDrag({ types: ["Files", WORKSPACE_PATH_DRAG_TYPE] })).toBe(
    false,
  );
  expect(isNativeFileDrag({ types: ["text/plain"] })).toBe(false);
});

test("accepts multiple files, rejects directories, and joins paths", () => {
  const item = (entry: { isDirectory: boolean }, selected: File | null) => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => selected,
  });
  const data = (items: unknown[]) => ({
    types: ["Files"],
    files: [file] as unknown as FileList,
    items: items as unknown as DataTransferItemList,
  });
  expect(
    filesFromTerminalDrop(
      data([
        item({ isDirectory: false }, file),
        item({ isDirectory: false }, file),
      ]),
    ),
  ).toEqual([file, file]);
  expect(filesFromTerminalDrop(data([item({ isDirectory: true }, null)]))).toBe(
    "directory",
  );
  expect(terminalUploadedPathsText(["/tmp/a", "/tmp/b"])).toBe(
    "/tmp/a /tmp/b ",
  );
});

test("ignores text and explorer drops even if they contain file items", () => {
  const data = {
    types: [WORKSPACE_PATH_DRAG_TYPE, "Files"],
    files: [file] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
  };
  expect(filesFromTerminalDrop(data)).toBeNull();
  expect(filesFromTerminalDrop({ ...data, types: ["text/plain"] })).toBeNull();
});

test("uses the file list when drag items are unavailable", () => {
  expect(
    filesFromTerminalDrop({
      types: ["Files"],
      files: [file] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    }),
  ).toEqual([file]);
});

test("rejects the whole drop when a later file item is a directory", () => {
  expect(
    filesFromTerminalDrop({
      types: ["Files"],
      files: [file] as unknown as FileList,
      items: [
        { kind: "file", getAsFile: () => file },
        { kind: "file", getAsFile: () => null },
      ] as unknown as DataTransferItemList,
    }),
  ).toBe("directory");
});
