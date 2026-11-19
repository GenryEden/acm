import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HistoryItemSchema, type HistoryItem } from "./history.ts";

export const FORMAT_VERSION = 1 as const;

export const OutOfScopeEntrySchema = z.object({
  kind: z.string(),
  reason: z.string(),
});
export type OutOfScopeEntry = z.infer<typeof OutOfScopeEntrySchema>;

export const PackageHeaderSchema = z.object({
  recordType: z.literal("package"),
  formatVersion: z.literal(FORMAT_VERSION),
  sourceAgent: z.string().min(1),
  sourceSessionId: z.string().min(1),
  title: z.string().nullable(),
  cwd: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  /** What the source omitted by design (FR-017: config, system prompts). */
  omitted: z.array(OutOfScopeEntrySchema).default([]),
});

export type PackageHeader = z.infer<typeof PackageHeaderSchema>;

export interface TransferPackage extends PackageHeader {
  items: HistoryItem[];
}

export class PackageValidationError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
    public readonly expectedVersion?: number,
  ) {
    super(message);
    this.name = "PackageValidationError";
  }
}

export class OutputExistsError extends Error {
  constructor(public readonly filePath: string) {
    super(`output file already exists: ${filePath}`);
    this.name = "OutputExistsError";
  }
}

/**
 * Read a TransferPackage file (JSONL: header record + item records).
 * Validates structure and format version; errors carry the offending line number.
 */
export function readPackage(filePath: string): TransferPackage {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new PackageValidationError(
      `cannot read package file "${filePath}": ${(err as Error).message}`,
    );
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new PackageValidationError(`package file "${filePath}" is empty`, 0, FORMAT_VERSION);
  }

  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(lines[0]);
  } catch (err) {
    throw new PackageValidationError(
      `package header (line 1) is not valid JSON: ${(err as Error).message}`,
      1,
      FORMAT_VERSION,
    );
  }

  const version = (headerRaw as { formatVersion?: unknown })?.formatVersion;
  if (typeof version === "number" && version !== FORMAT_VERSION) {
    throw new PackageValidationError(
      `unsupported package formatVersion ${version} (expected ${FORMAT_VERSION})`,
      1,
      FORMAT_VERSION,
    );
  }

  const header = PackageHeaderSchema.safeParse(headerRaw);
  if (!header.success) {
    throw new PackageValidationError(
      `package header (line 1) failed validation: ${header.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      1,
      FORMAT_VERSION,
    );
  }

  const items: HistoryItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    let record: unknown;
    try {
      record = JSON.parse(lines[i]);
    } catch (err) {
      throw new PackageValidationError(
        `line ${i + 1} is not valid JSON: ${(err as Error).message}`,
        i + 1,
      );
    }
    const wrapped = z
      .object({ recordType: z.literal("item"), item: HistoryItemSchema })
      .safeParse(record);
    if (!wrapped.success) {
      throw new PackageValidationError(
        `line ${i + 1} failed item validation: ${wrapped.error.issues
          .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
          .join("; ")}`,
        i + 1,
      );
    }
    items.push(wrapped.data.item);
  }

  // position integrity: strictly increasing
  for (let i = 1; i < items.length; i++) {
    if (items[i].position <= items[i - 1].position) {
      throw new PackageValidationError(
        `line ${i + 1}: item position ${items[i].position} is not increasing (previous ${items[i - 1].position})`,
        i + 1,
      );
    }
  }

  return { ...header.data, items };
}

/** Write a TransferPackage to a JSONL file. Refuses to overwrite unless `force`. */
export function writePackage(pkg: TransferPackage, filePath: string, force = false): void {
  if (!force && fs.existsSync(filePath)) {
    throw new OutputExistsError(filePath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const { items, ...header } = pkg;
  const lines = [JSON.stringify({ ...header, recordType: "package", formatVersion: FORMAT_VERSION })];
  for (const item of items) {
    lines.push(JSON.stringify({ recordType: "item", item }));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

/** Rough size estimate of the history payload (chars of JSON). */
export function estimateSize(pkg: TransferPackage): number {
  return pkg.items.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
}
