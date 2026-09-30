import { isWorkspacePathDrag } from "./workspacePathDrag";

export function isNativeFileDrag(data: Pick<DataTransfer, "types">) {
  return Array.from(data.types).includes("Files") && !isWorkspacePathDrag(data);
}

export function filesFromTerminalDrop(
  data: Pick<DataTransfer, "types" | "items" | "files">,
): File[] | "directory" | null {
  if (!isNativeFileDrag(data)) return null;
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  if (items.length) {
    const files: File[] = [];
    for (const item of items) {
      if (item.webkitGetAsEntry?.()?.isDirectory) return "directory";
      const file = item.getAsFile();
      if (!file) return "directory";
      files.push(file);
    }
    return files;
  }
  return Array.from(data.files);
}

export function terminalUploadedPathsText(paths: string[]) {
  return `${paths.join(" ")} `;
}
