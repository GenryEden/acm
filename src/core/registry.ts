import type { AgentAdapter } from "../adapters/types.ts";
import { piAdapter } from "../adapters/pi/index.ts";
import { opencodeAdapter } from "../adapters/opencode/index.ts";
import { codexAdapter } from "../adapters/codex/index.ts";

const adapters: AgentAdapter[] = [piAdapter, opencodeAdapter, codexAdapter];

export function listAdapters(): AgentAdapter[] {
  return adapters;
}

export function getAdapter(id: string): AgentAdapter {
  const adapter = adapters.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(
      `unknown agent "${id}" (supported: ${adapters.map((a) => a.id).join(", ")})`,
    );
  }
  return adapter;
}

export function supportedAgentIds(): string[] {
  return adapters.map((a) => a.id);
}
