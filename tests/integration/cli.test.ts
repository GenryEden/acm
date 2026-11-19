import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandbox, addPiSession } from "../helpers/sandbox.ts";

const CLI = path.resolve(import.meta.dirname, "..", "..", "src", "index.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd?: string): RunResult {
  const res = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd,
    timeout: 60000,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function withTmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acm-cli-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("acm CLI (T019-T023)", () => {
  it("exit 0: list --agent pi -A --json outputs all pi sessions", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const res = runCli(["list", "--agent", "pi", "-A", "--json"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveLength(4); // project, sub, scratch, null-cwd
      expect(parsed.some((s: { sessionId: string }) => s.sessionId === "0192aaaa-0000-7000-8000-000000000001")).toBe(true);
      expect(parsed.some((s: { sessionId: string }) => s.sessionId === "0192aaaa-0000-7000-8000-000000000013")).toBe(true);
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 0: list --agent pi --project <sub> --json outputs session metadata", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const res = runCli(
        ["list", "--agent", "pi", "--project", "/Users/test/project/sub", "--json"],
        { ACM_HOME: sandbox.home },
      );
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].sessionId).toBe("0192aaaa-0000-7000-8000-000000000011");
      expect(parsed[0].cwd).toBe("/Users/test/project/sub");
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 0: default list scopes to the current directory subtree (T007, FR-001)", () => {
    const sandbox = createSandbox();
    // realpath: on macOS the tmpdir symlink (/var -> /private/var) would make
    // the recorded cwd differ lexically from the child's process.cwd()
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acm-scope-")));
    try {
      // a pi session whose cwd is a real, existing directory (the CLI's cwd)
      addPiSession(sandbox.home, realDir, "0192dddd-0000-7000-8000-000000000021", "Real dir chat");
      // and one nested under it
      addPiSession(
        sandbox.home,
        path.join(realDir, "nested"),
        "0192dddd-0000-7000-8000-000000000022",
        "Nested real dir chat",
      );
      const res = runCli(["list"], { ACM_HOME: sandbox.home }, realDir);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("0192dddd-0000-7000-8000-000000000021");
      expect(res.stdout).toContain("0192dddd-0000-7000-8000-000000000022");
      // out-of-scope sessions (fictional cwds) are absent…
      expect(res.stdout).not.toContain("0192aaaa-0000-7000-8000-000000000001");
      expect(res.stdout).not.toContain("ses_sample0001session");
      expect(res.stdout).not.toContain("0192cccc-0000-7000-8000-000000000003");
      // …and so is the null-cwd session (FR-004, default side)
      expect(res.stdout).not.toContain("0192aaaa-0000-7000-8000-000000000013");
      // no hint text about the scope (FR-013) and no per-agent noise:
      // out-of-scope agents are simply silent
      expect(res.stdout).not.toContain("no sessions found");
      expect(res.stdout).not.toContain("-A");
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });

  it("exit 0: default list with an empty scope reports no sessions, exit 0 (T007, FR-010)", () => {
    const sandbox = createSandbox();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "acm-empty-scope-"));
    try {
      const res = runCli(["list"], { ACM_HOME: sandbox.home }, emptyDir);
      expect(res.code).toBe(0);
      // single clean line; no per-agent noise (FR-013)
      expect(res.stdout.trim()).toBe("No sessions found.");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });

  it("exit 0: list -A shows all sessions grouped by project (T010, FR-002/FR-003)", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(["list", "-A"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(0);
      // group headers in deterministic order, unknown last (FR-009)
      expect(res.stdout).toContain("/Users/test/project (3 sessions)");
      expect(res.stdout).toContain("/Users/test/project/sub (3 sessions)");
      expect(res.stdout).toContain("/tmp/scratch (3 sessions)");
      expect(res.stdout).toContain("(unknown project) (2 sessions)");
      const headerPositions = [
        res.stdout.indexOf("/Users/test/project ("),
        res.stdout.indexOf("/Users/test/project/sub ("),
        res.stdout.indexOf("/tmp/scratch ("),
        res.stdout.indexOf("(unknown project) ("),
      ];
      expect(headerPositions.every((p) => p >= 0)).toBe(true);
      expect([...headerPositions].sort((a, b) => a - b)).toEqual(headerPositions);
      // every session appears exactly once (SC-002)
      for (const id of [
        "0192aaaa-0000-7000-8000-000000000001",
        "0192aaaa-0000-7000-8000-000000000011",
        "0192aaaa-0000-7000-8000-000000000012",
        "0192aaaa-0000-7000-8000-000000000013",
        "ses_sample0001session",
        "ses_sample0002session",
        "ses_sample0003session",
        "0192cccc-0000-7000-8000-000000000003",
        "0192cccc-0000-7000-8000-000000000013",
        "0192cccc-0000-7000-8000-000000000014",
        "0192cccc-0000-7000-8000-000000000015",
      ]) {
        expect(res.stdout.split(id).length - 1).toBe(1);
      }
      // null-cwd sessions land in the unknown group (FR-004, -A side)
      const unknownPos = res.stdout.indexOf("(unknown project) (");
      expect(res.stdout.indexOf("0192aaaa-0000-7000-8000-000000000013", unknownPos)).toBeGreaterThan(unknownPos);
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 0: list -A --agent pi keeps grouping and agent filter (T010, FR-005)", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(["list", "-A", "--agent", "pi"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("/Users/test/project (1 session)");
      expect(res.stdout).not.toContain("ses_sample0001session");
      expect(res.stdout).not.toContain("0192cccc-0000-7000-8000-000000000003");
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 0: --json matches the equivalent human output (T011, FR-007)", () => {
    const sandbox = createSandbox();
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acm-json-")));
    try {
      addPiSession(sandbox.home, realDir, "0192dddd-0000-7000-8000-000000000031", "Real dir chat");
      const env = { ACM_HOME: sandbox.home };
      const scoped = runCli(["list", "--json"], env, realDir);
      expect(scoped.code).toBe(0);
      const scopedSessions = JSON.parse(scoped.stdout) as { sessionId: string; cwd: string | null }[];
      expect(scopedSessions).toHaveLength(1);
      expect(scopedSessions[0].sessionId).toBe("0192dddd-0000-7000-8000-000000000031");
      expect(scopedSessions[0].cwd).toBe(realDir);

      const all = runCli(["list", "-A", "--json"], env);
      expect(all.code).toBe(0);
      const allSessions = JSON.parse(all.stdout) as { sessionId: string }[];
      // flat array, same record shape; scoped is a subset of all (US-3)
      expect(Array.isArray(allSessions)).toBe(true);
      const allIds = allSessions.map((s) => s.sessionId);
      for (const s of scopedSessions) expect(allIds).toContain(s.sessionId);
      // the difference is exactly the out-of-scope sessions (incl. null-cwd)
      expect(allIds).toContain("0192aaaa-0000-7000-8000-000000000013"); // null-cwd, hidden by default
      expect(allIds).not.toContain("0192dddd-0000-7000-8000-000000000021"); // other test's session not here
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });

  it("exit 0: --project takes precedence over the default scope and normalizes paths (T013, FR-006/FR-008)", () => {
    const sandbox = createSandbox();
    const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acm-precedence-")));
    try {
      addPiSession(sandbox.home, realDir, "0192dddd-0000-7000-8000-000000000041", "Real dir chat");
      const env = { ACM_HOME: sandbox.home };
      // explicit --project wins over cwd even though realDir has a session
      const res = runCli(
        ["list", "--project", "/Users/test/project", "--json"],
        env,
        realDir,
      );
      expect(res.code).toBe(0);
      const ids = (JSON.parse(res.stdout) as { sessionId: string }[]).map((s) => s.sessionId);
      expect(ids).not.toContain("0192dddd-0000-7000-8000-000000000041");
      expect(ids).toContain("0192aaaa-0000-7000-8000-000000000001"); // root
      expect(ids).toContain("0192aaaa-0000-7000-8000-000000000011"); // nested (subtree, FR-012)

      // normalization: trailing slash and .. give identical results
      const trailing = runCli(["list", "--project", "/Users/test/project/", "--json"], env, realDir);
      const dotted = runCli(
        ["list", "--project", "/Users/test/project/../project", "--json"],
        env,
        realDir,
      );
      expect(JSON.parse(trailing.stdout)).toEqual(JSON.parse(res.stdout));
      expect(JSON.parse(dotted.stdout)).toEqual(JSON.parse(res.stdout));

      // -A keeps an explicit --project: filter applies, grouping shown
      const grouped = runCli(["list", "-A", "--project", "/Users/test/project"], env, realDir);
      expect(grouped.code).toBe(0);
      expect(grouped.stdout).toContain("/Users/test/project (");
      expect(grouped.stdout).toContain("/Users/test/project/sub (");
      expect(grouped.stdout).not.toContain("0192dddd-0000-7000-8000-000000000041");
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });

  it("exit 0: list with --project filter that matches nothing", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(
        ["list", "--agent", "codex", "--project", "/nope"],
        { ACM_HOME: sandbox.home },
      );
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe("No sessions found.");
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 1: usage error (unknown agent)", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(["list", "--agent", "bogus"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(1);
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 0/5: export refuses to overwrite without --force", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const out = path.join(tmp.dir, "p.acm.jsonl");
      const env = { ACM_HOME: sandbox.home };
      const first = runCli(
        ["export", "--agent", "pi", "--session", "0192aaaa-0000-7000-8000-000000000001", "--out", out],
        env,
      );
      expect(first.code).toBe(0);
      expect(fs.existsSync(out)).toBe(true);

      const second = runCli(
        ["export", "--agent", "pi", "--session", "0192aaaa-0000-7000-8000-000000000001", "--out", out],
        env,
      );
      expect(second.code).toBe(5);
      expect(second.stderr).toContain("--force");

      const forced = runCli(
        ["export", "--agent", "pi", "--session", "0192aaaa-0000-7000-8000-000000000001", "--out", out, "--force"],
        env,
      );
      expect(forced.code).toBe(0);
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 4: session not found", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(["export", "--agent", "pi", "--session", "missing"], {
        ACM_HOME: sandbox.home,
      });
      expect(res.code).toBe(4);
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 3: invalid package (corrupt file)", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const bad = path.join(tmp.dir, "bad.acm.jsonl");
      fs.writeFileSync(bad, "this is not json\n");
      const res = runCli(["import", bad, "--to", "codex"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(3);
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 3: invalid package (wrong formatVersion)", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const bad = path.join(tmp.dir, "v2.acm.jsonl");
      fs.writeFileSync(
        bad,
        JSON.stringify({ recordType: "package", formatVersion: 99, sourceAgent: "pi", sourceSessionId: "x" }) + "\n",
      );
      const res = runCli(["import", bad, "--to", "codex"], { ACM_HOME: sandbox.home });
      expect(res.code).toBe(3);
      expect(res.stderr).toContain("formatVersion");
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 0: import produces a report and a visible session", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const env = { ACM_HOME: sandbox.home };
      const out = path.join(tmp.dir, "p.acm.jsonl");
      runCli(
        ["export", "--agent", "pi", "--session", "0192aaaa-0000-7000-8000-000000000001", "--out", out],
        env,
      );
      const res = runCli(["import", out, "--to", "codex", "--json"], env);
      expect(res.code).toBe(0);
      const report = JSON.parse(res.stdout);
      expect(report.transferred.userMessages).toBe(1);
      expect(report.transferred.assistantMessages).toBe(2);
      expect(report.transferred.toolCalls).toBe(1);
      expect(report.newSessionId).toBeTruthy();

      // the new session is listable by the receiver (its cwd is the source
      // session's cwd, so an explicit --project is needed — the default scope
      // of this test run's cwd would hide it)
      const listed = runCli(
        ["list", "--agent", "codex", "--project", "/Users/test/project", "--json"],
        env,
      );
      expect(listed.code).toBe(0);
      const sessions = JSON.parse(listed.stdout) as { sessionId: string }[];
      expect(sessions.some((s) => s.sessionId === report.newSessionId)).toBe(true);
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 0: transfer in one step with report", () => {
    const sandbox = createSandbox();
    try {
      const res = runCli(
        [
          "transfer",
          "--from", "pi",
          "--session", "0192aaaa-0000-7000-8000-000000000001",
          "--to", "opencode",
          "--project", "/Users/test/project",
        ],
        { ACM_HOME: sandbox.home },
      );
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Transferred to opencode: session");
      expect(res.stdout).toContain("messages:");
    } finally {
      sandbox.cleanup();
    }
  });

  it("exit 6: oversized history requires --force", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    try {
      const env = { ACM_HOME: sandbox.home };
      // build an oversized package by hand
      const header = JSON.stringify({
        recordType: "package",
        formatVersion: 1,
        sourceAgent: "pi",
        sourceSessionId: "big",
        title: null,
        cwd: "/Users/test/project",
        startedAt: null,
        lastActivityAt: null,
        omitted: [],
      });
      const item = (pos: number) =>
        JSON.stringify({
          recordType: "item",
          item: {
            kind: "user_message",
            position: pos,
            timestamp: null,
            text: "x".repeat(500_000),
            thinking: null,
            tool: null,
            fileChange: null,
            event: null,
            sourceRef: null,
          },
        });
      const big = path.join(tmp.dir, "big.acm.jsonl");
      fs.writeFileSync(big, `${header}\n${item(0)}\n${item(1)}\n${item(2)}\n`);
      const res = runCli(["import", big, "--to", "codex"], env);
      expect(res.code).toBe(6);
      expect(res.stderr).toContain("--force");

      const forced = runCli(["import", big, "--to", "codex", "--force"], env);
      expect(forced.code).toBe(0);
      expect(forced.stdout).toContain("recommended size");
    } finally {
      tmp.cleanup();
      sandbox.cleanup();
    }
  });

  it("exit 2: write failure when receiver storage is missing", () => {
    const sandbox = createSandbox();
    const tmp = withTmpDir();
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "acm-empty-"));
    try {
      const out = path.join(tmp.dir, "p.acm.jsonl");
      runCli(
        ["export", "--agent", "pi", "--session", "0192aaaa-0000-7000-8000-000000000001", "--out", out],
        { ACM_HOME: sandbox.home },
      );
      // import into an opencode home with no database at all
      const res = runCli(["import", out, "--to", "opencode"], { ACM_HOME: emptyHome });
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("failed to write");
    } finally {
      tmp.cleanup();
      fs.rmSync(emptyHome, { recursive: true, force: true });
      sandbox.cleanup();
    }
  });
});
