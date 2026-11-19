import type { AgentAdapter, ImportOptions, ImportResult, ListFilter, ChatSessionMeta } from "../types.ts";
import type { TransferPackage } from "../../core/package.ts";
import { listOpencodeSessions, exportOpencodeSession, opencodeDbPath } from "./read.ts";
import { importOpencodeSession } from "./write.ts";

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  capabilities: { itemKinds: ["user_message", "assistant_message", "tool_call", "file_change"] },
  storagePath(): string {
    return opencodeDbPath();
  },
  listSessions(filter?: ListFilter): ChatSessionMeta[] {
    return listOpencodeSessions(filter);
  },
  exportSession(sessionId: string): TransferPackage {
    return exportOpencodeSession(sessionId);
  },
  importSession(pkg: TransferPackage, opts?: ImportOptions): ImportResult {
    return importOpencodeSession(pkg, opts);
  },
};
