import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shortId, uuidv7 } from "../../core/paths.ts";
import type { TransferPackage } from "../../core/package.ts";
import { WriteFailureError, type ImportOptions, type ImportResult } from "../types.ts";
import { codexModelSettings } from "./config.ts";
import { codexSessionIndexPath, codexSessionsRoot } from "./read.ts";

/**
 * Import a package into codex storage: write a new rollout-*.jsonl file and
 * append to session_index.jsonl (required for TUI visibility). Atomic-ish:
 * the rollout file is written fully before the index append; on any failure
 * the rollout file is removed again (FR-011).
 */
export function importCodexSession(
  pkg: TransferPackage,
  opts: ImportOptions = {},
): ImportResult {
  const cwd = opts.project ?? pkg.cwd ?? process.env.HOME ?? ".";
  const sessionId = uuidv7();
  const now = new Date();
  const nowIso = now.toISOString();
  const dateDir = path.join(
    codexSessionsRoot(),
    nowIso.slice(0, 4),
    nowIso.slice(5, 7),
    nowIso.slice(8, 10),
  );
  // Canonical codex filename: rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-id>.jsonl
  // (second precision, no ms, no Z — RolloutFileName::parse requires exactly
  // 19 timestamp chars; anything else makes the thread invisible to codex).
  const stamp = nowIso.slice(0, 19).replace(/:/g, "-");
  const file = path.join(dateDir, `rollout-${stamp}-${sessionId}.jsonl`);

  const lines: string[] = [];
  let ordinal = 0;
  const emit = (type: string, payload: Record<string, unknown>) => {
    lines.push(JSON.stringify({ timestamp: nowIso, ordinal: ordinal++, type, payload }));
  };

  // codex refuses to resume chats whose model provider is not configured
  // ("Model provider unavailable"), so record the user's current codex
  // defaults instead of a synthetic id.
  const modelSettings = codexModelSettings();

  emit("session_meta", {
    id: sessionId,
    session_id: sessionId,
    timestamp: nowIso,
    cwd,
    originator: "acm",
    cli_version: "0.0.0",
    source: "cli",
    thread_source: "user",
    model_provider: modelSettings.modelProvider,
    git: { repository_url: null },
  });

  // The TUI renders thread history ONLY from event_msg records (response_item
  // records feed the API replay but not the UI), and each user message must
  // open its own turn (task_started ... task_complete): a turn shows only its
  // first UserMessage item, so extra user messages inside one turn are
  // invisible. Messages must be persisted as PLAIN user_message/agent_message
  // events: the legacy read path (build_legacy_api_turns_from_rollout_items)
  // filters rollout items through the write policy (persisted_rollout_item,
  // Legacy mode), which drops item_completed records for UserMessage/
  // AgentMessage — only plain events survive and render. The paginated path
  // (after codex auto-migrates the rollout on daemon startup) ignores plain
  // events and renders item_completed records instead; codex's own importer
  // (external_agent_migration) writes exactly this legacy shape, and its
  // canonicalizer converts the plain events to item_completed on migration —
  // so emitting both would duplicate every message. Tool calls render only
  // after migration to paginated history (DynamicToolCall item_completed is
  // filtered out in legacy mode); response_item function_call records alone
  // are never displayed.
  const tsMs = (ts: string | undefined): number =>
    ts ? Math.floor(new Date(ts).getTime()) : Math.floor(Date.now());

  let turnId: string | null = null;
  let turnStartedAt = 0;
  let lastAgentText: string | null = null;

  const startTurn = () => {
    turnId = uuidv7();
    turnStartedAt = Math.floor(Date.now() / 1000);
    emit("event_msg", {
      type: "task_started",
      turn_attribution: {
        turn_id: turnId,
        turn_trigger: "user",
        parent_turn_id: null,
        initiating_agent_path: null,
        root_turn_id: turnId,
      },
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: turnStartedAt,
      model_context_window: 0,
      collaboration_mode_kind: "default",
    });
    if (modelSettings.model) {
      // Minimal turn_context: the deserializer only requires cwd,
      // approval_policy, model and a sandbox_policy fallback.
      emit("turn_context", {
        turn_id: turnId,
        root_turn_id: turnId,
        cwd,
        approval_policy: "on-request",
        sandbox_policy: {
          type: "workspace-write",
          network_access: false,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: false,
        },
        model: modelSettings.model,
        ...(modelSettings.effort ? { effort: modelSettings.effort } : {}),
      });
    }
  };

  const completeTurn = () => {
    if (!turnId) return;
    emit("event_msg", {
      type: "task_complete",
      turn_id: turnId,
      root_turn_id: turnId,
      last_agent_message: lastAgentText,
      started_at: turnStartedAt,
      completed_at: Math.floor(Date.now() / 1000),
    });
    turnId = null;
    lastAgentText = null;
  };

  const ensureTurn = (): string => {
    if (!turnId) startTurn();
    return turnId!;
  };

  for (const item of pkg.items) {
    const ts = item.timestamp ?? nowIso;
    if (item.kind === "user_message") {
      // every user message opens its own turn
      completeTurn();
      startTurn();
      // plain user_message event: the only form the legacy TUI read path
      // renders (and the source for title/first_user_message backfill)
      emit("event_msg", { type: "user_message", message: item.text ?? "" });
      emit("response_item", {
        type: "message",
        id: `msg_${uuidv7()}`,
        role: "user",
        content: [{ type: "input_text", text: item.text ?? "" }],
      });
    } else if (item.kind === "assistant_message") {
      ensureTurn();
      // Thinking is intentionally NOT emitted: native codex reasoning items
      // carry API-issued encrypted_content, and the Responses API rejects
      // replay of reasoning without it ("unverifiable hidden reasoning state",
      // unsupported_persisted_item_context). Imported chats drop thinking.
      // plain agent_message event: the only form the legacy TUI read path
      // renders; the migration canonicalizer turns it into an item_completed
      // AgentMessage record for paginated history
      emit("event_msg", { type: "agent_message", message: item.text ?? "" });
      emit("response_item", {
        type: "message",
        id: `msg_${uuidv7()}`,
        role: "assistant",
        content: [{ type: "output_text", text: item.text ?? "" }],
      });
      lastAgentText = item.text ?? "";
    } else if (item.kind === "tool_call" && item.tool) {
      ensureTurn();
      const callId = `call_${shortId()}${shortId()}${shortId()}`;
      const args =
        typeof item.tool.arguments === "string"
          ? item.tool.arguments
          : JSON.stringify(item.tool.arguments ?? {});
      emit("response_item", {
        type: "function_call",
        name: item.tool.name,
        arguments: args,
        call_id: callId,
      });
      // UI visibility: tool calls render only as item_completed turn items;
      // DynamicToolCall is the generic {tool, arguments, output} item type.
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(args);
      } catch {
        parsedArgs = args;
      }
      const output = item.tool.result?.content ?? "";
      emit("event_msg", {
        type: "item_completed",
        thread_id: sessionId,
        turn_id: turnId,
        item: {
          type: "DynamicToolCall",
          id: uuidv7(),
          tool: item.tool.name,
          arguments: parsedArgs,
          status: "completed",
          content_items: [{ type: "inputText", text: output }],
          success: true,
        },
        started_at_ms: tsMs(ts),
        completed_at_ms: tsMs(ts),
      });
      emit("response_item", {
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
    // file_change / service_event: not representable natively in codex —
    // filtered out upstream by performImport via capabilities
  }
  completeTurn();

  let wroteRollout = false;
  try {
    fs.mkdirSync(dateDir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    wroteRollout = true;

    // append to session_index.jsonl (required for TUI visibility)
    const idxPath = codexSessionIndexPath();
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    const entry = JSON.stringify({
      id: sessionId,
      thread_name: pkg.title ?? "Imported chat",
      updated_at: nowIso,
    });
    const existing = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "";
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(idxPath, existing + sep + entry + "\n", "utf8");
  } catch (err) {
    if (wroteRollout) {
      try {
        fs.rmSync(file);
      } catch {
        // best-effort cleanup
      }
    }
    throw new WriteFailureError("codex", (err as Error).message);
  }
  return { newSessionId: sessionId };
}

/**
 * Best-effort post-import step: make the imported session fully render in
 * the codex TUI right away. Imported sessions are written in the legacy
 * shape codex's own importer uses, where only user/agent messages render —
 * tool calls (DynamicToolCall item_completed records) become visible only
 * after the rollout is migrated to paginated history, which the codex daemon
 * otherwise does on its next startup. Migration additionally requires a
 * threads row in codex's state DB, which file-only rollouts don't have until
 * codex indexes them; `codex archive` + `codex unarchive` performs that
 * indexing through official CLI commands. Failures are ignored: the session
 * still renders messages, remains resumable, and the daemon migrates it
 * eventually.
 */
export function migrateCodexRolloutForVisibility(newSessionId: string): void {
  try {
    const bin = process.env.ACM_CODEX_BIN ?? "codex";
    const run = (args: string[]) =>
      spawnSync(bin, args, { stdio: "ignore", timeout: 120_000 }).status === 0;
    // archive indexes the rollout into the state DB (creating the threads row)
    if (!run(["archive", newSessionId])) return;
    // unarchive moves the rollout back to the live sessions root
    if (!run(["unarchive", newSessionId])) return;
    // migrate to paginated history: projects turns/items so the TUI renders
    // the full history (messages and tool calls) immediately
    run(["migrate-rollouts", "--apply", "--thread", newSessionId]);
  } catch {
    // best-effort only — never fail the transfer
  }
}
