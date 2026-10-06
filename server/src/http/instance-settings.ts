import { normalizeTitleSuffix } from "../../../shared/instanceName";
import { readGuiSettings, updateGuiSettings } from "../config/gui-settings";
import { serverLogger } from "../utils/logger";
import { readJsonBody } from "./json-body";

const headers = { "cache-control": "no-store" };

// Called only after the server's normal authentication gate. This setting is
// instance-wide, so it must not depend on a selected or connected Herdr server.
export async function handleInstanceSettings(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const settings = await readGuiSettings();
    return Response.json(
      { title_suffix: settings.title_suffix ?? "" },
      { headers },
    );
  }
  if (req.method !== "PUT") {
    return new Response("method not allowed", {
      status: 405,
      headers: { ...headers, allow: "GET, PUT" },
    });
  }
  // As with push settings, the custom header + JSON prevent a cross-origin
  // browser write without a CORS grant. Do not trust proxy Host/Origin rewriting.
  if (
    req.headers.get("x-roamgate-settings") !== "1" ||
    req.headers.get("sec-fetch-site") === "cross-site" ||
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }
  let input: unknown;
  try {
    input = await readJsonBody(req, 4096);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RangeError
            ? "Request body too large"
            : "Invalid settings request",
      },
      { status: error instanceof RangeError ? 413 : 400, headers },
    );
  }
  let suffix: string;
  try {
    suffix = normalizeTitleSuffix(
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as { title_suffix?: unknown }).title_suffix
        : undefined,
    );
  } catch (error) {
    return Response.json(
      { error: (error as Error).message },
      { status: 400, headers },
    );
  }
  try {
    const settings = await updateGuiSettings((current) => ({
      ...current,
      title_suffix: suffix,
    }));
    return Response.json(
      { title_suffix: settings.title_suffix ?? "" },
      { headers },
    );
  } catch (error) {
    serverLogger
      .child("settings")
      .warn("unable to save instance name", { error });
    return Response.json(
      { error: "Unable to save instance name" },
      { status: 500, headers },
    );
  }
}
