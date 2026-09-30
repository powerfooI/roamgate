import type { ConnectionClient } from "./api";
import { connectionHttpPath } from "./connectionHttp";

/**
 * Uploads an image through the connection's HTTP endpoint and returns the
 * server-side path as text ready to insert at a shell or agent prompt. The
 * server formats it because only the host knows its path conventions. Callers
 * decide when (or whether) that text reaches a terminal; uploading here never
 * writes to a PTY by itself.
 */
export async function uploadTerminalImage(
  client: ConnectionClient,
  file: File,
): Promise<string> {
  const ext = (file.type.split("/")[1] || "png").toLowerCase();
  return uploadTerminalPayload(client, file, "/upload-image", {
    "x-image-ext": ext,
    "content-type": file.type || "image/png",
  });
}

export function uploadTerminalFile(
  client: ConnectionClient,
  file: File,
): Promise<string> {
  return uploadTerminalPayload(client, file, "/terminal-upload");
}

async function uploadTerminalPayload(
  client: ConnectionClient,
  file: File,
  endpoint: "/upload-image" | "/terminal-upload",
  headers?: Record<string, string>,
): Promise<string> {
  if (!client.isCurrent()) throw new Error("connection changed during upload");
  const uploadUrl = new URL(
    connectionHttpPath(
      client.connectionId,
      endpoint,
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  if (endpoint === "/terminal-upload") {
    uploadUrl.searchParams.set("filename", file.name);
  }
  if (uploadUrl.origin !== window.location.origin) {
    throw new Error("invalid upload origin");
  }
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers,
    body: file,
  });
  if (!res.ok) {
    const body = (await res.text()).trim();
    if (!client.isCurrent()) {
      throw new Error("connection changed during upload");
    }
    let detail = body;
    if (body) {
      try {
        const payload: unknown = JSON.parse(body);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const error = (payload as { error?: unknown }).error;
          if (typeof error === "string" && error) detail = error;
        }
      } catch {
        // Auth proxies and generic HTTP servers commonly return plain text or
        // HTML errors. The response is already a failure, so preserve its body.
      }
    }
    throw new Error(
      detail || res.statusText || `Upload failed (${res.status})`,
    );
  }

  const data: unknown = await res.json();
  if (!client.isCurrent()) throw new Error("connection changed during upload");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("upload response was not an object");
  }
  const payload = data as { path?: unknown; text?: unknown };
  if (typeof payload.text === "string" && payload.text.length > 0) {
    return payload.text;
  }
  if (typeof payload.path !== "string" || payload.path.length === 0) {
    throw new Error("upload response did not include a path");
  }
  return payload.path;
}
