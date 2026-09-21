// Keep Files, Changes and SSH reads on the same image-format contract.
export const IMAGE_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ["svg", "image/svg+xml"],
  ["apng", "image/apng"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["jpe", "image/jpeg"],
  ["jfif", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["avif", "image/avif"],
]);

export const HTML_PREVIEW_MAX_BYTES = 512 * 1024;

export function isHtmlPath(path: string) {
  return /\.html?$/i.test(path);
}

export function imageMimeForPath(path: string) {
  return (
    IMAGE_MIME_TYPES.get(path.toLowerCase().split(".").pop() ?? "") ?? null
  );
}
