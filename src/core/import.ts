import type { AgentAdapter, ImportOptions } from "../adapters/types.ts";
import type { TransferPackage } from "./package.ts";
import { estimateSize } from "./package.ts";
import {
  addSkipped,
  addWarning,
  createReport,
  tallyTransferred,
  type TransferReport,
} from "./report.ts";

/** Heuristic limit above which we warn about receiver context limits (FR-010). ~300k tokens. */
export const SIZE_WARNING_CHARS = 1_200_000;

export class NeedsForceError extends Error {
  constructor(public readonly estimatedChars: number) {
    super(
      `history is very large (~${estimatedChars} chars); rerun with --force to transfer anyway`,
    );
    this.name = "NeedsForceError";
  }
}

export interface ImportOutcome {
  newSessionId: string;
  report: TransferReport;
}

/**
 * Core import engine: filters items by receiver capabilities (skipping what the
 * receiver schema cannot express natively — FR-005), warns on size (FR-010),
 * delegates the atomic write to the adapter, and assembles the TransferReport.
 */
export function performImport(
  adapter: AgentAdapter,
  pkg: TransferPackage,
  opts: ImportOptions & { force?: boolean } = {},
): ImportOutcome {
  const report = createReport();
  report.outOfScope = pkg.omitted.map((o) => ({ ...o }));

  const kept = pkg.items.filter((item) => {
    if (adapter.capabilities.itemKinds.includes(item.kind)) {
      return true;
    }
    addSkipped(
      report,
      item.kind,
      item.position,
      `receiver schema has no native storage for ${item.kind}`,
    );
    return false;
  });

  for (const item of kept) tallyTransferred(report, item);

  const size = estimateSize({ ...pkg, items: kept });
  if (size > SIZE_WARNING_CHARS && !opts.force) {
    throw new NeedsForceError(size);
  }
  if (size > SIZE_WARNING_CHARS) {
    addWarning(
      report,
      `history exceeds recommended size (~${size} chars); transferred with --force, may exceed receiver context window`,
    );
  }

  if (opts.project && pkg.cwd && opts.project !== pkg.cwd) {
    addWarning(
      report,
      `package cwd (${pkg.cwd}) differs from target project (${opts.project}); history paths are preserved as-is (FR-012)`,
    );
  }

  if (kept.some((i) => i.kind === "tool_call")) {
    addWarning(
      report,
      "history contains raw tool outputs which may include secrets; transferred as-is without filtering",
    );
  }

  let newSessionId: string;
  try {
    const result = adapter.importSession({ ...pkg, items: kept }, opts);
    newSessionId = result.newSessionId;
  } catch (err) {
    if (err && (err as Error).name === "UnsupportedFormatError") throw err;
    throw err;
  }
  report.newSessionId = newSessionId;
  return { newSessionId, report };
}
