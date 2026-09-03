export interface CodexNotification {
  kind?: "notification" | "server-request";
  method?: string;
  params?: Record<string, unknown>;
  requestId?: string | number;
}

export const MAX_PENDING_NOTIFICATION_COUNT = 256;
export const MAX_PENDING_NOTIFICATION_BYTES = 256 * 1024;

interface BufferedNotification {
  notification: CodexNotification;
  threadId: string;
}

export interface NotificationBuffer {
  entries: BufferedNotification[];
  pendingBytes: number;
  overflowed: boolean;
  overflowThreadId: string | null;
}

export interface DrainedNotificationBuffer {
  entries: BufferedNotification[];
  overflowed: boolean;
  overflowThreadId: string | null;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringProperty(value: unknown, key: string): string | null {
  const record = recordFrom(value);
  const candidate = record?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function notificationThreadId(notification: CodexNotification): string | null {
  const params = recordFrom(notification.params);
  if (!params) return null;

  return stringProperty(params, "threadId")
    ?? stringProperty(params.turn, "threadId")
    ?? stringProperty(params.approval, "threadId");
}

export function isTimelineNotification(notification: CodexNotification): boolean {
  const method = notification.method;
  if (!method) return false;

  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "serverRequest/resolved"
    || method === "turn/completed"
    || method === "item/started"
    || (method.includes("agentMessage") && method.endsWith("delta"));
}

export function notificationMatchesThread(
  notification: CodexNotification,
  activeThreadId: string | null,
): notification is CodexNotification {
  return activeThreadId !== null
    && isTimelineNotification(notification)
    && notificationThreadId(notification) === activeThreadId;
}

export function notificationByteLength(serializedNotification: string): number {
  return new TextEncoder().encode(serializedNotification).byteLength;
}

export function createNotificationBuffer(): NotificationBuffer {
  return {
    entries: [],
    pendingBytes: 0,
    overflowed: false,
    overflowThreadId: null,
  };
}

export function enqueueNotification(
  buffer: NotificationBuffer,
  notification: CodexNotification,
  threadId: string,
  byteLength: number,
): "queued" | "overflow" {
  if (buffer.overflowed) return "overflow";

  if (
    buffer.entries.length >= MAX_PENDING_NOTIFICATION_COUNT
    || byteLength > MAX_PENDING_NOTIFICATION_BYTES
    || buffer.pendingBytes + byteLength > MAX_PENDING_NOTIFICATION_BYTES
  ) {
    buffer.entries.length = 0;
    buffer.pendingBytes = 0;
    buffer.overflowed = true;
    buffer.overflowThreadId = threadId;
    return "overflow";
  }

  buffer.entries.push({ notification, threadId });
  buffer.pendingBytes += byteLength;
  return "queued";
}

export function drainNotificationBuffer(
  buffer: NotificationBuffer,
): DrainedNotificationBuffer {
  const drained = {
    entries: buffer.entries.splice(0),
    overflowed: buffer.overflowed,
    overflowThreadId: buffer.overflowThreadId,
  };
  buffer.pendingBytes = 0;
  buffer.overflowed = false;
  buffer.overflowThreadId = null;
  return drained;
}
