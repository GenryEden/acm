import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withSandbox } from "../helpers/sandbox.ts";
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";

let s: ReturnType<typeof withSandbox>;
beforeAll(() => {
  s = withSandbox();
});
afterAll(() => s.restore());

describe("list (T024-T026, T012: --project = subtree)", () => {
  it("lists pi sessions with metadata", () => {
    const sessions = piAdapter.listSessions();
    expect(sessions).toHaveLength(4); // project, project/sub, /tmp/scratch, null-cwd
    const meta = sessions.find(
      (s) => s.sessionId === "0192aaaa-0000-7000-8000-000000000001",
    )!;
    expect(meta.agent).toBe("pi");
    expect(meta.cwd).toBe("/Users/test/project");
    expect(meta.title).toBe("Please read src/app.ts");
    expect(meta.startedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(meta.lastActivityAt).toBe("2026-01-01T10:00:06.000Z");
  });

  it("lists opencode sessions with metadata", () => {
    const sessions = opencodeAdapter.listSessions();
    expect(sessions).toHaveLength(3); // project, project/sub, /tmp/scratch (null-cwd impossible: directory NOT NULL)
    const sample = sessions.find((s) => s.sessionId === "ses_sample0001session")!;
    expect(sample.cwd).toBe("/Users/test/project");
  });

  it("lists codex sessions with title from session_index", () => {
    const sessions = codexAdapter.listSessions();
    expect(sessions).toHaveLength(4); // project, project/sub, /tmp/scratch, null-cwd
    const sample = sessions.find(
      (s) => s.sessionId === "0192cccc-0000-7000-8000-000000000003",
    )!;
    expect(sample.title).toBe("Please read src/app.ts");
  });

  it("filters by project subtree: root matches itself and nested cwds (FR-012)", () => {
    // root itself
    expect(piAdapter.listSessions({ project: "/Users/test/project" })).toHaveLength(2); // + project/sub
    expect(opencodeAdapter.listSessions({ project: "/Users/test/project" })).toHaveLength(2);
    expect(codexAdapter.listSessions({ project: "/Users/test/project" })).toHaveLength(2);
    // nested only
    expect(piAdapter.listSessions({ project: "/Users/test/project/sub" })).toHaveLength(1);
    expect(codexAdapter.listSessions({ project: "/Users/test/project/sub" })).toHaveLength(1);
    // outside root
    expect(piAdapter.listSessions({ project: "/tmp/scratch" })).toHaveLength(1);
    expect(opencodeAdapter.listSessions({ project: "/tmp/scratch" })).toHaveLength(1);
    expect(codexAdapter.listSessions({ project: "/tmp/scratch" })).toHaveLength(1);
    // wider root covers several fixtures at once
    expect(piAdapter.listSessions({ project: "/Users/test" })).toHaveLength(2);
    expect(piAdapter.listSessions({ project: "/tmp" })).toHaveLength(1);
  });

  it("filters exclude sibling dirs with a common name prefix and parents of the root", () => {
    expect(piAdapter.listSessions({ project: "/Users/test/proj" })).toHaveLength(0); // sibling-prefix of .../project
    expect(piAdapter.listSessions({ project: "/Users/test/project/sub/deeper" })).toHaveLength(0); // below fixtures
    expect(piAdapter.listSessions({ project: "/Users/test/pro" })).toHaveLength(0);
  });

  it("filters never match null-cwd sessions (FR-004)", () => {
    // /Users covers project + sub but not the null-cwd pi session
    const scoped = piAdapter.listSessions({ project: "/Users" });
    expect(scoped.some((s) => s.sessionId === "0192aaaa-0000-7000-8000-000000000013")).toBe(false);
    // null-cwd sessions are only visible without a filter
    const all = piAdapter.listSessions();
    expect(all.some((s) => s.sessionId === "0192aaaa-0000-7000-8000-000000000013")).toBe(true);
    expect(codexAdapter.listSessions().some((s) => s.sessionId === "0192cccc-0000-7000-8000-000000000015")).toBe(true);
  });

  it("normalizes paths on both sides of the comparison (FR-008)", () => {
    expect(piAdapter.listSessions({ project: "/Users/test/project/" })).toHaveLength(2);
    expect(piAdapter.listSessions({ project: "/Users/test/project/../project" })).toHaveLength(2);
    expect(piAdapter.listSessions({ project: "/Users/test/./project" })).toHaveLength(2);
  });

  it("returns empty list (not an error) when storage is missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acm-empty-"));
    const prev = process.env.ACM_HOME;
    process.env.ACM_HOME = home;
    try {
      expect(piAdapter.listSessions()).toEqual([]);
      expect(codexAdapter.listSessions()).toEqual([]);
      expect(opencodeAdapter.listSessions()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.ACM_HOME;
      else process.env.ACM_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
