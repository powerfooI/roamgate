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
