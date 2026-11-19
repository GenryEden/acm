import fs from "node:fs";
import path from "node:path";
import { homeDir, isWithin } from "../../core/paths.ts";
import {
  assistantMessage,
  serviceEventItem,
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

const SUPPORTED_SESSION_VERSIONS = ["3"];

export interface PiRecord {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiMessage {
  role: string;
  content?: PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export function piSessionsRoot(): string {
  return path.join(homeDir(), ".pi", "agent", "sessions");
}

export function readPiLines(filePath: string): PiRecord[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const records: PiRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as PiRecord);
    } catch {
      // tolerate torn tail writes: skip unparsable line
    }
  }
  return records;
}

export function findAllPiSessionFiles(): { file: string; records: PiRecord[] }[] {
  const root = piSessionsRoot();
  if (!fs.existsSync(root)) {
    throw new StorageNotFoundError("pi", root);
  }
  const out: { file: string; records: PiRecord[] }[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dirPath, f);
      try {
        out.push({ file, records: readPiLines(file) });
      } catch {
        // unreadable file: skip in listing
      }
    }
  }
  return out;
}

/** Strip spec-kit prompt noise ("## User Input", code fences) from a title. */
function cleanTitle(text: string): string {
  return text
    .replace(/^##\s*User Input\s*/i, "")
    .replace(/^```\w*\s*/i, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstUserText(records: PiRecord[]): string | null {
  for (const r of records) {
    if (r.type !== "message") continue;
    const msg = r.message as PiMessage | undefined;
    if (msg?.role !== "user") continue;
    const text = cleanTitle(
      (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" "),
    );
    if (text) return text.slice(0, 120);
  }
  return null;
}

export function listPiSessions(filter?: ListFilter): ChatSessionMeta[] {
  let sessions: { file: string; records: PiRecord[] }[];
  try {
    sessions = findAllPiSessionFiles();
  } catch (err) {
    if (err instanceof StorageNotFoundError) return [];
    throw err;
  }
  const out: ChatSessionMeta[] = [];
  for (const { records } of sessions) {
    const session = records.find((r) => r.type === "session");
    if (!session) continue;
    const cwd = (session.cwd as string | undefined) ?? null;
    if (filter?.project && !isWithin(cwd, filter.project)) continue;
    const timestamps = records
      .map((r) => r.timestamp)
      .filter((t): t is string => typeof t === "string");
    out.push({
      agent: "pi",
      sessionId: session.id as string,
      title: firstUserText(records),
      cwd,
      startedAt: timestamps[0] ?? null,
      lastActivityAt: timestamps[timestamps.length - 1] ?? null,
      messageCount: records.filter((r) => r.type === "message").length,
    });
  }
  return out.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

export function findPiSessionFile(sessionId: string): { file: string; records: PiRecord[] } {
  const candidates = findAllPiSessionFiles();
  const byId = candidates.find(({ records }) =>
    records.some((r) => r.type === "session" && r.id === sessionId),
  );
  if (byId) return byId;
  const byName = candidates.find(({ file }) => path.basename(file).includes(sessionId));
  if (byName) return byName;
  throw new SessionNotFoundError("pi", sessionId);
}

export function exportPiSession(sessionId: string): TransferPackage {
  const { records } = findPiSessionFile(sessionId);
  const session = records.find((r) => r.type === "session");
  if (!session) {
    throw new SessionNotFoundError("pi", sessionId);
  }
  const version = String(session.version ?? "unknown");
  if (!SUPPORTED_SESSION_VERSIONS.includes(version)) {
    throw new UnsupportedFormatError(
      "pi",
      `session record version ${version}`,
      SUPPORTED_SESSION_VERSIONS.map((v) => `session v${v}`),
    );
  }

  const omitted: OutOfScopeEntry[] = [];
  const items: HistoryItem[] = [];
  let position = 0;
  // toolCall id -> item index (to attach results, FR-004)
  const pendingToolCalls = new Map<string, number>();

  for (const r of records) {
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    if (r.type === "session") continue;
    if (r.type === "model_change" || r.type === "thinking_level_change") {
      omitted.push({ kind: r.type, reason: "agent configuration, out of transfer scope (FR-017)" });
      continue;
    }
    if (r.type !== "message") {
      items.push(serviceEventItem(position++, ts, { sourceType: r.type, payload: r }));
      continue;
    }
    const msg = r.message as PiMessage;
    if (msg.role === "system") {
      omitted.push({ kind: "system_message", reason: "system prompt, out of transfer scope (FR-017)" });
      continue;
    }
    if (msg.role === "user") {
      const text = (msg.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      if (text.trim()) items.push(userMessage(position++, ts, text));
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = msg.content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      const thinking = blocks
        .filter((b) => b.type === "thinking")
        .map((b) => b.thinking ?? "")
        .join("\n");
      if (text.trim() || thinking.trim()) {
        items.push(assistantMessage(position++, ts, text, thinking.trim() || null));
      }
      for (const b of blocks) {
        if (b.type === "toolCall" && b.id) {
          items.push(
            toolCall(position++, ts, {
              name: b.name ?? "unknown",
              arguments: b.arguments ?? {},
              result: null,
            }),
          );
          pendingToolCalls.set(b.id, items.length - 1);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      const idx = msg.toolCallId ? pendingToolCalls.get(msg.toolCallId) : undefined;
      const content = (msg.content ?? [])
        .map((b) => b.text ?? "")
        .join("\n");
      if (idx !== undefined) {
        const item = items[idx];
        if (item.tool) {
          item.tool.result = { content, isError: msg.isError === true };
        }
      } else {
        items.push(
          serviceEventItem(position++, ts, { sourceType: "orphan_toolResult", payload: r }),
        );
      }
      continue;
    }
    // unknown message role
    items.push(serviceEventItem(position++, ts, { sourceType: `message:${msg.role}`, payload: r }));
  }

  const timestamps = records
    .map((r) => r.timestamp)
    .filter((t): t is string => typeof t === "string");

  return {
    recordType: "package",
    formatVersion: 1,
    sourceAgent: "pi",
    sourceSessionId: session.id as string,
    title: firstUserText(records),
    cwd: (session.cwd as string | undefined) ?? null,
    startedAt: timestamps[0] ?? null,
    lastActivityAt: timestamps[timestamps.length - 1] ?? null,
    omitted,
    items,
  };
}
