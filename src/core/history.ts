import { z } from "zod";

export const HISTORY_ITEM_KINDS = [
  "user_message",
  "assistant_message",
  "tool_call",
  "file_change",
  "service_event",
] as const;

export type HistoryItemKind = (typeof HISTORY_ITEM_KINDS)[number];

export const ToolRefSchema = z.object({
  name: z.string(),
  arguments: z.unknown(),
  result: z
    .object({
      content: z.string(),
      isError: z.boolean(),
    })
    .nullable(),
});

export const FileChangeSchema = z.object({
  path: z.string(),
  changeType: z.enum(["create", "modify", "delete", "unknown"]),
  diff: z.string().nullable(),
});

export const ServiceEventSchema = z.object({
  sourceType: z.string(),
  payload: z.unknown(),
});

export const HistoryItemSchema = z.object({
  kind: z.enum(HISTORY_ITEM_KINDS),
  position: z.number().int().nonnegative(),
  timestamp: z.string().nullable(),
  text: z.string().nullable(),
  thinking: z.string().nullable(),
  tool: ToolRefSchema.nullable(),
  fileChange: FileChangeSchema.nullable(),
  event: ServiceEventSchema.nullable(),
  sourceRef: z
    .object({
      agent: z.string(),
      nativeId: z.string(),
    })
    .nullable(),
});

export type ToolRef = z.infer<typeof ToolRefSchema>;
export type FileChange = z.infer<typeof FileChangeSchema>;
export type ServiceEvent = z.infer<typeof ServiceEventSchema>;

export type HistoryItem = z.infer<typeof HistoryItemSchema>;

/** Create an empty item of the given kind (exactly one payload field set later). */
export function makeItem(
  kind: HistoryItemKind,
  position: number,
  timestamp: string | null,
): HistoryItem {
  return {
    kind,
    position,
    timestamp,
    text: null,
    thinking: null,
    tool: null,
    fileChange: null,
    event: null,
    sourceRef: null,
  };
}

export function userMessage(position: number, timestamp: string | null, text: string): HistoryItem {
  const item = makeItem("user_message", position, timestamp);
  item.text = text;
  return item;
}

export function assistantMessage(
  position: number,
  timestamp: string | null,
  text: string,
  thinking: string | null = null,
): HistoryItem {
  const item = makeItem("assistant_message", position, timestamp);
  item.text = text;
  item.thinking = thinking;
  return item;
}

export function toolCall(
  position: number,
  timestamp: string | null,
  tool: ToolRef,
): HistoryItem {
  const item = makeItem("tool_call", position, timestamp);
  item.tool = tool;
  return item;
}

export function fileChangeItem(
  position: number,
  timestamp: string | null,
  change: FileChange,
): HistoryItem {
  const item = makeItem("file_change", position, timestamp);
  item.fileChange = change;
  return item;
}

export function serviceEventItem(
  position: number,
  timestamp: string | null,
  event: ServiceEvent,
): HistoryItem {
  const item = makeItem("service_event", position, timestamp);
  item.event = event;
  return item;
}
