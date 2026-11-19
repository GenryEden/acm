import { describe, expect, it } from "vitest";
import { performImport, SIZE_WARNING_CHARS, NeedsForceError } from "../../src/core/import.ts";
import { renderReport } from "../../src/cli/output.ts";
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { userMessage, fileChangeItem, toolCall, serviceEventItem } from "../../src/core/history.ts";
import type { TransferPackage } from "../../src/core/package.ts";

function pkg(items: TransferPackage["items"], omitted: TransferPackage["omitted"] = []): TransferPackage {
  return {
    recordType: "package",
    formatVersion: 1,
    sourceAgent: "pi",
    sourceSessionId: "s",
    title: null,
    cwd: "/a",
    startedAt: null,
    lastActivityAt: null,
    omitted,
    items,
  };
}

// fake adapter to test the engine without touching real storage
function fakeAdapter(itemKinds: string[]) {
  const imported: TransferPackage[] = [];
  return {
    adapter: {
      id: "fake",
      capabilities: { itemKinds: itemKinds as never },
      listSessions: () => [],
      exportSession: () => pkg([]),
      importSession: (p: TransferPackage) => {
        imported.push(p);
        return { newSessionId: "new-1" };
      },
    },
    imported,
  };
}

describe("performImport skip policy (FR-005)", () => {
  it("skips kinds the receiver cannot store natively and lists them", () => {
    const { adapter } = fakeAdapter(["user_message", "assistant_message"]);
    const items = [
      userMessage(0, null, "hi"),
      fileChangeItem(1, null, { path: "/a/b.ts", changeType: "modify", diff: null }),
    ];
    const { report } = performImport(adapter, pkg(items));
    expect(report.transferred.userMessages).toBe(1);
    expect(report.transferred.fileChanges).toBe(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ kind: "file_change", position: 1 });
    expect(report.skipped[0].reason).toContain("no native storage");
  });

  it("keeps tool_call+result inseparable (FR-004): tool_call either transfers whole or is skipped whole", () => {
    const { adapter, imported } = fakeAdapter(["tool_call"]);
    const items = [
      toolCall(0, null, { name: "read", arguments: {}, result: { content: "x", isError: false } }),
    ];
    const { report } = performImport(adapter, pkg(items));
    expect(report.transferred.toolCalls).toBe(1);
    expect(imported[0].items[0].tool?.result?.content).toBe("x");
  });

  it("propagates outOfScope entries from the package header (FR-017, FR-009)", () => {
    const { adapter } = fakeAdapter(["user_message"]);
    const { report } = performImport(
      adapter,
      pkg([userMessage(0, null, "hi")], [
        { kind: "model_change", reason: "agent configuration, out of transfer scope (FR-017)" },
      ]),
    );
    expect(report.outOfScope).toEqual([
      { kind: "model_change", reason: "agent configuration, out of transfer scope (FR-017)" },
    ]);
    expect(report.skipped).toHaveLength(0);
  });

  it("distinguishes skipped (cannot) from outOfScope (by design)", () => {
    const { adapter } = fakeAdapter([]);
    const { report } = performImport(
      adapter,
      pkg([userMessage(0, null, "hi")], [{ kind: "system_message", reason: "out of scope" }]),
    );
    expect(report.skipped.map((s) => s.kind)).toEqual(["user_message"]);
    expect(report.outOfScope.map((o) => o.kind)).toEqual(["system_message"]);
  });
});

describe("performImport size guard (FR-010)", () => {
  it("throws NeedsForceError for oversized history without --force", () => {
    const { adapter } = fakeAdapter(["user_message"]);
    const big = "x".repeat(SIZE_WARNING_CHARS);
    expect(() => performImport(adapter, pkg([userMessage(0, null, big)]))).toThrow(NeedsForceError);
  });

  it("proceeds with force and records a warning", () => {
    const { adapter } = fakeAdapter(["user_message"]);
    const big = "x".repeat(SIZE_WARNING_CHARS);
    const { report } = performImport(adapter, pkg([userMessage(0, null, big)]), { force: true });
    expect(report.transferred.userMessages).toBe(1);
    expect(report.warnings.some((w) => w.includes("recommended size"))).toBe(true);
  });
});

describe("real adapter capabilities", () => {
  it("pi and codex cannot store file_change; opencode can", () => {
    expect(piAdapter.capabilities.itemKinds).not.toContain("file_change");
    expect(codexAdapter.capabilities.itemKinds).not.toContain("file_change");
  });
});

describe("renderReport skip aggregation", () => {
  it("collapses hundreds of identical skips into one summary line", () => {
    const { adapter } = fakeAdapter(["user_message"]);
    const items = [
      userMessage(0, null, "hi"),
      ...Array.from({ length: 558 }, (_, i) =>
        serviceEventItem(i + 1, null, { sourceType: "compaction", payload: {} }),
      ),
    ];
    const { report } = performImport(adapter, pkg(items));
    const text = renderReport(report, "opencode");
    const skipLines = text.split("\n").filter((l) => l.trimStart().startsWith("- "));
    expect(skipLines).toEqual([
      "    - 558 × service_event: receiver schema has no native storage for service_event",
    ]);
    expect(text).toContain("skipped:         558");
  });

  it("keeps the position hint for a single skip", () => {
    const { adapter } = fakeAdapter(["user_message"]);
    const { report } = performImport(
      adapter,
      pkg([
        userMessage(0, null, "hi"),
        fileChangeItem(1, null, { path: "/a/b.ts", changeType: "modify", diff: null }),
      ]),
    );
    const text = renderReport(report, "codex");
    expect(text).toContain("- [pos 1] file_change: receiver schema has no native storage for file_change");
  });
});
