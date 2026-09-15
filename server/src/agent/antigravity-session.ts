import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SessionFile, TokenUsage } from "./session-types";
import { isRecord } from "./session-utils";

export type AntigravitySessionSummary = {
  sessionId: string;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  modelName?: string;
  agentVersion?: string;
};

export type AntigravitySessionDescriptor = {
  session: AntigravitySessionSummary;
  file: SessionFile;
};

export interface ProtoField {
  fieldNum: number;
  wireType: number;
  val: any;
}

export function decodeVarint(
  buf: Uint8Array,
  pos: number,
): { val: number | bigint; pos: number } | null {
  let res = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    res |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (!(b & 0x80)) {
      const num = Number(res);
      return { val: Number.isSafeInteger(num) ? num : res, pos };
    }
  }
  return null;
}

export function decodeProto(buf: Uint8Array | null | undefined): ProtoField[] {
  if (!buf || buf.length === 0) return [];
  let pos = 0;
  const fields: ProtoField[] = [];
  try {
    while (pos < buf.length) {
      const keyRes = decodeVarint(buf, pos);
      if (!keyRes) break;
      pos = keyRes.pos;
      const key = Number(keyRes.val);
      const wireType = key & 7;
      const fieldNum = key >> 3;
      if (fieldNum === 0) break;

      let val: any;
      if (wireType === 0) {
        const vRes = decodeVarint(buf, pos);
        if (!vRes) break;
        pos = vRes.pos;
        val = vRes.val;
      } else if (wireType === 1) {
        val = buf.subarray(pos, pos + 8);
        pos += 8;
      } else if (wireType === 2) {
        const lenRes = decodeVarint(buf, pos);
        if (!lenRes) break;
        pos = lenRes.pos;
        const len = Number(lenRes.val);
        if (pos + len > buf.length) break;
        val = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wireType === 5) {
        val = buf.subarray(pos, pos + 4);
        pos += 4;
      } else {
        break;
      }
      fields.push({ fieldNum, wireType, val });
    }
  } catch {
    // Incomplete or malformed protobuf blob
  }
  return fields;
}

export function toUtf8String(val: unknown): string {
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return Buffer.from(val).toString("utf8");
  }
  if (typeof val === "string") return val;
  return "";
}

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/;

export function extractToolOutputText(
  val: Uint8Array | null | undefined,
): string {
  if (!val || val.length === 0) return "";
  let text = "";
  try {
    const subFields = decodeProto(val);
    const sf1 = subFields.find((f) => f.fieldNum === 1);
    if (sf1 && sf1.val) {
      text = toUtf8String(sf1.val);
    } else {
      for (const f of subFields) {
        if (f.wireType === 2 && f.val) {
          const candidate = toUtf8String(f.val);
          if (!CONTROL_CHARS_REGEX.test(candidate)) {
            text = candidate;
            break;
          }
        }
      }
    }
  } catch {
    // fallback if not a valid protobuf message
  }
  if (!text) {
    text = toUtf8String(val);
  }
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g, "");
}

export function withTempDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "roamgate-agy-"));
  const tempDbPath = join(tempDir, basename(dbPath));
  try {
    copyFileSync(dbPath, tempDbPath);
    if (existsSync(`${dbPath}-wal`)) {
      copyFileSync(`${dbPath}-wal`, `${tempDbPath}-wal`);
    }
    if (existsSync(`${dbPath}-shm`)) {
      copyFileSync(`${dbPath}-shm`, `${tempDbPath}-shm`);
    }
    const db = new Database(tempDbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
  }
}

