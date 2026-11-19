import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { withSandbox } from "../helpers/sandbox.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { performImport } from "../../src/core/import.ts";
import { codexSessionIndexPath, codexSessionsRoot } from "../../src/adapters/codex/read.ts";
import { homeDir } from "../../src/core/paths.ts";

function writeCodexConfig(body: string | null): void {
  const dir = path.join(homeDir(), ".codex");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "config.toml");
  if (body === null) {
    try {
      fs.rmSync(p);
    } catch {
      /* absent */
    }
  } else {
    fs.writeFileSync(p, body);
  }
}

let s: ReturnType<typeof withSandbox>;
beforeAll(() => {
  s = withSandbox();
});
afterAll(() => s.restore());

describe("codex writer: canonical rollout format (native codex 0.167 compatibility)", () => {
  it("filename uses second precision without ms/Z (RolloutFileName::parse-compatible)", () => {
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    const { newSessionId } = performImport(codexAdapter, pkg, {
      project: "/Users/test/project",
    });

    const files: string[] = [];
    const root = codexSessionsRoot();
    for (const year of fs.readdirSync(root)) {
      const yDir = path.join(root, year);
      for (const month of fs.readdirSync(yDir)) {
        const mDir = path.join(yDir, month);
        for (const day of fs.readdirSync(mDir)) {
          const dDir = path.join(mDir, day);
          for (const f of fs.readdirSync(dDir)) {
            if (f.includes(newSessionId)) files.push(f);
          }
        }
      }
    }
    expect(files).toHaveLength(1);
    // canonical: rollout-YYYY-MM-DDTHH-MM-SS-<thread-id>.jsonl (19-char timestamp)
    expect(files[0]).toMatch(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]+\.jsonl$/,
    );
  });

  it("emits plain user_message/agent_message events (legacy TUI rendering + title backfill)", () => {
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    const { newSessionId } = performImport(codexAdapter, pkg, {
      project: "/Users/test/project",
    });

    // find the rollout file written for newSessionId
    let rollout = "";
    const root = codexSessionsRoot();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes(newSessionId)) rollout = p;
      }
    };
    walk(root);
    expect(rollout).not.toBe("");

    const records = fs
      .readFileSync(rollout, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // every record carries an ordinal
    expect(records.every((r) => typeof r.ordinal === "number")).toBe(true);

    const userCompleted = records.filter(
      (r) => r.type === "event_msg" && r.payload?.type === "user_message",
    );
    const userMessages = pkg.items.filter((i) => i.kind === "user_message");
    expect(userCompleted.length).toBe(userMessages.length);
    for (const r of userCompleted) {
      expect(typeof r.payload.message).toBe("string");
      expect(r.payload.message.length).toBeGreaterThan(0);
    }

    // assistant messages render as plain agent_message events
    const agentEvents = records.filter(
      (r) => r.type === "event_msg" && r.payload?.type === "agent_message",
    );
    const assistantMessages = pkg.items.filter((i) => i.kind === "assistant_message");
    expect(agentEvents.length).toBe(assistantMessages.length);

    // no item_completed UserMessage/AgentMessage: the migration canonicalizer
    // derives them from the plain events; emitting both would duplicate
    const dupes = records.filter(
      (r) =>
        r.type === "event_msg" &&
        r.payload?.type === "item_completed" &&
        (r.payload?.item?.type === "UserMessage" ||
          r.payload?.item?.type === "AgentMessage"),
    );
    expect(dupes).toHaveLength(0);

    // every user message opens its own turn (task_started ... task_complete)
    const taskStarted = records.filter(
      (r) => r.type === "event_msg" && r.payload?.type === "task_started",
    );
    const taskComplete = records.filter(
      (r) => r.type === "event_msg" && r.payload?.type === "task_complete",
    );
    expect(taskStarted.length).toBe(userMessages.length);
    expect(taskComplete.length).toBe(userMessages.length);
    const turnIds = new Set(taskStarted.map((r) => r.payload.turn_id));
    expect(turnIds.size).toBe(userMessages.length);

    // tool calls render in the UI only as item_completed DynamicToolCall items
    const toolItems = records.filter(
      (r) =>
        r.type === "event_msg" &&
        r.payload?.type === "item_completed" &&
        r.payload?.item?.type === "DynamicToolCall",
    );
    const toolCalls = pkg.items.filter((i) => i.kind === "tool_call");
    expect(toolItems.length).toBe(toolCalls.length);
    for (const r of toolItems) {
      expect(r.payload.item.status).toBe("completed");
      expect(r.payload.item.content_items[0].type).toBe("inputText");
    }

    // index entry appended
    const idx = fs
      .readFileSync(codexSessionIndexPath(), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(idx.some((e) => e.id === newSessionId)).toBe(true);
  });
});

describe("codex writer: model provider settings from user config", () => {
  it("records the configured provider and model (session_meta + turn_context)", () => {
    writeCodexConfig(
      'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n\n[profiles.x]\nmodel = "other"\n',
    );
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    const { newSessionId } = performImport(codexAdapter, pkg, {
      project: "/Users/test/project",
    });

    let rollout = "";
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes(newSessionId)) rollout = p;
      }
    };
    walk(codexSessionsRoot());

    const records = fs
      .readFileSync(rollout, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const meta = records[0];
    expect(meta.type).toBe("session_meta");
    // configured provider id — never a synthetic one like "imported"
    expect(meta.payload.model_provider).toBe("openai");

    const tc = records.find((r) => r.type === "turn_context");
    expect(tc).toBeDefined();
    expect(tc.payload.model).toBe("gpt-6.1-terra");
    expect(tc.payload.effort).toBe("low");
    expect(tc.payload.cwd).toBe("/Users/test/project");
    expect(tc.payload.sandbox_policy.type).toBe("workspace-write");
  });

  it("falls back to openai and skips turn_context when no model is configured", () => {
    writeCodexConfig(null);
    const pkg = codexAdapter.exportSession("0192cccc-0000-7000-8000-000000000003");
    const { newSessionId } = performImport(codexAdapter, pkg, {
      project: "/Users/test/project",
    });

    let rollout = "";
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.includes(newSessionId)) rollout = p;
      }
    };
    walk(codexSessionsRoot());

    const records = fs
      .readFileSync(rollout, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records[0].payload.model_provider).toBe("openai");
    expect(records.some((r) => r.type === "turn_context")).toBe(false);
  });
});
