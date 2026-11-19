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

const SAMPLE_SESSIONS: Record<string, string> = {
  pi: "0192aaaa-0000-7000-8000-000000000001",
  opencode: "ses_sample0001session",
  codex: "0192cccc-0000-7000-8000-000000000003",
};

describe("self round-trip: export → import → export must be lossless", () => {
  const cases: [string, typeof piAdapter][] = [
    ["pi", piAdapter],
    ["opencode", opencodeAdapter],
    ["codex", codexAdapter],
  ];

  for (const [name, adapter] of cases) {
    it(`${name}: no losses through its own import/export cycle`, () => {
      const pkg = adapter.exportSession(SAMPLE_SESSIONS[name]);
      const { newSessionId, report } = performImport(adapter, pkg, {
        project: "/Users/test/project",
      });
      // self round-trip must never skip anything the adapter itself supports
      const supported = new Set(adapter.capabilities.itemKinds);
      for (const skip of report.skipped) {
        expect(supported.has(skip.kind)).toBe(false);
      }
      const reexported = adapter.exportSession(newSessionId);

      const fp = (p: typeof pkg) =>
        p.items
          .filter((i) => supported.has(i.kind))
          .map((i) => ({
          kind: i.kind,
          text: i.text,
          // codex cannot persist thinking (no API-issued encrypted_content),
          // so it is intentionally dropped on codex import
          thinking: adapter === codexAdapter ? null : i.thinking,
          tool: i.tool
            ? {
                name: i.tool.name,
                arguments: JSON.stringify(i.tool.arguments ?? {}),
                result: i.tool.result?.content ?? null,
              }
            : null,
          fileChange: i.fileChange ? { path: i.fileChange.path } : null,
        }));
      expect(fp(reexported)).toEqual(fp(pkg));
    });
  }
});
