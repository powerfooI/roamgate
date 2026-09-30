import { createTerminalUploadHandler } from "./terminal-upload";

export function createImageUploadHandler(args: {
  sshHost: () => string | undefined;
  tempRoot?: () => string;
  platform?: NodeJS.Platform;
}) {
  const stage = createTerminalUploadHandler({
    ...args,
    maxBytes: 25 * 1024 * 1024,
    rejectEmpty: true,
  });
  return (req: Request) => {
    const ext =
      (req.headers.get("x-image-ext") || "png")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "") || "png";
    const name = `img-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;
    return stage(req, name);
  };
}
