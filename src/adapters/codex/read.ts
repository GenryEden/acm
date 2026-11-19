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
  type ChatSessionMeta,
  type ListFilter,
} from "../types.ts";

export function codexSessionsRoot(): string {
  return path.join(homeDir(), ".codex", "sessions");
}

export function codexSessionIndexPath(): string {
  return path.join(homeDir(), ".codex", "session_index.jsonl");
}

interface RolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export function readRolloutLines(filePath: string): RolloutLine[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines: RolloutLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RolloutLine;
      if (parsed && typeof parsed.type === "string") {
        lines.push(parsed);
      }
    } catch {
      // tolerate torn tail writes
    }
  }
  return lines;
}

/** Walk sessions/YYYY/MM/DD and return all rollout files. */
export function findAllRolloutFiles(): string[] {
  const root = codexSessionsRoot();
  if (!fs.existsSync(root)) {
    throw new StorageNotFoundError("codex", root);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root);
  return files.sort();
}

function sessionIdFromFile(file: string): string | null {
  // rollout-2026-01-01T00-00-00-000Z-<uuid>.jsonl
  const m = path.basename(file).match(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+Z-(.+)\.jsonl$/);
  return m ? m[1] : null;
}

interface SessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

export function readSessionIndex(): SessionIndexEntry[] {
  const idx = codexSessionIndexPath();
  if (!fs.existsSync(idx)) return [];
  const out: SessionIndexEntry[] = [];
  for (const line of fs.readFileSync(idx, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SessionIndexEntry;
      if (e && typeof e.id === "string") out.push(e);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function listCodexSessions(filter?: ListFilter): ChatSessionMeta[] {
  let files: string[];
  try {
    files = findAllRolloutFiles();
  } catch (err) {
    if (err instanceof StorageNotFoundError) return [];
    throw err;
  }
  const index = new Map(readSessionIndex().map((e) => [e.id, e]));
  const out: ChatSessionMeta[] = [];
  for (const file of files) {
    const lines = readRolloutLines(file);
    const meta = lines.find((l) => l.type === "session_meta");
    if (!meta) continue;
    const payload = meta.payload as { session_id?: string; cwd?: string; timestamp?: string };
    const id = payload.session_id ?? sessionIdFromFile(file);
    if (!id) continue;
    const cwd = payload.cwd ?? null;
    if (filter?.project && !isWithin(cwd, filter.project)) continue;
    const lastTs = lines.length > 0 ? lines[lines.length - 1].timestamp : null;
    out.push({
      agent: "codex",
      sessionId: id,
      title: index.get(id)?.thread_name ?? null,
      cwd,
      startedAt: payload.timestamp ?? meta.timestamp,
      lastActivityAt: lastTs,
      messageCount: lines.filter(
        (l) =>
          l.type === "response_item" &&
          (l.payload as { type?: string }).type === "message",
      ).length,
    });
  }
  return out.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
}

export function findRolloutFile(sessionId: string): string {
  const files = findAllRolloutFiles();
  const byId = files.find((f) => sessionIdFromFile(f) === sessionId);
  if (byId) return byId;
  const byName = files.find((f) => path.basename(f).includes(sessionId));
  if (byName) return byName;
  // fall back to session_meta lookup
  for (const f of files) {
    const lines = readRolloutLines(f);
    const meta = lines.find((l) => l.type === "session_meta");
    if (meta && (meta.payload as { session_id?: string }).session_id === sessionId) return f;
  }
  throw new SessionNotFoundError("codex", sessionId);
}

export function exportCodexSession(sessionId: string): TransferPackage {
  const file = findRolloutFile(sessionId);
  const lines = readRolloutLines(file);
  const meta = lines.find((l) => l.type === "session_meta");
  if (!meta) throw new SessionNotFoundError("codex", sessionId);
  const metaPayload = meta.payload as {
    session_id?: string;
    cwd?: string;
    timestamp?: string;
  };

  const omitted: OutOfScopeEntry[] = [];
  const items: HistoryItem[] = [];
  let position = 0;
  const pendingToolCalls = new Map<string, number>();
  let pendingThinking: string | null = null;

  for (const line of lines) {
    const ts = line.timestamp;
    if (line.type === "session_meta") continue;
    if (line.type === "event_msg") {
      const p = line.payload as { type?: string };
      if (p.type === "token_count") {
        omitted.push({ kind: "token_count", reason: "usage metadata, not conversation history" });
        continue;
      }
      items.push(serviceEventItem(position++, ts, { sourceType: p.type ?? "event_msg", payload: line.payload }));
      continue;
    }
    if (line.type !== "response_item") {
      items.push(serviceEventItem(position++, ts, { sourceType: line.type, payload: line.payload }));
      continue;
    }

    const p = line.payload as {
      type?: string;
      role?: string;
      content?: { type: string; text?: string }[];
      name?: string;
      arguments?: string;
      input?: unknown;
      call_id?: string;
      output?: string;
      summary?: { type: string; text?: string }[];
    };

    if (p.type === "message") {
      if (p.role === "user") {
        const text = (p.content ?? [])
          .filter((c) => c.type === "input_text" || c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (text.trim()) items.push(userMessage(position++, ts, text));
      } else if (p.role === "assistant") {
        const text = (p.content ?? [])
          .filter((c) => c.type === "output_text" || c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (text.trim() || pendingThinking) {
          items.push(assistantMessage(position++, ts, text, pendingThinking));
          pendingThinking = null;
        }
      } else {
        // developer/system messages
        omitted.push({
          kind: `message:${p.role ?? "unknown"}`,
          reason: "not user-visible conversation history",
        });
      }
      continue;
    }
    if (p.type === "reasoning") {
      const summary = (p.summary ?? [])
        .map((s) => s.text ?? "")
        .join("\n")
        .trim();
      if (summary) pendingThinking = summary;
      continue;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      let args: unknown = {};
      if (typeof p.arguments === "string") {
        try {
          args = JSON.parse(p.arguments);
        } catch {
          args = p.arguments;
        }
      } else if (p.input !== undefined) {
        args = p.input;
      }
      items.push(
        toolCall(position++, ts, {
          name: p.name ?? "unknown",
          arguments: args,
          result: null,
        }),
      );
      if (p.call_id) pendingToolCalls.set(p.call_id, items.length - 1);
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const idx = p.call_id ? pendingToolCalls.get(p.call_id) : undefined;
      if (idx !== undefined) {
        const item = items[idx];
        if (item.tool) {
          item.tool.result = {
            content: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? ""),
            isError: false,
          };
        }
      } else {
        items.push(
          serviceEventItem(position++, ts, { sourceType: "orphan_tool_output", payload: line.payload }),
        );
      }
      continue;
    }
    // unknown response_item type
    items.push(serviceEventItem(position++, ts, { sourceType: p.type ?? "unknown", payload: line.payload }));
  }

  if (pendingThinking) {
    items.push(assistantMessage(position++, null, "", pendingThinking));
  }

  const index = readSessionIndex().find((e) => e.id === sessionId);

  return {
    recordType: "package",
    formatVersion: 1,
    sourceAgent: "codex",
    sourceSessionId: metaPayload.session_id ?? sessionId,
    title: index?.thread_name ?? null,
    cwd: metaPayload.cwd ?? null,
    startedAt: metaPayload.timestamp ?? meta.timestamp,
    lastActivityAt: lines.length > 0 ? lines[lines.length - 1].timestamp : null,
    omitted,
    items,
  };
}
