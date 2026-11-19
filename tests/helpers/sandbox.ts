import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSampleOpencodeDb, type ExtraSessionSpec } from "./opencode-db.ts";
import { piSlug } from "../../src/core/paths.ts";

export interface Sandbox {
  home: string;
  /** Path passed to --project / import opts to place sessions in the sample project. */
  projectDir: string;
  cleanup: () => void;
}

/**
 * Create a sandboxed $HOME (ACM_HOME) with sanitized fixture copies:
 *  - .pi/agent/sessions/...        (from tests/fixtures/pi)
 *  - .codex/sessions/... + index   (from tests/fixtures/codex)
 *  - .local/share/opencode/opencode.db (sample data)
 * Optionally with an unsupported pi session (tests/fixtures/pi-unsupported).
 */
export function createSandbox(opts: { unsupportedPi?: boolean } = {}): Sandbox {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acm-test-"));
  const fixturesRoot = path.resolve(import.meta.dirname, "..", "fixtures");
  const projectDir = "/Users/test/project";

  // pi
  const piSrc = path.join(fixturesRoot, "pi", "sessions");
  fs.cpSync(piSrc, path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  if (opts.unsupportedPi) {
    fs.cpSync(
      path.join(fixturesRoot, "pi-unsupported", "sessions"),
      path.join(home, ".pi", "agent", "sessions"),
      { recursive: true },
    );
  }

  // codex
  fs.cpSync(
    path.join(fixturesRoot, "codex", "sessions"),
    path.join(home, ".codex", "sessions"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(fixturesRoot, "codex", "session_index.jsonl"),
    path.join(home, ".codex", "session_index.jsonl"),
  );

  // opencode: sample session + listing-only extras in other project directories
  // (nested + outside root; null-cwd is impossible — `session.directory` NOT NULL)
  const opencodeExtras: ExtraSessionSpec[] = [
    { id: "ses_sample0002session", cwd: "/Users/test/project/sub", title: "Nested project chat" },
    { id: "ses_sample0003session", cwd: "/tmp/scratch", title: "Scratch chat outside the project" },
  ];
  createSampleOpencodeDb(
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    opencodeExtras,
  );

  return {
    home,
    projectDir,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** Set ACM_HOME for in-process adapter tests; restore afterwards. */
export function withSandbox(
  opts: { unsupportedPi?: boolean } = {},
): { sandbox: Sandbox; restore: () => void } {
  const previous = process.env.ACM_HOME;
  const sandbox = createSandbox(opts);
  process.env.ACM_HOME = sandbox.home;
  return {
    sandbox,
    restore: () => {
      if (previous === undefined) delete process.env.ACM_HOME;
      else process.env.ACM_HOME = previous;
      sandbox.cleanup();
    },
  };
}

/**
 * Add a minimal pi session with an arbitrary cwd into a sandbox home — used by
 * CLI integration tests to give the default scope a real, existing directory.
 */
export function addPiSession(home: string, cwd: string | null, sessionId: string, title: string): void {
  const dir = path.join(home, ".pi", "agent", "sessions", piSlug(cwd ?? "/unknown-project"));
  fs.mkdirSync(dir, { recursive: true });
  const session: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-01-03T10:00:00.000Z",
  };
  if (cwd !== null) session.cwd = cwd;
  const lines = [
    JSON.stringify(session),
    JSON.stringify({
      type: "message",
      id: `${sessionId}-m1`,
      parentId: null,
      timestamp: "2026-01-03T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: title }], timestamp: 1767352801000 },
    }),
  ];
  fs.writeFileSync(
    path.join(dir, `2026-01-03T10-00-00-000Z_${sessionId}.jsonl`),
    lines.join("\n") + "\n",
  );
}
