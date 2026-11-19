import type { HistoryItemKind } from "../core/history.ts";
import type { TransferPackage } from "../core/package.ts";
import type { TransferReport } from "../core/report.ts";

/** Listing projection of a native agent session (full content via exportSession). */
export interface ChatSessionMeta {
  agent: string;
  sessionId: string;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  messageCount: number | null;
}

export interface ListFilter {
  /**
   * Subtree root for project scoping (FR-001, FR-012): a session matches when
   * its cwd equals `project` or is nested under it. Comparison uses lexically
   * normalized absolute paths (FR-008); a null cwd never matches (FR-004).
   */
  project?: string;
}

export interface ImportOptions {
  /** Target project directory for the new session (placement only; FR-012). */
  project?: string;
}

export interface ImportResult {
  newSessionId: string;
}

export interface AgentAdapter {
  id: string;
  /** History item kinds this agent's storage can express natively (FR-005). */
  capabilities: { itemKinds: HistoryItemKind[] };
  /** Human-readable path of the native storage (for diagnostics). */
  storagePath(): string;
  listSessions(filter?: ListFilter): ChatSessionMeta[];
  exportSession(sessionId: string): TransferPackage;
  importSession(pkg: TransferPackage, opts?: ImportOptions): ImportResult;
}

export class SessionNotFoundError extends Error {
  constructor(agent: string, sessionId: string) {
    super(`session "${sessionId}" not found in agent "${agent}" storage`);
    this.name = "SessionNotFoundError";
  }
}

export class UnsupportedFormatError extends Error {
  constructor(
    public readonly agent: string,
    public readonly detail: string,
    public readonly supported: string[],
  ) {
    super(
      `unsupported ${agent} storage format: ${detail} (supported: ${supported.join(", ")})`,
    );
    this.name = "UnsupportedFormatError";
  }
}

export class StorageNotFoundError extends Error {
  constructor(agent: string, public readonly path: string) {
    super(`${agent} storage not found at ${path}`);
    this.name = "StorageNotFoundError";
  }
}

export class WriteFailureError extends Error {
  constructor(agent: string, detail: string) {
    super(`failed to write to ${agent} storage: ${detail}`);
    this.name = "WriteFailureError";
  }
}
