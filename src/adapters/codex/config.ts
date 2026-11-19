import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../../core/paths.ts";

/**
 * Model settings resolved from the user's codex config (~/.codex/config.toml).
 *
 * codex persists the chat's model provider in session_meta and the model in
 * turn_context records. On resume it refuses chats whose provider is not
 * configured ("Model provider unavailable"), so imports must record a real,
 * configured provider — we reuse the user's current codex defaults (the model
 * their codex chats run on) instead of inventing an id.
 */
export interface CodexModelSettings {
  /** Configured provider id (config `model_provider`, codex default "openai"). */
  modelProvider: string;
  /** Configured model slug (config `model`), or null when unset. */
  model: string | null;
  /** Configured reasoning effort (config `model_reasoning_effort`), if any. */
  effort: string | null;
}

/** Parse top-level `key = "value"` string entries from a TOML document body. */
function tomlTopLevelString(body: string, key: string): string | null {
  let inTable = false;
  for (const line of body.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (raw.startsWith("[")) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const m = raw.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`));
    if (m) return m[1];
  }
  return null;
}

export function codexModelSettings(): CodexModelSettings {
  const configPath = path.join(homeDir(), ".codex", "config.toml");
  let body = "";
  try {
    body = fs.readFileSync(configPath, "utf8");
  } catch {
    // no config — codex built-in defaults apply
  }
  return {
    modelProvider: tomlTopLevelString(body, "model_provider") ?? "openai",
    model: tomlTopLevelString(body, "model"),
    effort: tomlTopLevelString(body, "model_reasoning_effort"),
  };
}
