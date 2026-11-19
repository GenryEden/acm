import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OutputExistsError,
  PackageValidationError,
  readPackage,
  writePackage,
  estimateSize,
  type TransferPackage,
} from "../../src/core/package.ts";
import { userMessage, assistantMessage, toolCall } from "../../src/core/history.ts";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acm-pkg-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function samplePackage(): TransferPackage {
  return {
    recordType: "package",
    formatVersion: 1,
    sourceAgent: "pi",
    sourceSessionId: "sess-1",
    title: "hello",
    cwd: "/tmp/project",
    startedAt: "2026-01-01T10:00:00.000Z",
    lastActivityAt: "2026-01-01T10:01:00.000Z",
    omitted: [],
    items: [
      userMessage(0, "2026-01-01T10:00:01.000Z", "hi"),
      assistantMessage(1, "2026-01-01T10:00:02.000Z", "hello", "thinking..."),
      toolCall(2, "2026-01-01T10:00:03.000Z", {
        name: "read",
        arguments: { path: "a.ts" },
        result: { content: "file", isError: false },
      }),
    ],
  };
}

describe("writePackage / readPackage round-trip", () => {
  it("writes and reads back identical content", () => {
    const file = path.join(tmp, "p.acm.jsonl");
    writePackage(samplePackage(), file);
    const pkg = readPackage(file);
    expect(pkg.sourceAgent).toBe("pi");
    expect(pkg.sourceSessionId).toBe("sess-1");
    expect(pkg.items).toHaveLength(3);
    expect(pkg.items[0].kind).toBe("user_message");
    expect(pkg.items[0].text).toBe("hi");
    expect(pkg.items[1].thinking).toBe("thinking...");
    expect(pkg.items[2].tool?.result?.content).toBe("file");
  });

  it("refuses to overwrite without force (exit-5 condition)", () => {
    const file = path.join(tmp, "p.acm.jsonl");
    writePackage(samplePackage(), file);
    expect(() => writePackage(samplePackage(), file)).toThrow(OutputExistsError);
    expect(() => writePackage(samplePackage(), file, true)).not.toThrow();
  });
});

describe("readPackage validation (exit-3 conditions)", () => {
  it("rejects an empty file", () => {
    const file = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(file, "");
    expect(() => readPackage(file)).toThrow(PackageValidationError);
  });

  it("rejects a header with wrong formatVersion", () => {
    const file = path.join(tmp, "v2.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({ recordType: "package", formatVersion: 2, sourceAgent: "pi", sourceSessionId: "s" }) + "\n",
    );
    try {
      readPackage(file);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackageValidationError);
      expect((err as PackageValidationError).expectedVersion).toBe(1);
    }
  });

  it("rejects malformed JSON on a specific line", () => {
    const file = path.join(tmp, "broken.jsonl");
    const header = JSON.stringify({
      recordType: "package",
      formatVersion: 1,
      sourceAgent: "pi",
      sourceSessionId: "s",
      title: null,
      cwd: null,
      startedAt: null,
      lastActivityAt: null,
      omitted: [],
    });
    fs.writeFileSync(file, header + "\n{not json}\n");
    try {
      readPackage(file);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PackageValidationError);
      expect((err as PackageValidationError).line).toBe(2);
    }
  });

  it("rejects an item with a non-increasing position", () => {
    const file = path.join(tmp, "pos.jsonl");
    const header = JSON.stringify({
      recordType: "package",
      formatVersion: 1,
      sourceAgent: "pi",
      sourceSessionId: "s",
      title: null,
      cwd: null,
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
          text: "x",
          thinking: null,
          tool: null,
          fileChange: null,
          event: null,
          sourceRef: null,
        },
      });
    fs.writeFileSync(file, `${header}\n${item(0)}\n${item(0)}\n`);
    expect(() => readPackage(file)).toThrow(/position/);
  });

  it("rejects an unknown item kind", () => {
    const file = path.join(tmp, "kind.jsonl");
    const header = JSON.stringify({
      recordType: "package",
      formatVersion: 1,
      sourceAgent: "pi",
      sourceSessionId: "s",
      title: null,
      cwd: null,
      startedAt: null,
      lastActivityAt: null,
      omitted: [],
    });
    fs.writeFileSync(
      file,
      `${header}\n${JSON.stringify({
        recordType: "item",
        item: {
          kind: "alien_message",
          position: 0,
          timestamp: null,
          text: "x",
          thinking: null,
          tool: null,
          fileChange: null,
          event: null,
          sourceRef: null,
        },
      })}\n`,
    );
    expect(() => readPackage(file)).toThrow(PackageValidationError);
  });
});

describe("estimateSize", () => {
  it("grows with item count", () => {
    const small = samplePackage();
    const big = { ...small, items: [...small.items, ...small.items, ...small.items] };
    expect(estimateSize(big)).toBeGreaterThan(estimateSize(small));
  });
});
