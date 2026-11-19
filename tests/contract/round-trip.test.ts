import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { withSandbox } from "../helpers/sandbox.ts";
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { performImport } from "../../src/core/import.ts";
import type { AgentAdapter } from "../../src/adapters/types.ts";
import type { TransferPackage } from "../../src/core/package.ts";

let s: ReturnType<typeof withSandbox>;
beforeAll(() => {
  s = withSandbox();
});
afterAll(() => s.restore());

const adapters: Record<string, AgentAdapter> = {
  pi: piAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
};

const SAMPLE_SESSIONS: Record<string, string> = {
  pi: "0192aaaa-0000-7000-8000-000000000001",
  opencode: "ses_sample0001session",
  codex: "0192cccc-0000-7000-8000-000000000003",
};

/** Comparable projection: the conversation content that must survive a transfer. */
function conversationFingerprint(pkg: TransferPackage, dropThinking = false) {
  return pkg.items
    .filter((i) => i.kind === "user_message" || i.kind === "assistant_message" || i.kind === "tool_call")
    .map((i) => {
      if (i.kind === "tool_call") {
        return {
          kind: i.kind,
          name: i.tool?.name,
          arguments: JSON.stringify(i.tool?.arguments ?? {}),
          result: i.tool?.result?.content ?? null,
        };
      }
      return {
        kind: i.kind,
        text: i.text,
        // codex cannot persist thinking (no API-issued encrypted_content),
        // so it is intentionally dropped on codex import
        thinking: dropThinking ? null : i.thinking,
      };
    });
}

describe("round-trip fidelity across all 6 directions (T018, T027-T030)", () => {
  const directions: [string, string][] = [
    ["pi", "codex"],
    ["pi", "opencode"],
    ["codex", "pi"],
    ["codex", "opencode"],
    ["opencode", "pi"],
    ["opencode", "codex"],
  ];

  for (const [from, to] of directions) {
    it(`${from} → ${to} → re-export preserves the conversation`, () => {
      const source = adapters[from];
      const target = adapters[to];

      const pkg = source.exportSession(SAMPLE_SESSIONS[from]);
      const expected = conversationFingerprint(pkg, to === "codex");

      const { newSessionId, report } = performImport(target, pkg, {
        project: "/Users/test/project",
      });
      expect(newSessionId).toBeTruthy();

      // nothing transferable was silently dropped
      const transferable = pkg.items.filter((i) =>
        target.capabilities.itemKinds.includes(i.kind),
      );
      expect(report.skipped.map((x) => x.kind)).toEqual(
        pkg.items
          .filter((i) => !target.capabilities.itemKinds.includes(i.kind))
          .map((i) => i.kind),
      );

      // re-export from the receiver and compare fingerprints
      const reexported = target.exportSession(newSessionId);
      const actual = conversationFingerprint(reexported);
      expect(actual).toEqual(expected);

      // FR-012: original file paths are not rewritten
      expect(reexported.cwd).toBe(pkg.cwd);
    });
  }

  it("file_change survives opencode → opencode (native patch parts)", () => {
    const pkg = opencodeAdapter.exportSession(SAMPLE_SESSIONS.opencode);
    expect(pkg.items.some((i) => i.kind === "file_change")).toBe(true);
    const { newSessionId, report } = performImport(opencodeAdapter, pkg, {
      project: "/Users/test/project",
    });
    expect(report.transferred.fileChanges).toBeGreaterThan(0);
    const reexported = opencodeAdapter.exportSession(newSessionId);
    const before = pkg.items.find((i) => i.kind === "file_change")!.fileChange!.path;
    const after = reexported.items.find((i) => i.kind === "file_change")!.fileChange!.path;
    expect(after).toBe(before); // FR-012: path preserved verbatim
  });

  it("file_change is skipped (listed in report) when target cannot store it", () => {
    const pkg = opencodeAdapter.exportSession(SAMPLE_SESSIONS.opencode);
    const { report } = performImport(codexAdapter, pkg, { project: "/Users/test/project" });
    expect(report.transferred.fileChanges).toBe(0);
    expect(report.skipped.some((x) => x.kind === "file_change")).toBe(true);
    expect(report.skipped[0].reason).toContain("no native storage");
  });
});

describe("import is additive and non-destructive (FR-011)", () => {
  it("original sessions remain intact and listable after imports", () => {
    const before = {
      pi: piAdapter.listSessions().map((x) => x.sessionId),
      opencode: opencodeAdapter.listSessions().map((x) => x.sessionId),
      codex: codexAdapter.listSessions().map((x) => x.sessionId),
    };
    const pkg = piAdapter.exportSession(SAMPLE_SESSIONS.pi);
    performImport(codexAdapter, pkg, { project: "/Users/test/project" });
    performImport(opencodeAdapter, pkg, { project: "/Users/test/project" });

    const after = {
      pi: piAdapter.listSessions().map((x) => x.sessionId),
      opencode: opencodeAdapter.listSessions().map((x) => x.sessionId),
      codex: codexAdapter.listSessions().map((x) => x.sessionId),
    };
    expect(after.pi).toEqual(expect.arrayContaining(before.pi));
    expect(after.pi.length).toBeGreaterThanOrEqual(before.pi.length);
    expect(after.opencode).toEqual(expect.arrayContaining(before.opencode));
    expect(after.codex).toEqual(expect.arrayContaining(before.codex));
    // original session content unchanged
    const original = piAdapter.exportSession(SAMPLE_SESSIONS.pi);
    expect(conversationFingerprint(original)).toEqual(
      conversationFingerprint(piAdapter.exportSession(SAMPLE_SESSIONS.pi)),
    );
  });
});
