import fs from "node:fs";
import path from "node:path";
import { piSessionFileName, piSlug, shortId, uuidv7 } from "../../core/paths.ts";
import type { TransferPackage } from "../../core/package.ts";
import { WriteFailureError, type ImportOptions, type ImportResult } from "../types.ts";
import { piSessionsRoot } from "./read.ts";

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export function importPiSession(
  pkg: TransferPackage,
  opts: ImportOptions = {},
): ImportResult {
  const root = piSessionsRoot();
  const cwd = opts.project ?? pkg.cwd ?? process.env.HOME ?? ".";
  const sessionId = uuidv7();
  const nowIso = new Date().toISOString();
  const dir = path.join(root, piSlug(cwd));
  const file = path.join(dir, piSessionFileName(sessionId));

  const lines: string[] = [];
  let parentId: string | null = null;
  const emit = (record: Record<string, unknown>) => {
    lines.push(JSON.stringify(record));
  };

  emit({ type: "session", version: 3, id: sessionId, timestamp: nowIso, cwd });

  for (const item of pkg.items) {
    const id = shortId();
    const ts = item.timestamp ?? nowIso;
    const epoch = Date.parse(ts);
    const epochMs = Number.isNaN(epoch) ? Date.now() : epoch;
    if (item.kind === "user_message") {
      emit({
        type: "message",
        id,
        parentId,
        timestamp: ts,
        message: {
          role: "user",
          content: [{ type: "text", text: item.text ?? "" }],
          timestamp: epochMs,
        },
      });
      parentId = id;
    } else if (item.kind === "assistant_message") {
      const content: PiContentBlock[] = [];
      if (item.thinking) content.push({ type: "thinking", thinking: item.thinking });
      content.push({ type: "text", text: item.text ?? "" });
      emit({
        type: "message",
        id,
        parentId,
        timestamp: ts,
        message: {
          role: "assistant",
          content,
          timestamp: epochMs,
        },
      });
      parentId = id;
    } else if (item.kind === "tool_call" && item.tool) {
      const callId = `call_${shortId()}${shortId()}`;
      emit({
        type: "message",
        id,
        parentId,
        timestamp: ts,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: callId,
              name: item.tool.name,
              arguments: item.tool.arguments ?? {},
            },
          ],
          timestamp: epochMs,
        },
      });
      parentId = id;
      const resultId = shortId();
      emit({
        type: "message",
        id: resultId,
        parentId,
        timestamp: ts,
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: item.tool.name,
          content: [{ type: "text", text: item.tool.result?.content ?? "" }],
          isError: item.tool.result?.isError ?? false,
          durationMs: 0,
          timestamp: epochMs,
        },
      });
      parentId = resultId;
    }
    // file_change / service_event are filtered out upstream via capabilities
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  } catch (err) {
    throw new WriteFailureError("pi", (err as Error).message);
  }
  return { newSessionId: sessionId };
}
