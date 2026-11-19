import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Home directory resolution. ACM_HOME takes precedence (used by tests and
 * power users to point the tool at a sandboxed home).
 */
export function homeDir(): string {
  return process.env.ACM_HOME ?? process.env.HOME ?? os.homedir();
}

/** RFC 4122-ish UUIDv7 (time-ordered), used for new session ids. */
export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const bytes = crypto.randomBytes(16);
  // timestamp (48 bits)
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Short random id (pi-style record ids). */
export function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** pi-style session file name: 2026-10-14T10-56-51-771Z_<uuid>.jsonl */
export function piSessionFileName(sessionId: string, at = new Date()): string {
  const iso = at.toISOString();
  // YYYY-MM-DDTHH-mm-ss-sssZ
  const stamped = iso.replace(/(\d\d):(\d\d):(\d\d)\.(\d\d\d)/, "$1-$2-$3-$4");
  return `${stamped}_${sessionId}.jsonl`;
}

/**
 * pi-style cwd slug for the session directory (native scheme, verified
 * against pi 1.2.0 `getDefaultSessionDirPath`): the resolved cwd without its
 * leading separator, every `/`, `\` and `:` replaced by `-`, wrapped in
 * double dashes — e.g. `/Users/x/proj` → `--Users-x-proj--`.
 */
export function piSlug(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function toIso(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

/**
 * Lexically normalize a path for scope comparison (FR-008): absolute, `..` and
 * `.` segments resolved, trailing separators collapsed. No filesystem access.
 */
export function normalizeScopePath(p: string): string {
  return path.resolve(p);
}

/**
 * Subtree predicate for list scoping (FR-001, FR-012): `cwd` matches `root`
 * when it equals `root` or is nested under it. `cwd === null` never matches
 * (FR-004). Pure string logic — no fs calls (FR-011).
 */
export function isWithin(cwd: string | null, root: string): boolean {
  if (cwd === null) return false;
  const c = normalizeScopePath(cwd);
  const r = normalizeScopePath(root);
  if (c === r) return true;
  // the filesystem root is the only root whose separator is already there
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

export function nowIso(): string {
  return new Date().toISOString();
}
