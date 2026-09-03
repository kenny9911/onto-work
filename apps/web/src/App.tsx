import {
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  DashboardPayload,
  SavedProjectSummary,
  ThreadSummary,
  TimelineItem,
  UserSummary,
} from "@agent-harness/contracts";
import { KeyRound, LoaderCircle } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { AppHeader } from "@/components/AppHeader";
import { LoginScreen } from "@/components/LoginScreen";
import { RouteLoadingBoundary } from "@/components/RouteLoadingBoundary";
import { Sidebar } from "@/components/Sidebar";
import type { SavedProjectCacheChange } from "@/components/ControlPlaneView";
import type { CapabilityInventoryPayload } from "@/components/OperationsView";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiClientError, api, type RuntimeCapabilitiesPayload } from "@/lib/api";
import {
  createNotificationBuffer,
  drainNotificationBuffer,
  enqueueNotification,
  notificationByteLength,
  notificationMatchesThread,
  notificationThreadId,
  type CodexNotification,
} from "@/lib/codex-notifications";
import { shortcutFromKeyboardEvent } from "@/lib/keyboard-shortcuts";
import { routeFromPathname, writeBrowserRoute } from "@/lib/routes";
import { idleRuntimeStream, type RuntimeStreamState } from "@/lib/runtime-stream";
import type { AppRoute } from "@/lib/routes";
import { useCloseAtBreakpoint } from "@/lib/use-close-at-breakpoint";
import type { AppView, OperationsViewId } from "@/lib/view";

const ControlPlaneView = lazy(() =>
  import("@/components/ControlPlaneView").then((module) => ({
    default: module.ControlPlaneView,
  })),
);
const WorkspaceView = lazy(() =>
  import("@/components/WorkspaceView").then((module) => ({
    default: module.WorkspaceView,
  })),
);
const OperationsView = lazy(() =>
  import("@/components/OperationsView").then((module) => ({
    default: module.OperationsView,
  })),
);
const ArtifactsView = lazy(() =>
  import("@/components/ArtifactsView").then((module) => ({
    default: module.ArtifactsView,
  })),
);
const PlatformView = lazy(() =>
  import("@/components/PlatformView").then((module) => ({
    default: module.PlatformView,
  })),
);

const OPERATION_VIEWS = new Set<AppView>([
  "reviews",
  "agents",
  "environments",
  "capabilities",
]);

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: UserSummary };

let initialSessionRequest: ReturnType<typeof api.me> | null = null;
const NEW_TASK_TIMELINE_KEY = "new-task";


type PendingComposerMutation =
  | {
      kind: "task/create";
      key: string;
      message: string;
      projectId: string;
    }
  | {
      kind: "turn/start";
      key: string;
      message: string;
      threadId: string;
    }
  | {
      expectedTurnId: string;
      kind: "turn/steer";
      key: string;
      message: string;
      threadId: string;
    };

function timelineKey(threadId: string | null): string {
  return threadId ?? NEW_TASK_TIMELINE_KEY;
}

function isAvailableProject(project: SavedProjectSummary): boolean {
  return project.enabled && project.availability === "available";
}

function selectedProjectAfter(
  projects: SavedProjectSummary[],
  currentProjectId: string | null,
): string | null {
  if (
    currentProjectId
    && projects.some((project) => project.id === currentProjectId && isAvailableProject(project))
  ) {
    return currentProjectId;
  }
  return projects.find(isAvailableProject)?.id ?? null;
}

function upsertSavedProject(
  projects: SavedProjectSummary[],
  project: SavedProjectSummary,
): SavedProjectSummary[] {
  const existingIndex = projects.findIndex((candidate) => candidate.id === project.id);
  if (existingIndex === -1) return [project, ...projects];
  return projects.map((candidate, index) => index === existingIndex ? project : candidate);
}

function composerKey(threadId: string | null): string {
  return threadId ? `thread:${threadId}` : NEW_TASK_TIMELINE_KEY;
}

function shouldRetainMutation(cause: unknown): boolean {
  return !(cause instanceof ApiClientError) || cause.code === "request_in_progress";
}

function patchDashboardThread(
  dashboard: DashboardPayload,
  threadId: string,
  patch: Partial<ThreadSummary>,
): DashboardPayload {
  const patchThread = (thread: ThreadSummary) =>
    thread.id === threadId ? { ...thread, ...patch } : thread;
  return {
    ...dashboard,
    threads: dashboard.threads.map(patchThread),
    featuredThread: dashboard.featuredThread?.thread.id === threadId
      ? {
          ...dashboard.featuredThread,
          thread: patchThread(dashboard.featuredThread.thread),
        }
      : dashboard.featuredThread,
  };
}

function completedThreadStatus(turn: Record<string, unknown> | null): ThreadSummary["status"] {
  return turn?.status === "failed" ? "failed" : "idle";
}

function clientIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readInitialSession() {
  initialSessionRequest ??= api.me();
  return initialSessionRequest;
}

function routeForRole(route: AppRoute, role: UserSummary["role"]): AppRoute {
  if (
    role !== "admin"
    && (route.view === "team" || route.view === "billing" || route.view === "audit")
  ) {
    return { view: "workspace" };
  }
  return route;
}

function idFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["text", "delta", "message"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function applyNotification(items: TimelineItem[], notification: CodexNotification): TimelineItem[] {
  const method = notification.method ?? "event";
  const params = notification.params ?? {};
  const timestamp = new Date().toISOString();

  if (
    notification.kind === "server-request" &&
    notification.requestId !== undefined &&
    (method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval")
  ) {
    const requestId = notification.requestId;
    const command = textFrom(params.command);
    const reason = textFrom(params.reason);
    const cwd = textFrom(params.cwd);
    return [
      ...items,
      {
        id: `approval-${String(requestId)}`,
        kind: "approval",
        title: method.includes("commandExecution") ? "Command approval required" : "File change approval required",
        body: [command, reason, cwd ? `Working directory: ${cwd}` : null]
          .filter((value): value is string => Boolean(value))
          .join("\n") || "Codex is waiting for your decision.",
        status: "pending",
        timestamp,
        metadata: { requestId, method },
      },
    ];
  }

  if (method === "serverRequest/resolved") {
    const requestId = params.requestId;
    return items.map((item) =>
      item.kind === "approval" && item.metadata?.requestId === requestId
        ? { ...item, status: "completed" as const }
        : item,
    );
  }

  if (method.includes("agentMessage") && method.endsWith("delta")) {
    const delta = textFrom(params.delta) ?? textFrom(params);
    if (!delta) return items;
    const existingIndex = items.findLastIndex(
      (item) => item.kind === "assistant" && item.status === "running",
    );
    if (existingIndex === -1) {
      return [
        ...items,
        {
          id: `assistant-${Date.now()}`,
          kind: "assistant",
          title: "Agent",
          body: delta,
          status: "running",
          timestamp,
        },
      ];
    }
    return items.map((item, index) =>
      index === existingIndex ? { ...item, body: `${item.body}${delta}` } : item,
    );
  }

  if (method === "turn/completed") {
    return items.map((item) =>
      item.status === "running" ? { ...item, status: "completed" as const } : item,
    );
  }

  if (method === "item/started") {
    const item = params.item as Record<string, unknown> | undefined;
    const type = typeof item?.type === "string" ? item.type : "activity";
    if (type.toLowerCase().includes("command")) {
      const metadata = Object.fromEntries(
        Object.entries(item ?? {}).filter(
          (entry): entry is [string, string | number | boolean | null] =>
            entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
        ),
      );
      return [
        ...items,
        {
          id: idFrom(item) ?? `command-${Date.now()}`,
          kind: "command",
          title: "Run command",
          body: textFrom(item?.command) ?? "Command started",
          status: "running",
          timestamp,
          metadata,
        },
      ];
    }
  }

  return items;
}

function mcpCapabilityStatus(
  runtimeStatus: string | null,
  authStatus: string | null,
): "ready" | "disabled" | "blocked" | "error" | "unknown" {
  if (authStatus === "notLoggedIn" || runtimeStatus === "authenticationRequired") return "blocked";
  if (runtimeStatus === "connected") return "ready";
  if (runtimeStatus === "disabled" || runtimeStatus === "cancelled") return "disabled";
  if (runtimeStatus === "failed") return "error";
  return "unknown";
}

function capabilityInventory(payload: RuntimeCapabilitiesPayload): CapabilityInventoryPayload {
  const items: CapabilityInventoryPayload["items"][number][] = [];
  const warnings: string[] = [];

  if (payload.mcpServers.status === "available") {
    for (const server of payload.mcpServers.data.items) {
      const status = mcpCapabilityStatus(server.runtimeStatus, server.authStatus);
      items.push({
        id: `mcp:${server.pluginId ?? "local"}:${server.name}`,
        name: server.name,
        kind: "mcp_server",
        status,
        description: server.authStatus
          ? `Authentication: ${server.authStatus}`
          : "Authentication status was not reported.",
        source: server.pluginId ?? "Codex configuration",
      });
      for (const tool of server.tools) {
        items.push({
          id: `tool:${server.pluginId ?? "local"}:${server.name}:${tool}`,
          name: tool,
          kind: "tool",
          status,
          description: `Reported by ${server.name}`,
          source: server.name,
        });
      }
    }
  } else {
    warnings.push(payload.mcpServers.error.message);
  }

  if (payload.skills.status === "available") {
    for (const skill of payload.skills.data.items) {
      items.push({
        id: `skill:${skill.pluginId ?? skill.scope}:${skill.name}`,
        name: skill.displayName ?? skill.name,
        kind: "skill",
        status: skill.enabledInWorkspaceCount > 0 ? "ready" : "disabled",
        description: skill.description,
        source: skill.pluginId ?? skill.scope,
      });
    }
    if (payload.skills.data.loadErrorCount > 0) {
      warnings.push(
        `Codex reported ${payload.skills.data.loadErrorCount} skill load error${payload.skills.data.loadErrorCount === 1 ? "" : "s"}; affected details are not included.`,
      );
    }
  } else {
    warnings.push(payload.skills.error.message);
  }

  for (const section of [payload.models, payload.providerCapabilities, payload.permissionProfiles]) {
    if (section.status === "unavailable") warnings.push(section.error.message);
  }

  return {
    items,
    inventorySummary: {
      mcpServers: payload.mcpServers.status === "available"
        ? {
            count: payload.mcpServers.data.items.length,
            truncated: payload.mcpServers.data.truncated,
          }
        : null,
      tools: payload.mcpServers.status === "available"
        ? {
            count: payload.mcpServers.data.items.reduce(
              (count, server) => count + server.tools.length,
              0,
            ),
            truncated:
              payload.mcpServers.data.truncated
              || payload.mcpServers.data.items.some((server) => server.toolsTruncated),
          }
        : null,
      skills: payload.skills.status === "available"
        ? {
            count: payload.skills.data.items.length,
            truncated: payload.skills.data.truncated,
            loadErrorCount: payload.skills.data.loadErrorCount,
          }
        : null,
    },
    runtimeSurfaces: {
      models: payload.models.status === "available"
        ? {
            count: payload.models.data.items.length,
            defaultModel:
              payload.models.data.items.find((model) => model.isDefault)?.displayName
              ?? null,
            truncated: payload.models.data.truncated,
          }
        : null,
      permissionProfiles: payload.permissionProfiles.status === "available"
        ? {
            count: payload.permissionProfiles.data.items.length,
            allowedInAnyWorkspaceCount: payload.permissionProfiles.data.items.filter(
              (profile) => profile.allowedInWorkspaceCount > 0,
            ).length,
            workspaceCount: payload.permissionProfiles.data.workspaceCount,
            truncated: payload.permissionProfiles.data.truncated,
          }
        : null,
      providerCapabilities: payload.providerCapabilities.status === "available"
        ? payload.providerCapabilities.data
        : null,
    },
    updatedAt: payload.generatedAt,
    warnings: [...new Set(warnings)],
  };
}

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-background">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="grid size-8 place-items-center rounded-lg border border-border bg-card font-mono text-ui-meta font-semibold text-primary">AH</span>
        <LoaderCircle className="size-4 animate-spin" />
        Opening workspace
      </div>
    </main>
  );
}

