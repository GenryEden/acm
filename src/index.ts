#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import { getAdapter, listAdapters, supportedAgentIds } from "./core/registry.ts";
import { performImport } from "./core/import.ts";
import { migrateCodexRolloutForVisibility } from "./adapters/codex/write.ts";
import {
  OutputExistsError,
  PackageValidationError,
  readPackage,
  writePackage,
} from "./core/package.ts";
import { renderExportStats, renderGroupedSessions, renderJson, renderReport, renderSessionsTable } from "./cli/output.ts";
import {
  SessionNotFoundError,
  StorageNotFoundError,
  UnsupportedFormatError,
  WriteFailureError,
} from "./adapters/types.ts";
import type { ChatSessionMeta } from "./adapters/types.ts";

const EXIT = {
  SUCCESS: 0,
  USAGE: 1,
  WRITE_FAILURE: 2,
  INVALID_PACKAGE: 3,
  SESSION_NOT_FOUND: 4,
  OUTPUT_EXISTS: 5,
  SIZE_OVERFLOW: 6,
} as const;

function parseAgent(value: string): string {
  const ids = supportedAgentIds();
  if (!ids.includes(value)) {
    throw new InvalidArgumentError(`unknown agent "${value}" (supported: ${ids.join(", ")})`);
  }
  return value;
}

function defaultOut(sessionId: string): string {
  return `${sessionId}.acm.jsonl`;
}

function fail(err: unknown): never {
  const e = err as Error;
  switch (e?.name) {
    case "SessionNotFoundError":
      process.stderr.write(`error: ${e.message} — run "acm list" to discover session ids\n`);
      process.exit(EXIT.SESSION_NOT_FOUND);
    case "StorageNotFoundError":
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(EXIT.SESSION_NOT_FOUND);
    case "PackageValidationError":
      process.stderr.write(`error: invalid package — ${e.message}\n`);
      process.exit(EXIT.INVALID_PACKAGE);
    case "OutputExistsError":
      process.stderr.write(
        `error: ${e.message} — rerun with --force to overwrite\n`,
      );
      process.exit(EXIT.OUTPUT_EXISTS);
    case "NeedsForceError":
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(EXIT.SIZE_OVERFLOW);
    case "WriteFailureError":
      process.stderr.write(`error: ${e.message} — receiver storage left unchanged\n`);
      process.exit(EXIT.WRITE_FAILURE);
    case "UnsupportedFormatError":
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(EXIT.INVALID_PACKAGE);
    default:
      process.stderr.write(`error: ${e?.message ?? String(err)}\n`);
      process.exit(EXIT.USAGE);
  }
}

const program = new Command();

program
  .name("acm")
  .description("Transfer chat sessions between AI coding agents (opencode, pi, codex)")
  .version("0.1.0");

program
  .command("list")
  .description("List chat sessions available for export")
  .option("--agent <agent>", "agent to list sessions from", parseAgent)
  .option("--project <dir>", "filter sessions by project directory (subtree: cwd equals <dir> or nested under it)")
  .option("-A, --all", "list all sessions regardless of project location, grouped by project")
  .option("--json", "machine-readable JSON output")
  .action((opts) => {
    try {
      // Default scope: sessions under the current working directory (FR-001).
      // An explicit --project wins over the default (FR-006); -A disables
      // scoping but keeps an explicit --project (FR-002).
      const filter = opts.project
        ? { project: opts.project as string }
        : opts.all
          ? undefined
          : { project: process.cwd() };
      const adapters = opts.agent ? [getAdapter(opts.agent)] : listAdapters();
      const all: ChatSessionMeta[] = [];
      for (const adapter of adapters) {
        all.push(...adapter.listSessions(filter));
      }
      if (opts.json) {
        process.stdout.write(renderJson(all) + "\n");
      } else {
        // Grouped by project in -A mode (FR-003); flat table otherwise.
        // No hint text about scoping in any mode (FR-013); agents with no
        // sessions in scope are simply silent.
        const out =
          all.length > 0
            ? opts.all
              ? renderGroupedSessions(all)
              : renderSessionsTable(all)
            : "No sessions found.";
        process.stdout.write(out + "\n");
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("export")
  .description("Export a chat session to a transfer package file")
  .requiredOption("--agent <agent>", "source agent", parseAgent)
  .requiredOption("--session <id>", "session id to export")
  .option("--out <file>", "output file path")
  .option("--force", "overwrite output file if it exists")
  .action((opts) => {
    try {
      const adapter = getAdapter(opts.agent);
      const pkg = adapter.exportSession(opts.session);
      const out = opts.out ?? defaultOut(pkg.sourceSessionId);
      writePackage(pkg, out, opts.force === true);
      const messages = pkg.items.filter(
        (i) => i.kind === "user_message" || i.kind === "assistant_message",
      ).length;
      const toolCalls = pkg.items.filter((i) => i.kind === "tool_call").length;
      const fileChanges = pkg.items.filter((i) => i.kind === "file_change").length;
      process.stdout.write(
        renderExportStats({ messages, toolCalls, fileChanges }, pkg.items.length, out) + "\n",
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command("import")
  .description("Import a transfer package into an agent's storage")
  .argument("<file>", "transfer package file (.acm.jsonl)")
  .requiredOption("--to <agent>", "target agent", parseAgent)
  .option("--project <dir>", "target project directory for the new session")
  .option("--force", "proceed despite size warning")
  .option("--json", "machine-readable JSON output")
  .action((file, opts) => {
    try {
      if (!fs.existsSync(file)) {
        process.stderr.write(`error: package file not found: ${file}\n`);
        process.exit(EXIT.INVALID_PACKAGE);
      }
      const pkg = readPackage(file);
      const adapter = getAdapter(opts.to);
      const { newSessionId, report } = performImport(adapter, pkg, {
        project: opts.project,
        force: opts.force === true,
      });
      if (opts.to === "codex") migrateCodexRolloutForVisibility(newSessionId);
      if (opts.json) {
        process.stdout.write(renderJson(report) + "\n");
      } else {
        process.stdout.write(renderReport(report, opts.to) + "\n");
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("transfer")
  .description("Export from one agent and import into another in one step")
  .requiredOption("--from <agent>", "source agent", parseAgent)
  .requiredOption("--session <id>", "session id to transfer")
  .requiredOption("--to <agent>", "target agent", parseAgent)
  .option("--project <dir>", "target project directory for the new session")
  .option("--out <file>", "also save the transfer package to this file")
  .option("--force", "overwrite output file / proceed despite size warning")
  .option("--json", "machine-readable JSON output")
  .action((opts) => {
    try {
      const source = getAdapter(opts.from);
      const target = getAdapter(opts.to);
      const pkg = source.exportSession(opts.session);
      if (opts.out) {
        writePackage(pkg, opts.out, opts.force === true);
      }
      const { newSessionId, report } = performImport(target, pkg, {
        project: opts.project,
        force: opts.force === true,
      });
      if (opts.to === "codex") migrateCodexRolloutForVisibility(newSessionId);
      if (opts.json) {
        process.stdout.write(renderJson(report) + "\n");
      } else {
        process.stdout.write(renderReport(report, opts.to) + "\n");
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv).catch((err) => fail(err));
