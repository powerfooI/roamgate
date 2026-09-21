import { createRoot } from "react-dom/client";
import { FilePreviewContent } from "./FilePreviewContent";
import type { FilePreview } from "../types";
import "../styles/tokens.css";
import "../styles/base.css";

const container = document.createElement("div");
container.className = "file-explorer-side";
container.style.cssText = "height:700px;display:flex;flex-direction:column";
document.body.append(container);
const root = createRoot(container);
const source = await fetch("/fixture-source").then((response) =>
  response.text(),
);
function show(path = "docs/page.html", overrides: Partial<FilePreview> = {}) {
  root.render(
    <FilePreviewContent
      entry={{
        name: path.split("/").pop()!,
        path,
        type: "file",
        size: source.length,
        mtime_ms: 0,
        hidden: false,
      }}
      preview={{
        workspace_id: "w1",
        checkout_path: "/repo",
        repo_name: "Repo",
        root: "/repo",
        path,
        text: source,
        binary: false,
        size: source.length,
        mtime_ms: 0,
        truncated: false,
        ...overrides,
      }}
      loading={false}
      error={null}
    />,
  );
}
Object.assign(window, { htmlPreviewTest: { show } });
show();