function PasswordRotationDialog({
  user,
  onRotated,
}: {
  user: UserSummary;
  onRotated: (user: UserSummary) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      onRotated(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={user.mustChangePassword}>
      <DialogContent className="border-border bg-[#191c21] sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <div className="mb-2 grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10"><KeyRound className="size-4 text-primary" /></div>
            <DialogTitle>Replace the bootstrap password</DialogTitle>
            <DialogDescription>
              This temporary credential has completed its only job. Choose a unique password before using the harness.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5">
            <label className="grid gap-2 text-ui-control text-muted-foreground">Current password<Input autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} required type="password" value={currentPassword} /></label>
            <label className="grid gap-2 text-ui-control text-muted-foreground">New password<Input autoComplete="new-password" minLength={12} onChange={(event) => setNewPassword(event.target.value)} required type="password" value={newPassword} /></label>
            <label className="grid gap-2 text-ui-control text-muted-foreground">Confirm new password<Input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></label>
            {error ? <p role="alert" className="text-ui-body text-red-300">{error}</p> : null}
          </div>
          <DialogFooter><Button className="w-full" disabled={saving} type="submit">{saving ? "Updating…" : "Change password and sign in again"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HarnessApp({ user, onSignedOut }: { user: UserSummary; onSignedOut: () => void }) {
  const initialRoute = useRef(
    routeForRole(routeFromPathname(window.location.pathname), user.role),
  );
  const initialRouteResolved = useRef(false);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [view, setView] = useState<AppView>(initialRoute.current.view);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    initialRoute.current.threadId ?? null,
  );
  const activeThreadIdRef = useRef<string | null>(initialRoute.current.threadId ?? null);
  const [timelinesByThread, setTimelinesByThread] = useState<Record<string, TimelineItem[]>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [activeTurnsByThread, setActiveTurnsByThread] = useState<Record<string, string>>({});
  const [taskActionPending, setTaskActionPending] = useState<
    "rename" | "fork" | "archive" | "interrupt" | null
  >(null);
  const [capabilities, setCapabilities] = useState<CapabilityInventoryPayload | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<SavedProjectSummary[]>([]);
  const [savedProjectsLoading, setSavedProjectsLoading] = useState(true);
  const [savedProjectsError, setSavedProjectsError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [threadHydrationRevision, setThreadHydrationRevision] = useState(0);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [runtimeStream, setRuntimeStream] = useState<RuntimeStreamState>(
    idleRuntimeStream,
  );
  const [runtimeStreamNonce, setRuntimeStreamNonce] = useState(0);
  const runtimeStreamAttempt = useRef(0);
  const lastRuntimeEventAt = useRef<number | null>(null);
  const notificationQueue = useRef(createNotificationBuffer());
  const notificationFrame = useRef<number | null>(null);
  const notificationOverflowSequence = useRef(0);
  const threadHydrationInFlight = useRef(new Set<string>());
  const threadHydrationAttempted = useRef(new Set<string>());
  const threadHydrationRequested = useRef(new Set<string>());
  const threadHydrationGeneration = useRef<Record<string, number>>({});
  const threadLivenessEpoch = useRef<Record<string, number>>({});
  const threadStatusProof = useRef<Record<string, ThreadSummary["status"]>>({});
  const activeTurnsRef = useRef<Record<string, string>>({});
  const dashboardReadGeneration = useRef(0);
  const dashboardRefreshTimer = useRef<number | null>(null);
  const savedProjectsRef = useRef<SavedProjectSummary[]>([]);
  const savedProjectsReadGeneration = useRef(0);
  const pendingComposerMutations = useRef<Record<string, PendingComposerMutation>>({});
  const displayedComposerMessages = useRef<Record<string, string>>({});

  const selectActiveThreadId = useCallback((threadId: string | null) => {
    if (activeThreadIdRef.current !== threadId) {
      notificationQueue.current = createNotificationBuffer();
      if (notificationFrame.current !== null) {
        cancelAnimationFrame(notificationFrame.current);
        notificationFrame.current = null;
      }
    }
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
  }, []);

  const updateThreadTimeline = useCallback((
    threadId: string | null,
    update: (items: TimelineItem[]) => TimelineItem[],
  ) => {
    const key = timelineKey(threadId);
    setTimelinesByThread((timelines) => {
      const items = timelines[key] ?? [];
      const nextItems = update(items);
      return nextItems === items ? timelines : { ...timelines, [key]: nextItems };
    });
  }, []);

  const recordThreadStarted = useCallback((threadId: string, turnId: string) => {
    threadLivenessEpoch.current[threadId] = (threadLivenessEpoch.current[threadId] ?? 0) + 1;
    threadStatusProof.current[threadId] = "running";
    const nextTurns = { ...activeTurnsRef.current, [threadId]: turnId };
    activeTurnsRef.current = nextTurns;
    setActiveTurnsByThread(nextTurns);
    setDashboard((current) => current
      ? patchDashboardThread(current, threadId, {
          activeTurnId: turnId,
          status: "running",
          updatedAt: new Date().toISOString(),
        })
      : current);
  }, []);

  const recordThreadStopped = useCallback((
    threadId: string,
    expectedTurnId: string | null,
    status: ThreadSummary["status"] = "idle",
  ) => {
    const currentTurnId = activeTurnsRef.current[threadId];
    if (expectedTurnId && currentTurnId && currentTurnId !== expectedTurnId) return false;

    threadLivenessEpoch.current[threadId] = (threadLivenessEpoch.current[threadId] ?? 0) + 1;
    threadStatusProof.current[threadId] = status;
    if (currentTurnId) {
      const nextTurns = { ...activeTurnsRef.current };
      delete nextTurns[threadId];
      activeTurnsRef.current = nextTurns;
      setActiveTurnsByThread(nextTurns);
    }
    setDashboard((current) => current
      ? patchDashboardThread(current, threadId, {
          activeTurnId: null,
          status,
          updatedAt: new Date().toISOString(),
        })
      : current);
    return true;
  }, []);

  const loadDashboard = useCallback(async () => {
    const generation = dashboardReadGeneration.current + 1;
    dashboardReadGeneration.current = generation;
    const livenessAtRequest = { ...threadLivenessEpoch.current };
    try {
      const next = await api.dashboard();
      if (dashboardReadGeneration.current !== generation) return;
      const incomingThreads = next.featuredThread
        ? [...next.threads, next.featuredThread.thread]
        : next.threads;
      let mergedTurns = activeTurnsRef.current;
      for (const thread of incomingThreads) {
        if (
          thread.activeTurnId
          && (threadLivenessEpoch.current[thread.id] ?? 0) === (livenessAtRequest[thread.id] ?? 0)
          && mergedTurns[thread.id] !== thread.activeTurnId
        ) {
          mergedTurns = { ...mergedTurns, [thread.id]: thread.activeTurnId };
          threadLivenessEpoch.current[thread.id] = (threadLivenessEpoch.current[thread.id] ?? 0) + 1;
          threadStatusProof.current[thread.id] = "running";
        }
      }
      if (mergedTurns !== activeTurnsRef.current) {
        activeTurnsRef.current = mergedTurns;
        setActiveTurnsByThread(mergedTurns);
      }
      setDashboard((current) => {
        const preserveLiveness = (incoming: ThreadSummary): ThreadSummary => {
          const provenTurnId = activeTurnsRef.current[incoming.id];
          if (provenTurnId) {
            return { ...incoming, activeTurnId: provenTurnId, status: "running" };
          }
          if ((threadLivenessEpoch.current[incoming.id] ?? 0) === 0) return incoming;
          const existing = current?.threads.find((thread) => thread.id === incoming.id)
            ?? (current?.featuredThread?.thread.id === incoming.id
              ? current.featuredThread.thread
              : null);
          return existing
            ? {
                ...incoming,
                activeTurnId: null,
                status: threadStatusProof.current[incoming.id] ?? existing.status,
                updatedAt: existing.updatedAt,
              }
            : {
                ...incoming,
                activeTurnId: null,
                status: threadStatusProof.current[incoming.id] ?? incoming.status,
              };
        };
        const threads = next.threads.map(preserveLiveness);
        const incomingIds = new Set(threads.map((thread) => thread.id));
        const retainedThreads = current?.threads.filter(
          (thread) =>
            !incomingIds.has(thread.id)
            && (
              thread.id === activeThreadIdRef.current
              || Boolean(activeTurnsRef.current[thread.id])
            ),
        ) ?? [];
        return {
          ...next,
          threads: [...threads, ...retainedThreads],
          featuredThread: next.featuredThread
            ? {
                ...next.featuredThread,
                thread: preserveLiveness(next.featuredThread.thread),
              }
            : null,
        };
      });
      setFatalError(null);
      if (next.featuredThread) {
        const featuredKey = timelineKey(next.featuredThread.thread.id);
        setTimelinesByThread((timelines) =>
          Object.hasOwn(timelines, featuredKey)
            ? timelines
            : { ...timelines, [featuredKey]: next.featuredThread!.timeline },
        );
      }
      if (!initialRouteResolved.current) {
        initialRouteResolved.current = true;
        const requested = initialRoute.current;
        const initialThreadId = requested.threadId === undefined
          ? next.featuredThread?.thread.id ?? next.threads[0]?.id ?? null
          : requested.threadId;
        selectActiveThreadId(initialThreadId);

        if (requested.view === "workspace" && requested.threadId === undefined && initialThreadId) {
          writeBrowserRoute({ view: "workspace", threadId: initialThreadId }, "replace");
        } else if (requested.view !== "workspace") {
          writeBrowserRoute({ view: requested.view }, "replace");
        }
      }
    } catch (cause) {
      if (dashboardReadGeneration.current !== generation) return;
      if (cause instanceof ApiClientError && cause.status === 401) {
        onSignedOut();
        return;
      }
      setFatalError(cause instanceof Error ? cause.message : "Could not load workspace");
    }
  }, [onSignedOut, selectActiveThreadId]);

  const scheduleDashboardRefresh = useCallback(() => {
    if (dashboardRefreshTimer.current !== null) {
      window.clearTimeout(dashboardRefreshTimer.current);
    }
    dashboardRefreshTimer.current = window.setTimeout(() => {
      dashboardRefreshTimer.current = null;
      void loadDashboard();
    }, 250);
  }, [loadDashboard]);

  useEffect(() => {
    void loadDashboard();
    return () => {
      if (dashboardRefreshTimer.current !== null) {
        window.clearTimeout(dashboardRefreshTimer.current);
        dashboardRefreshTimer.current = null;
      }
    };
  }, [loadDashboard]);

  const loadSavedProjects = useCallback(async () => {
    const generation = savedProjectsReadGeneration.current + 1;
    savedProjectsReadGeneration.current = generation;
    setSavedProjectsLoading(true);
    setSavedProjectsError(null);
    try {
      const projects: SavedProjectSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await api.listProjects(100, cursor);
        if (generation !== savedProjectsReadGeneration.current) return;
        projects.push(...response.projects);
        if (!response.nextCursor) break;
        cursor = response.nextCursor;
      }
      if (generation !== savedProjectsReadGeneration.current) return;
      savedProjectsRef.current = projects;
      setSavedProjects(projects);
      setSelectedProjectId((current) => selectedProjectAfter(projects, current));
    } catch (cause) {
      if (generation !== savedProjectsReadGeneration.current) return;
      savedProjectsRef.current = [];
      setSavedProjects([]);
      setSelectedProjectId(null);
      setSavedProjectsError(
        cause instanceof Error ? cause.message : "Saved projects could not be loaded.",
      );
    } finally {
      if (generation === savedProjectsReadGeneration.current) setSavedProjectsLoading(false);
    }
  }, []);

  const handleSavedProjectsChanged = useCallback((change: SavedProjectCacheChange) => {
    if (change.type === "refresh") return loadSavedProjects();

    savedProjectsReadGeneration.current += 1;
    const projects = upsertSavedProject(savedProjectsRef.current, change.project);
    savedProjectsRef.current = projects;
    setSavedProjects(projects);
    setSelectedProjectId((current) => selectedProjectAfter(projects, current));
    setSavedProjectsError(null);
    setSavedProjectsLoading(false);
  }, [loadSavedProjects]);

  useEffect(() => {
    void loadSavedProjects();
  }, [loadSavedProjects]);

  const hasActiveProvider = Boolean(
    dashboard?.providers.some((provider) => provider.enabled),
  );

  useEffect(() => {
    if (view !== "capabilities") return;
    let active = true;
    setCapabilitiesLoading(true);
    setCapabilitiesError(null);
    void api.capabilities()
      .then((payload) => {
        if (active) setCapabilities(capabilityInventory(payload));
      })
      .catch((cause) => {
        if (!active) return;
        setCapabilities(null);
        setCapabilitiesError(
          cause instanceof Error ? cause.message : "Capability inventory is unavailable.",
        );
      })
      .finally(() => {
        if (active) setCapabilitiesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view]);

  useEffect(() => {
    if (!hasActiveProvider) {
      setRuntimeStream(idleRuntimeStream);
      return;
    }
    const events = new EventSource("/api/codex/events", { withCredentials: true });
    setRuntimeStream((current) => ({
      status: runtimeStreamAttempt.current === 0 ? "connecting" : "reconnecting",
      attempt: runtimeStreamAttempt.current,
      lastEventAt: current.lastEventAt,
    }));
    events.onopen = () => {
      runtimeStreamAttempt.current = 0;
      setRuntimeStream({ status: "live", attempt: 0, lastEventAt: null });
    };
    events.onerror = () => {
      // readyState CLOSED means this EventSource will not retry by itself.
      const retrying = events.readyState !== EventSource.CLOSED;
      runtimeStreamAttempt.current += 1;
      setRuntimeStream({
        status: retrying ? "reconnecting" : "offline",
        attempt: runtimeStreamAttempt.current,
        lastEventAt: lastRuntimeEventAt.current,
      });
    };
    const scheduleNotificationFrame = () => {
      if (notificationFrame.current !== null) return;
      notificationFrame.current = requestAnimationFrame(() => {
        const queued = drainNotificationBuffer(notificationQueue.current);
        notificationFrame.current = null;
        const selectedThreadId = activeThreadIdRef.current;
        if (!selectedThreadId) return;

        const matchingNotifications = queued.entries.filter(
          (entry) => entry.threadId === selectedThreadId,
        );
        const overflowed = queued.overflowed
          && queued.overflowThreadId === selectedThreadId;
        if (matchingNotifications.length === 0 && !overflowed) return;

        updateThreadTimeline(selectedThreadId, (items) => {
          const nextItems = matchingNotifications.reduce(
            (currentItems, entry) => applyNotification(currentItems, entry.notification),
            items,
          );
          if (!overflowed) return nextItems;
          notificationOverflowSequence.current += 1;
          return [
            ...nextItems,
            {
              id: `live-overflow-${Date.now()}-${notificationOverflowSequence.current}`,
              kind: "system",
              title: "Live updates were throttled",
              body: "Some live events were skipped to keep this tab responsive. Check the task state before acting on a pending approval.",
              status: "failed",
              timestamp: new Date().toISOString(),
            },
          ];
        });
      });
    };
    events.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") return;
        // Kept in a ref: this fires per streamed token and must not re-render.
        lastRuntimeEventAt.current = Date.now();
        const notification = JSON.parse(event.data) as CodexNotification;
        const eventThreadId = notificationThreadId(notification);
        const params = notification.params ?? {};
        const eventTurn = params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
          ? params.turn as Record<string, unknown>
          : null;
        const eventTurnId = idFrom(params.turnId) ?? idFrom(eventTurn);
        if (eventThreadId && notification.method === "turn/started" && eventTurnId) {
          recordThreadStarted(eventThreadId, eventTurnId);
          scheduleDashboardRefresh();
        } else if (eventThreadId && notification.method === "turn/completed") {
          if (recordThreadStopped(
            eventThreadId,
            eventTurnId,
            completedThreadStatus(eventTurn),
          )) {
            scheduleDashboardRefresh();
          }
        }

        const selectedThreadId = activeThreadIdRef.current;
        if (!selectedThreadId || !notificationMatchesThread(notification, selectedThreadId)) return;
        enqueueNotification(
          notificationQueue.current,
          notification,
          selectedThreadId,
          notificationByteLength(event.data),
        );
        scheduleNotificationFrame();
      } catch {
        // Malformed runtime events are ignored; the control plane remains authoritative.
      }
    };
    return () => {
      events.close();
      notificationQueue.current = createNotificationBuffer();
      if (notificationFrame.current !== null) {
        cancelAnimationFrame(notificationFrame.current);
        notificationFrame.current = null;
      }
    };
  }, [
    hasActiveProvider,
    recordThreadStarted,
    recordThreadStopped,
    runtimeStreamNonce,
    scheduleDashboardRefresh,
    updateThreadTimeline,
  ]);

  const retryRuntimeStream = useCallback(() => {
    runtimeStreamAttempt.current = 0;
    setRuntimeStreamNonce((current) => current + 1);
  }, []);

  const activeThread = useMemo(
    () => dashboard?.threads.find((thread) => thread.id === activeThreadId)
      ?? (dashboard?.featuredThread?.thread.id === activeThreadId ? dashboard.featuredThread.thread : null),
    [activeThreadId, dashboard],
  );
  const selectedSavedProject = useMemo(
    () => savedProjects.find((project) => project.id === selectedProjectId) ?? null,
    [savedProjects, selectedProjectId],
  );
  const timeline = timelinesByThread[timelineKey(activeThreadId)] ?? [];

  useEffect(() => {
    document.documentElement.dataset.ahTheme = theme;
  }, [theme]);

  useEffect(() => {
    if (!dashboard || !activeThreadId) return;
    const key = timelineKey(activeThreadId);
    const hasSummary = dashboard.threads.some((thread) => thread.id === activeThreadId)
      || dashboard.featuredThread?.thread.id === activeThreadId;
    const refreshRequested = threadHydrationRequested.current.has(activeThreadId);
    if (
      hasSummary
      && Object.hasOwn(timelinesByThread, key)
      && !refreshRequested
    ) return;
    if (threadHydrationAttempted.current.has(activeThreadId) && !refreshRequested) return;
    if (threadHydrationInFlight.current.has(activeThreadId)) return;

    const threadId = activeThreadId;
    threadHydrationRequested.current.delete(threadId);
    const generation = (threadHydrationGeneration.current[threadId] ?? 0) + 1;
    threadHydrationGeneration.current[threadId] = generation;
    const livenessAtRequest = threadLivenessEpoch.current[threadId] ?? 0;
    threadHydrationInFlight.current.add(threadId);
    void api.thread(threadId)
      .then((detail) => {
        if (threadHydrationGeneration.current[threadId] !== generation) return;
        const canApplyLiveness = (threadLivenessEpoch.current[threadId] ?? 0) === livenessAtRequest;
        if (canApplyLiveness) {
          if (detail.thread.activeTurnId) {
            recordThreadStarted(detail.thread.id, detail.thread.activeTurnId);
          } else {
            recordThreadStopped(detail.thread.id, null, detail.thread.status);
          }
        }
        setDashboard((current) => {
          if (!current) return current;
          const currentSummary = current.threads.find((thread) => thread.id === detail.thread.id)
            ?? (current.featuredThread?.thread.id === detail.thread.id
              ? current.featuredThread.thread
              : null);
          const provenTurnId = activeTurnsRef.current[detail.thread.id];
          const hydratedThread = canApplyLiveness
            ? detail.thread.activeTurnId
              ? { ...detail.thread, status: "running" as const }
              : detail.thread
            : {
                ...detail.thread,
                activeTurnId: provenTurnId ?? null,
                status: provenTurnId
                  ? "running" as const
                  : threadStatusProof.current[detail.thread.id]
                    ?? currentSummary?.status
                    ?? detail.thread.status,
                updatedAt: currentSummary?.updatedAt ?? detail.thread.updatedAt,
              };
          const existing = current.threads.findIndex((thread) => thread.id === detail.thread.id);
          const threads = existing === -1
            ? [hydratedThread, ...current.threads]
            : current.threads.map((thread) =>
                thread.id === detail.thread.id ? hydratedThread : thread,
              );
          return {
            ...current,
            threads,
            featuredThread: current.featuredThread?.thread.id === detail.thread.id
              ? { ...current.featuredThread, thread: hydratedThread }
              : current.featuredThread,
          };
        });
        setTimelinesByThread((timelines) => {
          const liveItems = timelines[key] ?? [];
          const seen = new Set<string>();
          const merged = [...detail.timeline, ...liveItems].filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
          return { ...timelines, [key]: merged };
        });
      })
      .catch((cause) => {
        if (
          threadHydrationGeneration.current[threadId] !== generation
          || threadHydrationRequested.current.has(threadId)
        ) return;
        setTimelinesByThread((timelines) => {
          if (Object.hasOwn(timelines, key) && timelines[key]!.length > 0) return timelines;
          return {
            ...timelines,
            [key]: [
              {
                id: `history-error-${threadId}`,
                kind: "system",
                title: "Task history unavailable",
                body: cause instanceof Error
                  ? cause.message
                  : "The durable task history could not be loaded.",
                status: "failed",
                timestamp: new Date().toISOString(),
              },
            ],
          };
        });
      })
      .finally(() => {
        if (threadHydrationGeneration.current[threadId] !== generation) return;
        threadHydrationAttempted.current.add(threadId);
        threadHydrationInFlight.current.delete(threadId);
        if (threadHydrationRequested.current.has(threadId)) {
          setThreadHydrationRevision((revision) => revision + 1);
        }
      });
  }, [
    activeThreadId,
    dashboard,
    recordThreadStarted,
    recordThreadStopped,
    threadHydrationRevision,
    timelinesByThread,
  ]);

  const composerDraftKey = activeThreadId ? `thread:${activeThreadId}` : "new-task";
  const composerDraft = composerDrafts[composerDraftKey] ?? "";
  const updateComposerDraft = useCallback((value: string) => {
    setComposerDrafts((drafts) => {
      if ((drafts[composerDraftKey] ?? "") === value) return drafts;
      if (!value) {
        const remaining = { ...drafts };
        delete remaining[composerDraftKey];
        return remaining;
      }
      return { ...drafts, [composerDraftKey]: value };
    });
  }, [composerDraftKey]);

  useCloseAtBreakpoint("(min-width: 900px)", setSidebarOpen);

  const navigate = useCallback((nextView: AppView) => {
    const nextRoute = routeForRole({ view: nextView }, user.role);
    setView(nextRoute.view);
    setSidebarOpen(false);
    writeBrowserRoute(
      nextRoute.view === "workspace"
        ? { view: nextRoute.view, threadId: activeThreadId }
        : nextRoute,
    );
  }, [activeThreadId, user.role]);

  const selectThread = useCallback((id: string) => {
    threadHydrationRequested.current.add(id);
    threadHydrationAttempted.current.delete(id);
    setThreadHydrationRevision((revision) => revision + 1);
    selectActiveThreadId(id);
    setView("workspace");
    setSidebarOpen(false);
    if (dashboard?.featuredThread?.thread.id === id) {
      setTimelinesByThread((timelines) =>
        Object.hasOwn(timelines, id)
          ? timelines
          : { ...timelines, [id]: dashboard.featuredThread!.timeline },
      );
    }
    writeBrowserRoute({ view: "workspace", threadId: id });
  }, [dashboard, selectActiveThreadId]);

  const selectProject = useCallback((projectId: string) => {
    if (projectId !== selectedProjectId) {
      delete pendingComposerMutations.current[NEW_TASK_TIMELINE_KEY];
    }
    setSelectedProjectId(projectId);
  }, [selectedProjectId]);

  const startReview = useCallback(async (threadId: string) => {
    const livenessAtRequest = threadLivenessEpoch.current[threadId] ?? 0;
    const response = await api.startReview<{
      turn?: { id?: string };
      reviewThreadId?: string;
    }>(threadId, { type: "uncommittedChanges" });
    const turnId = response.result.turn?.id;
    if (!turnId || response.result.reviewThreadId !== threadId) {
      throw new Error("Codex did not return a verifiable inline review turn.");
    }
    if ((threadLivenessEpoch.current[threadId] ?? 0) === livenessAtRequest) {
      recordThreadStarted(threadId, turnId);
    }
    scheduleDashboardRefresh();
    selectThread(threadId);
  }, [recordThreadStarted, scheduleDashboardRefresh, selectThread]);

  const newTask = useCallback(() => {
    delete pendingComposerMutations.current[NEW_TASK_TIMELINE_KEY];
    delete displayedComposerMessages.current[NEW_TASK_TIMELINE_KEY];
    selectActiveThreadId(null);
    setTimelinesByThread((timelines) => ({
      ...timelines,
      [NEW_TASK_TIMELINE_KEY]: [],
    }));
    setView("workspace");
    setSidebarOpen(false);
    setCommandPaletteOpen(false);
    writeBrowserRoute({ view: "workspace", threadId: null });
  }, [selectActiveThreadId]);

  useEffect(() => {
    function handlePopState() {
      const requestedRoute = routeFromPathname(window.location.pathname);
      const route = routeForRole(requestedRoute, user.role);
      setView(route.view);
      setSidebarOpen(false);
      setCommandPaletteOpen(false);
      if (route.view !== requestedRoute.view) {
        writeBrowserRoute({ view: "workspace", threadId: activeThreadId }, "replace");
      }
      if (route.threadId !== undefined) {
        if (route.threadId) {
          threadHydrationRequested.current.add(route.threadId);
          threadHydrationAttempted.current.delete(route.threadId);
          setThreadHydrationRevision((revision) => revision + 1);
        }
        selectActiveThreadId(route.threadId);
        if (route.threadId && dashboard?.featuredThread?.thread.id === route.threadId) {
          setTimelinesByThread((timelines) =>
            Object.hasOwn(timelines, route.threadId!)
              ? timelines
              : { ...timelines, [route.threadId!]: dashboard.featuredThread!.timeline },
          );
        }
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeThreadId, dashboard, selectActiveThreadId, user.role]);

  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === "command-palette") {
        setCommandPaletteOpen((open) => !open);
      } else {
        newTask();
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [newTask]);

  useEffect(() => {
    const title = view === "workspace"
      ? activeThread?.title ?? "New task"
      : {
          projects: "Projects",
          reviews: "Reviews",
          artifacts: "Artifacts",
          agents: "Agents",
          platform: "Platform admin",
          providers: "Model routes",
          environments: "Environments",
          capabilities: "Capabilities",
          team: "Team",
          usage: "Usage",
          billing: "Billing",
          audit: "Audit log",
        }[view];
    document.title = `${title} · Agent Harness`;
  }, [activeThread?.title, view]);

  async function sendMessage(message: string, uploadIds?: string[]) {
    if (!dashboard) return;
    // Opaque upload ids only — never a path, never a URL. `turn/steer` has no
    // attachments field, so a steer carries none.
    const attachments = (uploadIds ?? []).filter((uploadId) => uploadId.length > 0);
    let threadId = activeThreadIdRef.current;
    let requestComposerKey = composerKey(threadId);
    let attemptedMutation: PendingComposerMutation | null = null;
    let failureTitle = threadId ? "Turn could not start" : "Task could not start";
    const retryingDisplayedMessage = displayedComposerMessages.current[requestComposerKey] === message;
    if (!retryingDisplayedMessage) {
      displayedComposerMessages.current[requestComposerKey] = message;
      updateThreadTimeline(threadId, (items) => [
        ...items,
        {
          id: `user-${Date.now()}`,
          kind: "user",
          title: user.displayName,
          body: message,
          status: "completed",
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    setIsSending(true);

    try {
      if (!threadId) {
        const project = savedProjects.find(
          (candidate) =>
            candidate.id === selectedProjectId
            && candidate.enabled
            && candidate.availability === "available",
        );
        if (!project) {
          throw new Error(
            savedProjectsError
              ?? "Choose an available saved project before starting this task.",
          );
        }
        const existingCreation = pendingComposerMutations.current[requestComposerKey];
        const creation = existingCreation?.kind === "task/create"
          && existingCreation.message === message
          && existingCreation.projectId === project.id
          ? existingCreation
          : {
              kind: "task/create" as const,
              key: clientIdempotencyKey(),
              message,
              projectId: project.id,
            };
        pendingComposerMutations.current[requestComposerKey] = creation;
        attemptedMutation = creation;
        const started = await api.createTask<{ thread?: { id?: string }; id?: string }>(
          { projectId: project.id },
          creation.key,
        );
        threadId = started.result.thread?.id ?? started.result.id ?? null;
        if (!threadId) throw new Error("Codex did not return a thread id");
        const createdThreadId = threadId;
        setTimelinesByThread((timelines) => {
          const optimisticItems = timelines[NEW_TASK_TIMELINE_KEY] ?? [];
          const existingItems = timelines[createdThreadId] ?? [];
          const nextTimelines = {
            ...timelines,
            [createdThreadId]: [...existingItems, ...optimisticItems],
          };
          delete nextTimelines[NEW_TASK_TIMELINE_KEY];
          return nextTimelines;
        });
        setComposerDrafts((drafts) => ({
          ...drafts,
          [`thread:${createdThreadId}`]: message,
        }));
        delete pendingComposerMutations.current[requestComposerKey];
        attemptedMutation = null;
        delete displayedComposerMessages.current[requestComposerKey];
        requestComposerKey = composerKey(createdThreadId);
        displayedComposerMessages.current[requestComposerKey] = message;
        selectActiveThreadId(createdThreadId);
        writeBrowserRoute({ view: "workspace", threadId }, "replace");
        failureTitle = "Turn could not start";
      }

      const activeTurnId = activeTurnsByThread[threadId];
      const existingMutation = pendingComposerMutations.current[requestComposerKey];
      const matchingMutation = existingMutation
        && existingMutation.kind !== "task/create"
        && existingMutation.threadId === threadId
        && existingMutation.message === message
        ? existingMutation
        : null;
      const mutation: PendingComposerMutation = matchingMutation ?? (activeTurnId
        ? {
            expectedTurnId: activeTurnId,
            kind: "turn/steer",
            key: clientIdempotencyKey(),
            message,
            threadId,
          }
        : {
            kind: "turn/start",
            key: clientIdempotencyKey(),
            message,
            threadId,
          });
      pendingComposerMutations.current[requestComposerKey] = mutation;
      attemptedMutation = mutation;
      const livenessAtRequest = threadLivenessEpoch.current[mutation.threadId] ?? 0;
      if (mutation.kind === "turn/steer") {
        failureTitle = "Active turn could not be steered";
        await api.steerTurn(
          mutation.threadId,
          mutation.expectedTurnId,
          mutation.message,
          mutation.key,
        );
      } else {
        const startedTurn = await api.codexRequest<{ turn?: { id?: string }; id?: string }>(
          "turn/start",
          {
            threadId: mutation.threadId,
            input: [{ type: "text", text: mutation.message }],
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          mutation.key,
        );
        const turnId = startedTurn.result.turn?.id ?? startedTurn.result.id;
        if (!turnId) throw new Error("Codex did not return a turn id");
        if ((threadLivenessEpoch.current[mutation.threadId] ?? 0) === livenessAtRequest) {
          recordThreadStarted(mutation.threadId, turnId);
        }
      }
      scheduleDashboardRefresh();
      delete pendingComposerMutations.current[requestComposerKey];
      delete displayedComposerMessages.current[requestComposerKey];
      setComposerDrafts((drafts) => {
        const next = { ...drafts };
        delete next[NEW_TASK_TIMELINE_KEY];
        delete next[`thread:${threadId}`];
        return next;
      });
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "active_turn_mismatch" && threadId) {
        if (attemptedMutation?.kind === "turn/steer") {
          recordThreadStopped(threadId, attemptedMutation.expectedTurnId);
        }
        threadHydrationRequested.current.add(threadId);
        threadHydrationAttempted.current.delete(threadId);
        setThreadHydrationRevision((revision) => revision + 1);
      }
      if (!shouldRetainMutation(cause)) {
        delete pendingComposerMutations.current[requestComposerKey];
      }
      updateThreadTimeline(threadId, (items) => [
        ...items,
        {
          id: `error-${Date.now()}`,
          kind: "system",
          title: failureTitle,
          body: cause instanceof Error ? cause.message : "The runtime rejected the request.",
          status: "failed",
          timestamp: new Date().toISOString(),
        },
      ]);
      throw cause instanceof Error ? cause : new Error("The runtime rejected the request.");
    } finally {
      setIsSending(false);
    }
  }

  async function renameTask(name: string) {
    const threadId = activeThreadIdRef.current;
    if (!threadId || taskActionPending) return;
    setTaskActionPending("rename");
    try {
      await api.renameTask(threadId, name);
      setDashboard((current) => current
        ? {
            ...current,
            threads: current.threads.map((thread) =>
              thread.id === threadId ? { ...thread, title: name } : thread,
            ),
            featuredThread: current.featuredThread?.thread.id === threadId
              ? {
                  ...current.featuredThread,
                  thread: { ...current.featuredThread.thread, title: name },
                }
              : current.featuredThread,
          }
        : current);
    } finally {
      setTaskActionPending(null);
    }
  }

  async function forkTask() {
    const threadId = activeThreadIdRef.current;
    if (!threadId || taskActionPending) return;
    setTaskActionPending("fork");
    try {
      const forked = await api.forkTask(threadId);
      const forkedThreadId = forked.result.thread.id;
      threadHydrationAttempted.current.delete(forkedThreadId);
      await loadDashboard();
      selectThread(forkedThreadId);
    } finally {
      setTaskActionPending(null);
    }
  }

  async function archiveTask() {
    const threadId = activeThreadIdRef.current;
    if (!threadId || taskActionPending) return;
    setTaskActionPending("archive");
    try {
      await api.archiveTask(threadId);
      setDashboard((current) => current
        ? {
            ...current,
            threads: current.threads.filter((thread) => thread.id !== threadId),
            featuredThread: current.featuredThread?.thread.id === threadId
              ? null
              : current.featuredThread,
          }
        : current);
      newTask();
    } finally {
      setTaskActionPending(null);
    }
  }

  async function interruptTurn() {
    const threadId = activeThreadIdRef.current;
    const turnId = threadId ? activeTurnsByThread[threadId] : null;
    if (!threadId || !turnId || taskActionPending) return;
    setTaskActionPending("interrupt");
    try {
      await api.interruptTurn(threadId, turnId);
      recordThreadStopped(threadId, turnId);
      scheduleDashboardRefresh();
    } finally {
      setTaskActionPending(null);
    }
  }

  async function resolveApproval(
    item: TimelineItem,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ) {
    const requestId = item.metadata?.requestId;
    const method = item.metadata?.method;
    if (
      (typeof requestId !== "string" && typeof requestId !== "number") ||
      (method !== "item/commandExecution/requestApproval" &&
        method !== "item/fileChange/requestApproval")
    ) return;

    const approvalThreadId = activeThreadIdRef.current;
    updateThreadTimeline(approvalThreadId, (items) =>
      items.map((candidate) =>
        candidate.id === item.id ? { ...candidate, status: "running" as const } : candidate,
      ),
    );
    try {
      await api.resolveCodexApproval(requestId, method, decision);
    } catch (cause) {
      updateThreadTimeline(approvalThreadId, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                status: "failed" as const,
                body: `${candidate.body}\n\n${cause instanceof Error ? cause.message : "The decision could not be sent."}`,
              }
            : candidate,
        ),
      );
    }
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      onSignedOut();
    }
  }

  if (!dashboard) {
    if (fatalError) {
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6 text-center">
          <div className="max-w-sm"><h1 className="text-lg font-medium">Workspace unavailable</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{fatalError}</p><Button className="mt-5" onClick={() => void loadDashboard()} variant="outline">Try again</Button></div>
        </main>
      );
    }
    return <LoadingScreen />;
  }

  return (
    <div className="relative grid h-dvh min-h-0 min-w-0 grid-rows-[44px_minmax(0,1fr)] overflow-hidden bg-background">
      <a
        className="sr-only z-50 rounded-md bg-popover px-3 py-2 text-ui-control text-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
        href="#main-content"
      >
        Skip to main content
      </a>
      <AppHeader
        activeThread={activeThread}
        dashboard={dashboard}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenSidebar={() => setSidebarOpen(true)}
        onOpenWorkspace={() => navigate("workspace")}
        onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        selectedProject={selectedSavedProject}
        theme={theme}
      />

      <div className="flex min-h-0 min-w-0 overflow-hidden">
        <Sidebar
          activeThreadId={activeThreadId}
          onLogout={() => void logout()}
          onNavigate={navigate}
          onNewTask={newTask}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onSelectThread={selectThread}
          subscription={dashboard.subscription}
          threads={dashboard.threads}
          user={dashboard.user}
          view={view}
        />

      <Dialog onOpenChange={setSidebarOpen} open={sidebarOpen}>
        <DialogContent className="left-0 top-0 h-dvh w-[min(88vw,320px)] max-w-none translate-x-0 translate-y-0 gap-0 border-y-0 border-l-0 p-0 sm:rounded-none [&>button]:hidden min-[900px]:hidden">
          <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
          <DialogDescription className="sr-only">Choose a task or control-plane section.</DialogDescription>
          <Sidebar
            activeThreadId={activeThreadId}
            mobile
            onClose={() => setSidebarOpen(false)}
            onLogout={() => void logout()}
            onNavigate={navigate}
            onNewTask={newTask}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            onSelectThread={selectThread}
            subscription={dashboard.subscription}
            threads={dashboard.threads}
            user={dashboard.user}
            view={view}
          />
        </DialogContent>
      </Dialog>

      <CommandPalette
        onNavigate={navigate}
        onNewTask={newTask}
        onOpenChange={setCommandPaletteOpen}
        onSelectThread={selectThread}
        open={commandPaletteOpen}
        role={dashboard.user.role}
        threads={dashboard.threads}
      />

      <RouteLoadingBoundary resetKey={view}>
        {view === "workspace" ? (
          <WorkspaceView
            activeThread={activeThread}
            activeThreadId={activeThreadId}
            activeTurnId={activeThreadId ? activeTurnsByThread[activeThreadId] ?? null : null}
            draft={composerDraft}
            dashboard={dashboard}
            isSending={isSending}
            onApproval={resolveApproval}
            onArchive={archiveTask}
            onDraftChange={updateComposerDraft}
            onFork={forkTask}
            onInterrupt={interruptTurn}
            onOpenSidebar={() => setSidebarOpen(true)}
            onReloadProjects={loadSavedProjects}
            onRename={renameTask}
            onRetryRuntimeStream={retryRuntimeStream}
            onSelectProject={selectProject}
            onSend={sendMessage}
            runtimeStream={runtimeStream}
            savedProjects={savedProjects}
            savedProjectsError={savedProjectsError}
            savedProjectsLoading={savedProjectsLoading}
            selectedProjectId={selectedProjectId}
            taskActionPending={taskActionPending}
            timeline={timeline}
          />
        ) : view === "artifacts" ? (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
            <ArtifactsView onOpenWorkspace={() => navigate("workspace")} />
          </main>
        ) : view === "platform" ? (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
            <PlatformView dashboard={dashboard} onNavigate={navigate} />
          </main>
        ) : OPERATION_VIEWS.has(view) ? (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
            <OperationsView
              activeThreadId={activeThreadId}
              capabilities={capabilities}
              capabilitiesError={capabilitiesError}
              capabilitiesLoading={capabilitiesLoading}
              dashboard={dashboard}
              onOpenSidebar={() => setSidebarOpen(true)}
              onStartReview={startReview}
              onSelectThread={selectThread}
              timeline={timeline}
              view={view as OperationsViewId}
            />
          </main>
        ) : (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
            <ControlPlaneView
              dashboard={dashboard}
              onOpenSidebar={() => setSidebarOpen(true)}
              onProjectsChanged={handleSavedProjectsChanged}
              onRefresh={loadDashboard}
              view={view as Extract<AppView, "projects" | "providers" | "team" | "usage" | "billing" | "audit">}
            />
          </main>
        )}
      </RouteLoadingBoundary>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    readInitialSession()
      .then(({ user }) => {
        if (active) setSession({ status: "authenticated", user });
      })
      .catch(() => {
        if (active) setSession({ status: "anonymous" });
      });
    return () => {
      active = false;
    };
  }, []);

  if (session.status === "loading") return <LoadingScreen />;
  if (session.status === "anonymous") {
    return <LoginScreen onAuthenticated={(user) => setSession({ status: "authenticated", user })} />;
  }
  if (session.user.mustChangePassword) {
    return (
      <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background">
        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(183,255,74,.075),transparent_38%)]" />
        <div className="relative flex items-center gap-3 text-sm text-muted-foreground">
          <span className="grid size-8 place-items-center rounded-lg border border-border bg-card font-mono text-ui-meta font-semibold text-primary">AH</span>
          Securing the workspace
        </div>
        <PasswordRotationDialog
          onRotated={(user) => setSession({ status: "authenticated", user })}
          user={session.user}
        />
      </main>
    );
  }
  return <HarnessApp onSignedOut={() => setSession({ status: "anonymous" })} user={session.user} />;
}
