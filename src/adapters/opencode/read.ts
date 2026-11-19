import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homeDir, isWithin, toIso } from "../../core/paths.ts";
import {
  assistantMessage,
  fileChangeItem,
  toolCall,
  userMessage,
  type HistoryItem,
} from "../../core/history.ts";
import type { OutOfScopeEntry, TransferPackage } from "../../core/package.ts";
import {
  SessionNotFoundError,
  StorageNotFoundError,
  UnsupportedFormatError,
  type ChatSessionMeta,
  type ListFilter,
} from "../types.ts";

const REQUIRED_TABLES = ["session", "message", "part", "session_message"];

export function opencodeDbPath(): string {
  return path.join(homeDir(), ".local", "share", "opencode", "opencode.db");
}

export function opencodeStorageRoot(): string {
  return path.join(homeDir(), ".local", "share", "opencode", "storage");
}

function openDb(readonly: boolean): DatabaseSync {
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new StorageNotFoundError("opencode", dbPath);
  }
  const db = new DatabaseSync(dbPath, { readOnly: readonly });
  const tables = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length > 0) {
    db.close();
    throw new UnsupportedFormatError(
      "opencode",
      `database is missing tables: ${missing.join(", ")}`,
      ["opencode.db with session/message/part/session_message schema"],
    );
  }
  return db;
}

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

export function listOpencodeSessions(filter?: ListFilter): ChatSessionMeta[] {
  let db: DatabaseSync;
  try {
    db = openDb(true);
  } catch (err) {
    if (err instanceof StorageNotFoundError) return [];
    throw err;
  }
  try {
    const rows = db
      .prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC",
      )
      .all() as unknown as SessionRow[];
    return rows
      .filter((r) => !filter?.project || isWithin(r.directory, filter.project))
      .map((r) => ({
        agent: "opencode",
        sessionId: r.id,
        title: r.title || null,
        cwd: r.directory,
        startedAt: toIso(r.time_created),
        lastActivityAt: toIso(r.time_updated),
        messageCount: null,
      }));
  } finally {
    db.close();
  }
}

interface MessageData {
  role?: string;
  [key: string]: unknown;
}

interface PartData {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  hash?: string;
  files?: string[];
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    time?: { start?: number; end?: number };
  };
  [key: string]: unknown;
}

function textOfParts(parts: PartData[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function loadSessionDiff(sessionId: string): HistoryItem[] {
  const diffFile = path.join(opencodeStorageRoot(), "session_diff", `${sessionId}.json`);
  if (!fs.existsSync(diffFile)) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(diffFile, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const items: HistoryItem[] = [];
  let position = 100_000; // appended after conversation items; renumbered by caller
  for (const entry of entries) {
    const e = entry as Record<string, unknown>;
    items.push(
      fileChangeItem(position++, null, {
        path: String(e.path ?? e.file ?? e.filename ?? "unknown"),
        changeType: (["create", "modify", "delete"].includes(String(e.type))
          ? String(e.type)
          : "unknown") as "create" | "modify" | "delete" | "unknown",
        diff: typeof e.diff === "string" ? e.diff : JSON.stringify(entry),
      }),
    );
  }
  return items;
}

export function exportOpencodeSession(sessionId: string): TransferPackage {
  const db = openDb(true);
  try {
    const session = db
      .prepare(
        "SELECT id, title, directory, time_created, time_updated FROM session WHERE id = ?",
      )
      .get(sessionId) as unknown as SessionRow | undefined;
    if (!session) {
      throw new SessionNotFoundError("opencode", sessionId);
    }

    const omitted: OutOfScopeEntry[] = [];
    const items: HistoryItem[] = [];
    let position = 0;

    const messages = db
      .prepare(
        `SELECT id, data, time_created
         FROM message
         WHERE session_id = ?
         ORDER BY time_created, id`,
      )
      .all(sessionId) as unknown as { id: string; data: string; time_created: number }[];

    for (const msg of messages) {
      let data: MessageData;
      try {
        data = JSON.parse(msg.data) as MessageData;
      } catch {
        continue;
      }
      const role = data.role;
      const ts = toIso(msg.time_created);
      const parts = (
        db
          .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY rowid")
          .all(msg.id) as unknown as { data: string }[]
      )
        .map((r) => JSON.parse(r.data) as PartData);

      if (role === "user") {
        const text = textOfParts(parts);
        if (text.trim()) items.push(userMessage(position++, ts, text));
      } else if (role === "assistant") {
        const text = textOfParts(parts);
        const thinking = parts
          .filter((p) => p.type === "reasoning" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
        if (text.trim() || thinking.trim()) {
          items.push(assistantMessage(position++, ts, text, thinking.trim() || null));
        }
        for (const p of parts) {
          if (p.type === "tool") {
            items.push(
              toolCall(position++, ts, {
                name: p.tool ?? "unknown",
                arguments: p.state?.input ?? {},
                result:
                  p.state?.output != null
                    ? {
                        content: String(p.state.output),
                        isError: p.state?.status != null && p.state.status !== "completed",
                      }
                    : null,
              }),
            );
          } else if (p.type === "patch" && Array.isArray(p.files)) {
            for (const file of p.files) {
              items.push(
                fileChangeItem(position++, ts, {
                  path: String(file),
                  changeType: "unknown",
                  diff: typeof p.hash === "string" ? `patch hash: ${p.hash}` : null,
                }),
              );
            }
          }
        }
      } else {
        // system or unknown roles: out of scope / structural noise
        omitted.push({
          kind: `message:${role ?? "unknown"}`,
          reason: "not user-visible conversation history",
        });
      }
      // step-start/step-finish parts are structural noise, not history
    }

    // session diffs (file changes) — appended after conversation
    const diffItems = loadSessionDiff(sessionId);
    for (const item of diffItems) {
      item.position = position++;
      items.push(item);
    }

    return {
      recordType: "package",
      formatVersion: 1,
      sourceAgent: "opencode",
      sourceSessionId: session.id,
      title: session.title || null,
      cwd: session.directory,
      startedAt: toIso(session.time_created),
      lastActivityAt: toIso(session.time_updated),
      omitted,
      items,
    };
  } finally {
    db.close();
  }
}
