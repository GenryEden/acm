import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { withSandbox } from "../helpers/sandbox.ts";
import { piAdapter } from "../../src/adapters/pi/index.ts";
import { opencodeAdapter } from "../../src/adapters/opencode/index.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { performImport } from "../../src/core/import.ts";

let s: ReturnType<typeof withSandbox>;
beforeAll(() => {
  s = withSandbox();
});
afterAll(() => s.restore());

/**
 * Chain migration (edge case 7): pi → codex → opencode → pi.
 * Conversation content must survive the full chain.
 */
describe("chain migration pi → codex → opencode → pi", () => {
  it("preserves ≥90% of transferable items through the whole chain", () => {
    const original = piAdapter.exportSession("0192aaaa-0000-7000-8000-000000000001");
    const core = (items: typeof original.items) =>
      items.filter((i) => ["user_message", "assistant_message", "tool_call"].includes(i.kind));

    const step1 = performImport(codexAdapter, original, { project: "/Users/test/project" });
    const pkg1 = codexAdapter.exportSession(step1.newSessionId);

    const step2 = performImport(opencodeAdapter, pkg1, { project: "/Users/test/project" });
    const pkg2 = opencodeAdapter.exportSession(step2.newSessionId);

    const step3 = performImport(piAdapter, pkg2, { project: "/Users/test/project" });
    const pkg3 = piAdapter.exportSession(step3.newSessionId);

    const before = core(original.items);
    const after = core(pkg3.items);
    expect(after.length / before.length).toBeGreaterThanOrEqual(0.9);

    // exact content check for the conversation core
    const shape = (items: typeof original.items) =>
      items
        .filter((i) => i.kind !== "service_event")
        .map((i) => ({
          kind: i.kind,
          text: i.text,
          // the chain passes through codex, which cannot persist thinking
          // (no API-issued encrypted_content) — compare without it
          thinking: null,
          tool: i.tool ? { name: i.tool.name, args: JSON.stringify(i.tool.arguments) } : null,
        }));
    expect(shape(after)).toEqual(shape(before));

    // FR-012: paths never rewritten through the whole chain
    expect(pkg3.cwd).toBe(original.cwd);
  });
});
