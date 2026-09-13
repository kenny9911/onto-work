import type {
  ManagedAgentCatalog,
  CreateManagedTaskPayload,
  ManagedTaskDetail,
  ManagedTaskMessagePayload,
  ManagedTaskSummary,
} from "@agent-harness/contracts";
import { idempotencyKey, request } from "./api";

export type { ManagedAgentCatalog } from "@agent-harness/contracts";
export type ManagedTaskMessage = ManagedTaskMessagePayload;

const taskPath = (taskId: string) => `/api/managed-tasks/${encodeURIComponent(taskId)}`;

export const managedAgentsApi = {
  catalog: () => request<ManagedAgentCatalog>("/api/managed-agents"),
  list: () => request<{ tasks: ManagedTaskSummary[] }>("/api/managed-tasks"),
  detail: (taskId: string) => request<{ task: ManagedTaskDetail }>(taskPath(taskId)),
  create: (
    input: CreateManagedTaskPayload,
    requestKey = idempotencyKey(),
  ) => request<{ task: ManagedTaskDetail }>("/api/managed-tasks", {
    method: "POST",
    headers: { "idempotency-key": requestKey },
    body: JSON.stringify(input),
  }),
  message: (taskId: string, input: ManagedTaskMessage, requestKey = idempotencyKey()) =>
    request<{ task: ManagedTaskDetail }>(`${taskPath(taskId)}/messages`, {
      method: "POST",
      headers: { "idempotency-key": requestKey },
      body: JSON.stringify(input),
    }),
  cancel: (taskId: string, expectedTurnId: string | null, requestKey = idempotencyKey()) =>
    request<{ task: ManagedTaskDetail }>(`${taskPath(taskId)}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": requestKey },
      body: JSON.stringify({ expectedTurnId }),
    }),
  remove: (taskId: string, requestKey = idempotencyKey()) =>
    request<{ task: ManagedTaskDetail }>(taskPath(taskId), {
      method: "DELETE",
      headers: { "idempotency-key": requestKey },
    }),
  eventsUrl: (taskId: string) => `${taskPath(taskId)}/events`,
};
