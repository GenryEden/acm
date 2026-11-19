import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Real opencode.db schema (captured from opencode 1.17.x). */
export const OPENCODE_SCHEMA_SQL = `
CREATE TABLE \`project\` (
  \`id\` text PRIMARY KEY,
  \`worktree\` text NOT NULL,
  \`vcs\` text,
  \`name\` text,
  \`icon_url\` text,
  \`icon_url_override\` text,
  \`icon_color\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_initialized\` integer,
  \`sandboxes\` text NOT NULL,
  \`commands\` text
);
CREATE TABLE \`project_directory\` (
  \`project_id\` text NOT NULL,
  \`directory\` text NOT NULL,
  \`type\` text,
  \`strategy\` text,
  \`time_created\` integer NOT NULL,
  CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
  CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`session\` (
  \`id\` text PRIMARY KEY,
  \`project_id\` text NOT NULL,
  \`workspace_id\` text,
  \`parent_id\` text,
  \`slug\` text NOT NULL,
  \`directory\` text NOT NULL,
  \`path\` text,
  \`title\` text NOT NULL,
  \`version\` text NOT NULL,
  \`share_url\` text,
  \`summary_additions\` integer,
  \`summary_deletions\` integer,
  \`summary_files\` integer,
  \`summary_diffs\` text,
  \`metadata\` text,
  \`cost\` real DEFAULT 0 NOT NULL,
  \`tokens_input\` integer DEFAULT 0 NOT NULL,
  \`tokens_output\` integer DEFAULT 0 NOT NULL,
  \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
  \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
  \`revert\` text,
  \`permission\` text,
  \`agent\` text,
  \`model\` text,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`time_compacting\` integer,
  \`time_archived\` integer,
  CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`message\` (
  \`id\` text PRIMARY KEY,
  \`session_id\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`part\` (
  \`id\` text PRIMARY KEY,
  \`message_id\` text NOT NULL,
  \`session_id\` text NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`session_message\` (
  \`id\` text PRIMARY KEY,
  \`session_id\` text NOT NULL,
  \`type\` text NOT NULL,
  \`seq\` integer NOT NULL,
  \`time_created\` integer NOT NULL,
  \`time_updated\` integer NOT NULL,
  \`data\` text NOT NULL,
  CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
`;

export const SAMPLE_SESSION_ID = "ses_sample0001session";
const SAMPLE_CWD = "/Users/test/project";
const T0 = Date.parse("2026-01-01T10:00:00.000Z");

/** Extra session for scope/grouping tests (listing only; no messages). */
export interface ExtraSessionSpec {
  id: string;
  cwd: string;
  title: string;
}

/**
 * Create an opencode.db with a sample session mirroring the pi/codex fixtures:
 * user message, assistant (reasoning + text + tool call + result + patch), final text.
 * `extras` adds listing-only sessions in other project directories (scope tests).
 */
export function createSampleOpencodeDb(
  dbPath: string,
  extras: ExtraSessionSpec[] = [],
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(OPENCODE_SCHEMA_SQL);
  try {
    db.exec("BEGIN");
    const projectId = "prj_sample000000000001";
    db.prepare(
      `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
       VALUES (?, ?, NULL, ?, ?, ?, '[]')`,
    ).run(projectId, SAMPLE_CWD, "project", T0, T0);
    db.prepare(
      `INSERT INTO project_directory (project_id, directory, time_created)
       VALUES (?, ?, ?)`,
    ).run(projectId, SAMPLE_CWD, T0);
    db.prepare(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES (?, ?, 'project', ?, ?, '1.17.9', ?, ?)`,
    ).run(SAMPLE_SESSION_ID, projectId, SAMPLE_CWD, "Please read src/app.ts", T0, T0 + 8000);

    // listing-only sessions in other project directories (scope/grouping tests);
    // opencode's `session.directory` is NOT NULL, so a null-cwd session is
    // impossible in this storage (documented limitation, spec FR-004).
    for (const [i, extra] of extras.entries()) {
      const extraProjectId = `prj_extra${String(i).padStart(13, "0")}`;
      db.prepare(
        `INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
         VALUES (?, ?, NULL, ?, ?, ?, '[]')`,
      ).run(extraProjectId, extra.cwd, `extra-${i}`, T0, T0);
      db.prepare(
        `INSERT INTO project_directory (project_id, directory, time_created)
         VALUES (?, ?, ?)`,
      ).run(extraProjectId, extra.cwd, T0);
      db.prepare(
        `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
         VALUES (?, ?, 'extra', ?, ?, '1.17.9', ?, ?)`,
      ).run(extra.id, extraProjectId, extra.cwd, extra.title, T0, T0 + 1000);
    }

    let msgSeq = 0;
    const addMessage = (role: string, ts: number, parts: Record<string, unknown>[]) => {
      const messageId = `msg_sample${String(msgSeq++).padStart(4, "0")}`;
      db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(messageId, SAMPLE_SESSION_ID, ts, ts, JSON.stringify({ role }));
      let partSeq = 0;
      for (const part of parts) {
        db.prepare(
          `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          `prt_sample${String(msgSeq).padStart(4, "0")}${String(partSeq++).padStart(4, "0")}`,
          messageId,
          SAMPLE_SESSION_ID,
          ts,
          ts,
          JSON.stringify(part),
        );
      }
    };

    addMessage("user", T0 + 1000, [{ type: "text", text: "Please read src/app.ts" }]);
    addMessage("assistant", T0 + 3000, [
      { type: "step-start" },
      { type: "reasoning", text: "The user wants me to read the file.", time: { start: T0 + 2500, end: T0 + 2600 } },
      { type: "text", text: "Reading the file now." },
      {
        type: "tool",
        tool: "read",
        callID: "chatcmpl-tool-sample0001",
        state: {
          status: "completed",
          input: { path: "src/app.ts" },
          output: 'export function main() {\n  console.log("hello");\n}',
          metadata: { count: 0, truncated: false },
          title: "",
          time: { start: T0 + 3000, end: T0 + 4000 },
        },
      },
      { type: "step-finish" },
    ]);
    addMessage("assistant", T0 + 5000, [
      { type: "text", text: "The file looks good. It exports a main function." },
      { type: "patch", hash: "a477f9b7eeee0000000000000000000000000000", files: [`${SAMPLE_CWD}/src/app.ts`] },
    ]);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}