function safeSessionId(value: string) {
  return !!value && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

export function antigravityHome() {
  const configured =
    process.env.ANTIGRAVITY_HOME?.trim() || process.env.GEMINI_HOME?.trim();
  if (!configured) return join(homedir(), ".gemini", "antigravity-cli");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function antigravityConversationsRoot() {
  const configured = process.env.ANTIGRAVITY_CONVERSATIONS_DIR?.trim();
  if (!configured) return join(antigravityHome(), "conversations");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function sameDirectory(left: string, right: string) {
  return resolve(left) === resolve(right);
}

type AntigravityMetadata = {
  sessionId: string;
  cwd?: string;
  modelName?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

function inspectAntigravityDb(
  db: Database,
  fallbackSessionId: string,
): AntigravityMetadata {
  let sessionId = fallbackSessionId;
  try {
    const traj = db
      .query("SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1")
      .get() as { cascade_id?: string; trajectory_id?: string } | null;
    if (traj?.cascade_id) sessionId = traj.cascade_id;
    else if (traj?.trajectory_id) sessionId = traj.trajectory_id;
  } catch {}

  let cwd: string | undefined;
  try {
    const blobRow = db
      .query(
        'SELECT data FROM trajectory_metadata_blob WHERE id = "main" LIMIT 1',
      )
      .get() as { data?: Uint8Array } | null;
    if (blobRow?.data) {
      const fields = decodeProto(blobRow.data);
      const f7 = fields.find((f) => f.fieldNum === 7);
      const f1 = fields.find((f) => f.fieldNum === 1);
      const rawUri = f7 ? toUtf8String(f7.val) : f1 ? toUtf8String(f1.val) : "";
      if (rawUri.startsWith("file://")) {
        cwd = rawUri.replace(/^file:\/\//, "");
      } else if (rawUri) {
        cwd = rawUri;
      }
    }
  } catch {}

  let modelName: string | undefined;
  try {
    const genRow = db
      .query("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1")
      .get() as { data?: Uint8Array } | null;
    if (genRow?.data) {
      const fields = decodeProto(genRow.data);
      const f1 = fields.find((f) => f.fieldNum === 1);
      if (f1) {
        const f1sub = decodeProto(f1.val);
        const f19 = f1sub.find((f) => f.fieldNum === 19);
        if (f19) modelName = toUtf8String(f19.val);
      }
    }
  } catch {}

  let createdAtMs: number | undefined;
  let updatedAtMs: number | undefined;
  try {
    const bounds = db
      .query("SELECT MIN(idx) as min_idx, MAX(idx) as max_idx FROM steps")
      .get() as { min_idx: number | null; max_idx: number | null } | null;
    if (bounds && bounds.min_idx !== null) {
      const first = db
        .query("SELECT metadata FROM steps WHERE idx = ?")
        .get(bounds.min_idx) as { metadata?: Uint8Array } | null;
      if (first?.metadata) {
        const meta = decodeProto(first.metadata);
        const ts = meta.find((f) => f.fieldNum === 1);
        if (ts) {
          const sub = decodeProto(ts.val);
          const sec = sub.find((f) => f.fieldNum === 1);
          if (sec) createdAtMs = Number(sec.val) * 1000;
        }
      }
      const last = db
        .query("SELECT metadata FROM steps WHERE idx = ?")
        .get(bounds.max_idx) as { metadata?: Uint8Array } | null;
      if (last?.metadata) {
        const meta = decodeProto(last.metadata);
        const ts = meta.find((f) => f.fieldNum === 1);
        if (ts) {
          const sub = decodeProto(ts.val);
          const sec = sub.find((f) => f.fieldNum === 1);
          if (sec) updatedAtMs = Number(sec.val) * 1000;
        }
      }
    }
  } catch {}

  return { sessionId, cwd, modelName, createdAtMs, updatedAtMs };
}

export async function describeAntigravitySessionPath(
  path: string,
): Promise<AntigravitySessionDescriptor | null> {
  let targetPath = resolve(path);
  let statInfo;
  try {
    statInfo = await stat(targetPath);
  } catch {
    if (!targetPath.endsWith(".db")) {
      try {
        targetPath = `${targetPath}.db`;
        statInfo = await stat(targetPath);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!statInfo.isFile()) return null;

  let mtimeMs = statInfo.mtimeMs;
  try {
    const walStat = statSync(`${targetPath}-wal`);
    if (walStat.mtimeMs > mtimeMs) mtimeMs = walStat.mtimeMs;
  } catch {}

  const fallbackId = basename(targetPath, ".db");
  let metadata: AntigravityMetadata;
  try {
    metadata = withTempDb(targetPath, (db) =>
      inspectAntigravityDb(db, fallbackId),
    );
  } catch {
    return null;
  }

  const finalUpdatedAt = metadata.updatedAtMs ?? mtimeMs;
  return {
    session: {
      sessionId: metadata.sessionId,
      cwd: metadata.cwd,
      createdAtMs: metadata.createdAtMs,
      updatedAtMs: finalUpdatedAt,
      modelName: metadata.modelName,
      agentVersion: "antigravity-cli",
    },
    file: {
      path: targetPath,
      mtimeMs: finalUpdatedAt,
      size: statInfo.size,
      sessionId: metadata.sessionId,
      createdAtMs: metadata.createdAtMs,
      modelName: metadata.modelName,
      agentVersion: "antigravity-cli",
    },
  };
}

export async function findAntigravitySessionById(
  id: string,
  cwd = "",
  root = antigravityConversationsRoot(),
): Promise<AntigravitySessionDescriptor | null> {
  if (!safeSessionId(id)) return null;
  const filename = id.endsWith(".db") ? id : `${id}.db`;
  const direct = join(root, filename);
  if (existsSync(direct)) {
    const desc = await describeAntigravitySessionPath(direct);
    if (desc) return desc;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".db") &&
        (e.name.startsWith(id) || basename(e.name, ".db").startsWith(id)),
    )
    .map((e) => join(root, e.name));

  if (matches.length === 0) return null;
  const descriptors = (
    await Promise.all(matches.map((p) => describeAntigravitySessionPath(p)))
  ).filter((d): d is AntigravitySessionDescriptor => !!d);

  return (
    descriptors
      .filter(
        (item) =>
          !cwd || (!!item.session.cwd && sameDirectory(item.session.cwd, cwd)),
      )
      .toSorted((a, b) => b.file.mtimeMs - a.file.mtimeMs)[0] ?? null
  );
}

export async function findAntigravitySessionForCwd(
  cwd: string,
  root = antigravityConversationsRoot(),
): Promise<AntigravitySessionDescriptor | null> {
  if (!cwd) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dbPaths = entries
    .filter((e) => e.isFile() && e.name.endsWith(".db"))
    .map((e) => join(root, e.name));

  const descriptors = (
    await Promise.all(dbPaths.map((p) => describeAntigravitySessionPath(p)))
  ).filter((d): d is AntigravitySessionDescriptor => !!d);

  return (
    descriptors
      .filter(
        (item) => !!item.session.cwd && sameDirectory(item.session.cwd, cwd),
      )
      .toSorted((a, b) => b.file.mtimeMs - a.file.mtimeMs)[0] ?? null
  );
}

export async function readAntigravitySessionRecords(
  dbPath: string,
): Promise<Record<string, unknown>[]> {
  try {
    return withTempDb(dbPath, (db) => {
      let globalModelName: string | undefined;
      const tokenUsageByStepIndex = new Map<number, TokenUsage>();

      try {
        const genRows = db
          .query("SELECT * FROM gen_metadata ORDER BY idx ASC")
          .all() as {
          idx: number;
          data: Uint8Array;
        }[];
        for (const r of genRows) {
          try {
            const fields = decodeProto(r.data);
            const f1 = fields.find((f) => f.fieldNum === 1);
            if (!f1) continue;
            const f1sub = decodeProto(f1.val);
            const f19 = f1sub.find((f) => f.fieldNum === 19);
            if (f19) globalModelName = toUtf8String(f19.val);

            const f4 = f1sub.find((f) => f.fieldNum === 4);
            let usage: TokenUsage | undefined;
            if (f4) {
              const f4sub = decodeProto(f4.val);
              const inTok = Number(f4sub.find((f) => f.fieldNum === 2)?.val);
              const outTok = Number(f4sub.find((f) => f.fieldNum === 3)?.val);
              const cachedTok = Number(
                f4sub.find((f) => f.fieldNum === 9)?.val,
              );
              usage = {
                input_tokens: Number.isFinite(inTok) ? inTok : undefined,
                output_tokens: Number.isFinite(outTok) ? outTok : undefined,
                cached_input_tokens: Number.isFinite(cachedTok)
                  ? cachedTok
                  : undefined,
                total_tokens:
                  (Number.isFinite(inTok) ? inTok : 0) +
                    (Number.isFinite(outTok) ? outTok : 0) || undefined,
              };
            }

            if (usage) {
              let lastStepIndex: number | undefined;
              for (const f20 of f1sub.filter((f) => f.fieldNum === 20)) {
                const kv = decodeProto(f20.val);
                const k = kv.find((x) => x.fieldNum === 1);
                const v = kv.find((x) => x.fieldNum === 2);
                if (k && v && toUtf8String(k.val) === "last_step_index") {
                  lastStepIndex = parseInt(toUtf8String(v.val), 10);
                }
              }
              if (lastStepIndex !== undefined) {
                tokenUsageByStepIndex.set(lastStepIndex, usage);
              }
            }
          } catch {
            // Ignore malformed row in gen_metadata
          }
        }
      } catch {
        // Table gen_metadata missing or schema changed
      }

      type StepRow = {
        idx: number;
        step_type: number;
        metadata: Uint8Array | null;
        step_payload: Uint8Array | null;
        error_details: Uint8Array | null;
      };
      let steps: StepRow[];
      try {
        steps = db
          .query("SELECT * FROM steps ORDER BY idx ASC")
          .all() as StepRow[];
      } catch {
        // Table steps missing or schema bumped — fail soft with empty records
        return [];
      }

      const records: Record<string, unknown>[] = [];

      for (const s of steps) {
        try {
          const meta = decodeProto(s.metadata);
          const payload = decodeProto(s.step_payload);

          let date = new Date(0);
          const tsField = meta.find((f) => f.fieldNum === 1);
          if (tsField && tsField.val) {
            const sub = decodeProto(tsField.val);
            const sec = sub.find((f) => f.fieldNum === 1);
            if (sec) date = new Date(Number(sec.val) * 1000);
          }
          const timestamp = date.toISOString();

          // Tool call? (metadata field 4)
          const f4 = meta.find((f) => f.fieldNum === 4);
          if (f4 && f4.val) {
            const sub = decodeProto(f4.val);
            const sf1 = sub.find((f) => f.fieldNum === 1);
            const sf2 = sub.find((f) => f.fieldNum === 2);
            const sf3 = sub.find((f) => f.fieldNum === 3);

            const toolCallId = sf1 ? toUtf8String(sf1.val) : `call_${s.idx}`;
            const toolName = sf2 ? toUtf8String(sf2.val) : "tool";
            const argsRaw = sf3 ? toUtf8String(sf3.val) : "{}";
            let parsedArgs: Record<string, unknown>;
            try {
              const parsed = JSON.parse(argsRaw);
              parsedArgs = isRecord(parsed) ? parsed : { value: parsed };
            } catch {
              parsedArgs = { value: argsRaw };
            }

            records.push({
              type: "assistant",
              timestamp,
              tool_calls: [
                {
                  id: toolCallId,
                  name: toolName,
                  arguments: parsedArgs,
                },
              ],
              model: globalModelName,
            });

            // Tool result (payload field 140)
            const f140 = payload.find((f) => f.fieldNum === 140);
            if (f140 && f140.val) {
              const resSub = decodeProto(f140.val);
              const sfOut = resSub.find((f) => f.fieldNum === 2);
              const outText = sfOut ? extractToolOutputText(sfOut.val) : "";
              records.push({
                type: "tool_result",
                timestamp,
                tool_call_id: toolCallId,
                tool_name: toolName,
                content: outText,
              });
            }
            continue;
          }

          // User input (step_type 14)
          if (s.step_type === 14) {
            const f19 = payload.find((f) => f.fieldNum === 19);
            if (f19 && f19.val) {
              const sub = decodeProto(f19.val);
              const sf2 = sub.find((f) => f.fieldNum === 2);
              if (sf2 && sf2.val) {
                records.push({
                  type: "user",
                  timestamp,
                  content: toUtf8String(sf2.val).trim(),
                });
              }
            }
            continue;
          }

          // Planner response (step_type 15)
          if (s.step_type === 15) {
            const f20 = payload.find((f) => f.fieldNum === 20);
            if (f20 && f20.val) {
              const sub = decodeProto(f20.val);
              const sf1 =
                sub.find((f) => f.fieldNum === 1) ||
                sub.find((f) => f.fieldNum === 8);
              const sf3 = sub.find((f) => f.fieldNum === 3);
              const text = sf1 && sf1.val ? toUtf8String(sf1.val).trim() : "";
              const thought =
                sf3 && sf3.val ? toUtf8String(sf3.val).trim() : "";

              const usage = tokenUsageByStepIndex.get(s.idx);

              if (text) {
                records.push({
                  type: "assistant",
                  timestamp,
                  content: text,
                  reasoning: thought || undefined,
                  usage,
                  model: globalModelName,
                });
              } else if (thought) {
                records.push({
                  type: "reasoning",
                  timestamp,
                  summary: thought,
                  usage,
                  model: globalModelName,
                });
              }
            }
            continue;
          }

          // System message (step_type 101)
          if (s.step_type === 101) {
            const f114 = payload.find((f) => f.fieldNum === 114);
            if (f114 && f114.val) {
              records.push({
                type: "system",
                timestamp,
                content: toUtf8String(f114.val).trim(),
              });
            }
            continue;
          }

          // Error message (step_type 17)
          if (s.step_type === 17) {
            const f24 = payload.find((f) => f.fieldNum === 24);
            if (f24 && f24.val) {
              const err = toUtf8String(f24.val).trim();
              records.push({
                type: "assistant",
                timestamp,
                content: `Error: ${err}`,
                error_message: err,
                is_error: true,
              });
            }
            continue;
          }
        } catch {
          // Fail soft on malformed individual step record
          continue;
        }
      }

      return records;
    });
  } catch {
    // Fail soft when opening or reading the database fails
    return [];
  }
}
