import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { withSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { UnsupportedFormatError, SessionNotFoundError } from "../../src/adapters/types.ts";

let s: ReturnType<typeof withSandbox>;
beforeAll(() => {
  s = withSandbox({ unsupportedPi: true });
});
afterAll(() => s.restore());

describe("pi export (T011)", () => {
  it("exports the sample session with full fidelity", () => {
    const pkg = piAdapter.exportSession("0192aaaa-0000-7000-8000-000000000001");
    expect(pkg.sourceAgent).toBe("pi");
    expect(pkg.cwd).toBe("/Users/test/project");
    expect(pkg.title).toBe("Please read src/app.ts");
    const kinds = pkg.items.map((i) => i.kind);
    expect(kinds).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "assistant_message",
      "service_event", // user_aborted
    ]);
    const assistant = pkg.items[1];
    expect(assistant.text).toBe("Reading the file now.");
    expect(assistant.thinking).toBe("The user wants me to read the file.");
    const tool = pkg.items[2].tool!;
    expect(tool.name).toBe("read");
    expect(tool.arguments).toEqual({ path: "src/app.ts" });
    expect(tool.result).toEqual({
      content: 'export function main() {\n  console.log("hello");\n}',
      isError: false,
    });
  });

  it("records model_change as outOfScope and system message as outOfScope (FR-017)", () => {
    const pkg = piAdapter.exportSession("0192aaaa-0000-7000-8000-000000000001");
    expect(pkg.omitted.map((o) => o.kind).sort()).toEqual(["model_change", "system_message"]);
  });

  it("throws UnsupportedFormatError for unknown session version (T012)", () => {
    try {
      piAdapter.exportSession("0192bbbb-0000-7000-8000-000000000002");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedFormatError);
      expect((err as UnsupportedFormatError).agent).toBe("pi");
      expect((err as UnsupportedFormatError).supported).toContain("session v3");
    }
  });

  it("throws SessionNotFoundError for a missing session", () => {
    expect(() => piAdapter.exportSession("nope")).toThrow(SessionNotFoundError);
  });
});

describe("opencode export (T011)", () => {
  it("exports the sample session with tool call, thinking and patch", () => {
    const pkg = opencodeAdapter.exportSession("ses_sample0001session");
    expect(pkg.cwd).toBe("/Users/test/project");
    expect(pkg.title).toBe("Please read src/app.ts");
    const kinds = pkg.items.map((i) => i.kind);
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("file_change");
    const assistant = pkg.items.find((i) => i.kind === "assistant_message")!;
    expect(assistant.thinking).toBe("The user wants me to read the file.");
    const tool = pkg.items.find((i) => i.kind === "tool_call")!.tool!;
    expect(tool.name).toBe("read");
    expect(tool.arguments).toEqual({ path: "src/app.ts" });
    expect(tool.result?.content).toContain("export function main");
    const fc = pkg.items.find((i) => i.kind === "file_change")!.fileChange!;
    expect(fc.path).toBe("/Users/test/project/src/app.ts");
  });
});

describe("codex export (T011)", () => {
  it("exports the sample rollout with reasoning attached as thinking", () => {
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    expect(pkg.cwd).toBe("/Users/test/project");
    expect(pkg.title).toBe("Please read src/app.ts");
    const kinds = pkg.items.map((i) => i.kind);
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("service_event"); // task_started / task_complete
    const first = pkg.items.find((i) => i.kind === "assistant_message")!;
    expect(first.thinking).toBe("I need to read the file first.");
    const tool = pkg.items.find((i) => i.kind === "tool_call")!.tool!;
    expect(tool.name).toBe("read");
    expect(tool.arguments).toEqual({ path: "src/app.ts" });
    expect(tool.result?.content).toContain("export function main");
  });

  it("records token_count as outOfScope", () => {
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    expect(pkg.omitted.some((o) => o.kind === "token_count")).toBe(true);
  });
});

describe("version detection (T012)", () => {
  it("opencode adapter rejects a db missing required tables", async () => {
    const { withSandbox: ws } = await import("../helpers/sandbox.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acm-bad-"));
    const prev = process.env.ACM_HOME;
    process.env.ACM_HOME = home;
    try {
      const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE unrelated (x text)");
      db.close();
      expect(() => opencodeAdapter.listSessions()).toThrow(UnsupportedFormatError);
      expect(() => opencodeAdapter.exportSession("whatever")).toThrow(UnsupportedFormatError);
    } finally {
      if (prev === undefined) delete process.env.ACM_HOME;
      else process.env.ACM_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
    void ws;
  });
});
