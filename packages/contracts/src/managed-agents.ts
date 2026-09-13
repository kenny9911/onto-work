/** Public managed-runtime contracts. Remote IDs, paths and credentials stay on the server. */
export interface ManagedAgentDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  model: string;
  runtime: "agents_api";
  capabilities: {
    readOnly: true;
    steer: boolean;
    cancel: true;
    attachments: false;
    writeActions: false;
  };
  maxSubagents: number;
}

export interface ManagedAgentCatalog {
  available: boolean;
  reason: string | null;
  agents: ManagedAgentDefinition[];
}

export type ManagedTaskStatus = "starting" | "running" | "idle" | "failed" | "cancelled"
  | "interrupted" | "deleting" | "deleted";

export interface ManagedTaskSummary {
  id: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentVersion: string;
  title: string;
  status: ManagedTaskStatus;
  turnId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** Immutable committed source reviewed by this task; never an uncommitted worktree. */
  sourceRevision: string | null;
}

export interface ManagedTaskItem {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  status: "in_progress" | "completed" | "failed";
  subagentId: string | null;
}

export interface ManagedTaskDetail extends ManagedTaskSummary {
  items: ManagedTaskItem[];
  usage: { inputTokens: number; outputTokens: number; reported?: boolean };
}

export interface ManagedTaskPayload { task: ManagedTaskDetail }
export interface ManagedTaskListPayload { tasks: ManagedTaskSummary[] }
export interface CreateManagedTaskPayload { projectId: string; agentId: string; message: string }
export interface ManagedTaskMessagePayload {
  message: string;
  mode: "follow_up" | "steer";
  expectedTurnId?: string;
}
