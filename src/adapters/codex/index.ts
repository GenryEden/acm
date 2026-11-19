import type { AgentAdapter, ImportOptions, ImportResult, ListFilter, ChatSessionMeta } from "../types.ts";
import type { TransferPackage } from "../../core/package.ts";
import { listCodexSessions, exportCodexSession, codexSessionsRoot } from "./read.ts";
import { importCodexSession } from "./write.ts";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  capabilities: { itemKinds: ["user_message", "assistant_message", "tool_call"] },
  storagePath(): string {
    return codexSessionsRoot();
  },
  listSessions(filter?: ListFilter): ChatSessionMeta[] {
    return listCodexSessions(filter);
  },
  exportSession(sessionId: string): TransferPackage {
    return exportCodexSession(sessionId);
  },
  importSession(pkg: TransferPackage, opts?: ImportOptions): ImportResult {
    return importCodexSession(pkg, opts);
  },
};
