import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { shortId } from "../../core/paths.ts";
import type { TransferPackage } from "../../core/package.ts";
import { WriteFailureError, type ImportOptions, type ImportResult } from "../types.ts";
import { opencodeDbPath } from "./read.ts";
import { resolveOpencodeProject } from "./project.ts";

/**
 * Import a package into opencode storage: a single SQLite transaction inserting
 * a new session + messages + parts + session_message rows (FR-011: additive only,
 * rolled back atomically on any failure).
 */
export function importOpencodeSession(
  pkg: TransferPackage,
  opts: ImportOptions = {},
): ImportResult {
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new WriteFailureError("opencode", `database not found at ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath);
  try {
    const cwd = opts.project ?? pkg.cwd ?? process.env.HOME ?? ".";
    const now = Date.now();
    const sessionId = `ses_${shortId()}${shortId()}${shortId()}`;
    const msgCount = pkg.items.length;

    db.exec("BEGIN");
    try {
      // Resolve the project exactly like opencode's own Project.resolve:
      // 'global' for non-git directories, sha1("git-remote:...") / override
      // file / root commit for git repositories. A session under any other
      // project id is invisible to `opencode session list` and the TUI.
      const proj = resolveOpencodeProject(cwd);
      const projectId = proj.projectId;
      if (proj.projectId === "global") {
        // native global project row: worktree '/', no vcs, no name; opencode
        // keeps no project_directory rows for the global project
        db.prepare(
          `INSERT OR IGNORE INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
           VALUES ('global', '/', NULL, NULL, ?, ?, '[]')`,
        ).run(now, now);
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
           VALUES (?, ?, 'git', NULL, ?, ?, '[]')`,
        ).run(proj.projectId, proj.worktree, now, now);
        db.prepare(
          `INSERT OR IGNORE INTO project_directory (project_id, directory, time_created)
           VALUES (?, ?, ?)`,
        ).run(proj.projectId, cwd, now);
      }

      db.prepare(
        `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url,
           summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
           tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
           revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived)
         VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?, 'imported', NULL,
           0, 0, 0, NULL, NULL, 0,
           0, 0, 0, 0, 0,
           NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      ).run(
        sessionId,
        projectId,
        path.basename(cwd) || "imported",
        cwd,
        pkg.title ?? "Imported chat",
        now,
        now + msgCount,
      );

      let seq = 0;
      let lastTs = now;
      const nextTs = (wanted: number) => {
        lastTs = Math.max(wanted, lastTs + 1);
        return lastTs;
      };

      const insertMessage = (role: string, ts: number): string => {
        const messageId = `msg_${shortId()}${shortId()}${shortId()}`;
        db.prepare(
          `INSERT INTO message (id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          messageId,
          sessionId,
          ts,
          ts,
          JSON.stringify({ role, time: { created: ts, end: ts } }),
        );
        db.prepare(
          `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
           VALUES (?, ?, 'message', ?, ?, ?, '{}')`,
        ).run(shortId() + shortId(), sessionId, seq++, ts, ts);
        return messageId;
      };

      for (const item of pkg.items) {
        const ts = nextTs(item.timestamp ? Date.parse(item.timestamp) : now);

        if (item.kind === "user_message") {
          const messageId = insertMessage("user", ts);
          insertPart(db, sessionId, messageId, ts, { type: "text", text: item.text ?? "" });
        } else if (item.kind === "assistant_message") {
          const messageId = insertMessage("assistant", ts);
          if (item.thinking) {
            insertPart(db, sessionId, messageId, ts, {
              type: "reasoning",
              text: item.thinking,
              time: { start: ts, end: ts },
            });
          }
          insertPart(db, sessionId, messageId, ts, { type: "text", text: item.text ?? "" });
        } else if (item.kind === "tool_call" && item.tool) {
          const messageId = insertMessage("assistant", ts);
          const callId = `call_${shortId()}${shortId()}`;
          insertPart(db, sessionId, messageId, ts, {
            type: "tool",
            tool: item.tool.name,
            callID: callId,
            state: {
              status: "completed",
              input: item.tool.arguments ?? {},
              output: item.tool.result?.content ?? null,
              metadata: { count: 0, truncated: false },
              title: "",
              time: { start: ts, end: ts },
            },
          });
        } else if (item.kind === "file_change" && item.fileChange) {
          // file changes → native `patch` parts on a dedicated assistant message
          const messageId = insertMessage("assistant", ts);
          insertPart(db, sessionId, messageId, ts, {
            type: "patch",
            hash: crypto.randomBytes(16).toString("hex"),
            files: [item.fileChange.path],
          });
        }
      }

      db.exec("COMMIT");
      return { newSessionId: sessionId };
    } catch (err) {
      db.exec("ROLLBACK");
      throw new WriteFailureError("opencode", (err as Error).message);
    }
  } finally {
    db.close();
  }
}

function insertPart(
  db: DatabaseSync,
  sessionId: string,
  messageId: string,
  ts: number,
  data: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `prt_${shortId()}${shortId()}${shortId()}`,
    messageId,
    sessionId,
    ts,
    ts,
    JSON.stringify(data),
  );
}
