import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_NOTIFICATION_BYTES,
  MAX_PENDING_NOTIFICATION_COUNT,
  createNotificationBuffer,
  drainNotificationBuffer,
  enqueueNotification,
  notificationMatchesThread,
  notificationThreadId,
  type CodexNotification,
} from "./codex-notifications";

const activeNotification: CodexNotification = {
  kind: "notification",
  method: "item/agentMessage/delta",
  params: {
    delta: "hello",
    threadId: "thread-active",
  },
};

describe("Codex notification routing", () => {
  it("extracts direct, nested turn, and nested approval thread ids", () => {
    expect(notificationThreadId(activeNotification)).toBe("thread-active");
    expect(notificationThreadId({
      method: "turn/completed",
      params: { turn: { threadId: "thread-from-turn" } },
    })).toBe("thread-from-turn");
    expect(notificationThreadId({
      kind: "server-request",
      method: "item/commandExecution/requestApproval",
      params: { approval: { threadId: "thread-from-approval" } },
    })).toBe("thread-from-approval");
  });

  it("routes only task timeline events for the selected thread", () => {
    expect(notificationMatchesThread(activeNotification, "thread-active")).toBe(true);
    expect(notificationMatchesThread(activeNotification, "thread-other")).toBe(false);
    expect(notificationMatchesThread(activeNotification, null)).toBe(false);
    expect(notificationMatchesThread({
      kind: "notification",
      method: "runtime/connected",
      params: {},
    }, "thread-active")).toBe(false);
  });
});

describe("Codex notification buffering", () => {
  it("clears queued events and records a recovery target at the count limit", () => {
    const buffer = createNotificationBuffer();
    for (let index = 0; index < MAX_PENDING_NOTIFICATION_COUNT; index += 1) {
      expect(enqueueNotification(buffer, activeNotification, "thread-active", 1)).toBe("queued");
    }

    expect(enqueueNotification(buffer, activeNotification, "thread-active", 1)).toBe("overflow");
    expect(buffer.entries).toHaveLength(0);
    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.overflowed).toBe(true);
    expect(buffer.overflowThreadId).toBe("thread-active");

    const drained = drainNotificationBuffer(buffer);
    expect(drained).toMatchObject({
      entries: [],
      overflowed: true,
      overflowThreadId: "thread-active",
    });
    expect(buffer).toMatchObject({
      entries: [],
      pendingBytes: 0,
      overflowed: false,
      overflowThreadId: null,
    });
  });

  it("rejects a single event beyond the byte limit without retaining it", () => {
    const buffer = createNotificationBuffer();
    expect(enqueueNotification(
      buffer,
      activeNotification,
      "thread-active",
      MAX_PENDING_NOTIFICATION_BYTES + 1,
    )).toBe("overflow");
    expect(buffer.entries).toHaveLength(0);
    expect(buffer.pendingBytes).toBe(0);
    expect(buffer.overflowed).toBe(true);
  });
});
