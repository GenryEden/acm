import type { AgentAdapter, ImportOptions, ImportResult, ListFilter, ChatSessionMeta } from "../types.ts";
import type { TransferPackage } from "../../core/package.ts";
import { listPiSessions, exportPiSession, piSessionsRoot } from "./read.ts";
import { importPiSession } from "./write.ts";

export const piAdapter: AgentAdapter = {
  id: "pi",
  capabilities: { itemKinds: ["user_message", "assistant_message", "tool_call"] },
  storagePath(): string {
    return piSessionsRoot();
  },
  listSessions(filter?: ListFilter): ChatSessionMeta[] {
    return listPiSessions(filter);
  },
  exportSession(sessionId: string): TransferPackage {
    return exportPiSession(sessionId);
  },
  importSession(pkg: TransferPackage, opts?: ImportOptions): ImportResult {
    return importPiSession(pkg, opts);
  },
};
