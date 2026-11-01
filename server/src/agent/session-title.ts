import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { antigravityHome } from "./antigravity-session";
import type { SessionFile } from "./session-types";
import { isRecord, stringValue } from "./session-utils";

function cleanTitle(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractAgentSessionTitle(
  agent: string,
  file: SessionFile,
  records: Record<string, unknown>[],
): string | null {
  if (agent === "agy") {
    try {
      const sessionId = basename(file.path, ".db");
      const dir = dirname(file.path);
      const pbtxtCandidate = join(
        dirname(dir),
        "annotations",
        `${sessionId}.pbtxt`,
      );
      const pbtxt = existsSync(pbtxtCandidate)
        ? pbtxtCandidate
        : join(antigravityHome(), "annotations", `${sessionId}.pbtxt`);
      if (existsSync(pbtxt)) {
        const content = readFileSync(pbtxt, "utf8");
        const match = content.match(/title:\s*"([^"]+)"/);
        if (match?.[1]) {
          const clean = cleanTitle(match[1]);
          if (clean) return clean;
        }
      }
    } catch {}
  }

  if (!Array.isArray(records) || records.length === 0) return null;

  if (agent === "claude") {
    let latestAiTitle: string | null = null;
    let latestCustomTitle: string | null = null;

    for (const record of records) {
      if (!isRecord(record)) continue;
      const type = stringValue(record.type);
      if (type === "custom-title") {
        const title = cleanTitle(record.customTitle ?? record.title);
        if (title) latestCustomTitle = title;
      } else if (type === "ai-title") {
        const title = cleanTitle(record.aiTitle ?? record.title);
        if (title) latestAiTitle = title;
      }
    }

    return latestCustomTitle ?? latestAiTitle;
  }

  if (agent === "hermes") {
    let latestTitle: string | null = null;
    for (const record of records) {
      if (!isRecord(record)) continue;
      const title =
        cleanTitle(record.custom_title) ??
        cleanTitle(record.customTitle) ??
        cleanTitle(record.title) ??
        cleanTitle(record.name) ??
        cleanTitle(record.session_title);
      if (title) latestTitle = title;
    }
    return latestTitle;
  }

  return null;
}
