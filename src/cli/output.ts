import type { TransferReport } from "../core/report.ts";
import type { ChatSessionMeta } from "../adapters/types.ts";
import { normalizeScopePath } from "../core/paths.ts";

/** Single-line, truncated display text for a title. */
export function displayTitle(title: string | null, max = 40): string {
  if (!title) return "";
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Human-readable table output for `list`. */
export function renderSessionsTable(sessions: ChatSessionMeta[]): string {
  const header = ["AGENT", "SESSION ID", "TITLE", "CWD", "LAST ACTIVITY"];
  const rows = sessions.map((s) => [
    s.agent,
    s.sessionId,
    displayTitle(s.title),
    s.cwd ?? "",
    s.lastActivityAt ? s.lastActivityAt.replace(/\.\d+Z$/, "Z").replace("T", " ") : "",
  ]);
  const widths = header.map((h, i) =>
    Math.min(60, Math.max(h.length, ...rows.map((r) => r[i].length))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

const UNKNOWN_PROJECT_LABEL = "(unknown project)";

/**
 * Grouped human-readable output for `acm list -A` (FR-003, FR-009): one
 * header per project directory (ascending), sessions of the group listed in a
 * table without the CWD column (the path is in the header); null-cwd sessions
 * form the `(unknown project)` group, always last (FR-004).
 */
export function renderGroupedSessions(sessions: ChatSessionMeta[]): string {
  const groups = new Map<string, ChatSessionMeta[]>();
  for (const s of sessions) {
    const key = s.cwd === null ? UNKNOWN_PROJECT_LABEL : normalizeScopePath(s.cwd);
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === UNKNOWN_PROJECT_LABEL) return 1; // unknown group is always last
    if (b === UNKNOWN_PROJECT_LABEL) return -1;
    return a < b ? -1 : a > b ? 1 : 0; // deterministic (code-unit) order
  });
  const parts: string[] = [];
  for (const key of keys) {
    const group = groups.get(key)!;
    parts.push(`${key} (${group.length} session${group.length === 1 ? "" : "s"})`);
    parts.push(renderGroupTable(group));
  }
  return parts.join("\n\n");
}

/** Table for a single project group: CWD column omitted (it is the header). */
function renderGroupTable(sessions: ChatSessionMeta[]): string {
  const header = ["AGENT", "SESSION ID", "TITLE", "LAST ACTIVITY"];
  const rows = sessions.map((s) => [
    s.agent,
    s.sessionId,
    displayTitle(s.title),
    s.lastActivityAt ? s.lastActivityAt.replace(/\.\d+Z$/, "Z").replace("T", " ") : "",
  ]);
  const widths = header.map((h, i) =>
    Math.min(60, Math.max(h.length, ...rows.map((r) => r[i].length))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** Human-readable report output for import/transfer (contracts/cli.md format). */
export function renderReport(report: TransferReport, targetAgent?: string): string {
  const t = report.transferred;
  const lines: string[] = [];
  if (targetAgent && report.newSessionId) {
    lines.push(`Transferred to ${targetAgent}: session ${report.newSessionId}`);
  } else if (report.newSessionId) {
    lines.push(`New session: ${report.newSessionId}`);
  }
  lines.push(
    `  messages:        ${t.userMessages + t.assistantMessages} (user: ${t.userMessages}, assistant: ${t.assistantMessages})`,
  );
  lines.push(`  tool calls:      ${t.toolCalls}`);
  lines.push(`  file changes:    ${t.fileChanges}`);
  lines.push(`  service events:  ${t.serviceEvents}`);
  lines.push(`  skipped:         ${report.skipped.length}`);
  // Aggregate identical skip reasons: a long history can skip hundreds of
  // service_event entries and listing each one line-by-line is pure noise.
  const skipGroups = new Map<string, { count: number; first: number }>();
  for (const s of report.skipped) {
    const key = `${s.kind}: ${s.reason}`;
    const g = skipGroups.get(key);
    if (g) g.count++;
    else skipGroups.set(key, { count: 1, first: s.position });
  }
  for (const [key, g] of skipGroups) {
    lines.push(
      g.count === 1
        ? `    - [pos ${g.first}] ${key}`
        : `    - ${g.count} × ${key}`,
    );
  }
  lines.push(
    `  out of scope:    ${report.outOfScope.length} (system prompt, model config — not transferred by design)`,
  );
  if (report.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const w of report.warnings) {
      lines.push(`    ! ${w}`);
    }
  }
  return lines.join("\n");
}

/** Short export statistics line (contracts/cli.md). */
export function renderExportStats(
  counts: { messages: number; toolCalls: number; fileChanges: number },
  total: number,
  out: string,
): string {
  return `Exported ${total} items to ${out} (${counts.messages} messages, ${counts.toolCalls} tool calls, ${counts.fileChanges} file changes)`;
}

export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
