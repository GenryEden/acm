import type { HistoryItem, HistoryItemKind } from "./history.ts";
import type { OutOfScopeEntry } from "./package.ts";

export interface SkippedEntry {
  kind: HistoryItemKind;
  position: number;
  reason: string;
}

export interface TransferCounts {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  fileChanges: number;
  serviceEvents: number;
}

export interface TransferReport {
  transferred: TransferCounts;
  skipped: SkippedEntry[];
  outOfScope: OutOfScopeEntry[];
  warnings: string[];
  newSessionId: string | null;
}

export function createReport(): TransferReport {
  return {
    transferred: {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      fileChanges: 0,
      serviceEvents: 0,
    },
    skipped: [],
    outOfScope: [],
    warnings: [],
    newSessionId: null,
  };
}

export function tallyTransferred(report: TransferReport, item: HistoryItem): void {
  switch (item.kind) {
    case "user_message":
      report.transferred.userMessages++;
      break;
    case "assistant_message":
      report.transferred.assistantMessages++;
      break;
    case "tool_call":
      report.transferred.toolCalls++;
      break;
    case "file_change":
      report.transferred.fileChanges++;
      break;
    case "service_event":
      report.transferred.serviceEvents++;
      break;
  }
}

export function addSkipped(
  report: TransferReport,
  kind: HistoryItemKind,
  position: number,
  reason: string,
): void {
  report.skipped.push({ kind, position, reason });
}

export function addWarning(report: TransferReport, message: string): void {
  report.warnings.push(message);
}

export function totalTransferred(report: TransferReport): number {
  const t = report.transferred;
  return (
    t.userMessages + t.assistantMessages + t.toolCalls + t.fileChanges + t.serviceEvents
  );
}
