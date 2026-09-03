import type { AppView } from "@/lib/view";

export interface AppRoute {
  view: AppView;
  /**
   * `undefined` keeps the current task selection (settings and the root route),
   * `null` opens the explicit new-task workspace, and a string deep-links a task.
   */
  threadId?: string | null;
}

const VIEW_ROUTES: Readonly<Record<Exclude<AppView, "workspace">, string>> = {
  projects: "/projects",
  reviews: "/reviews",
  artifacts: "/artifacts",
  agents: "/agents",
  platform: "/platform",
  providers: "/settings/providers",
  environments: "/settings/environments",
  capabilities: "/settings/capabilities",
  team: "/settings/team",
  usage: "/settings/usage",
  billing: "/settings/billing",
  audit: "/settings/audit",
};

const LEGACY_VIEW_ROUTES: Readonly<Partial<Record<AppView, readonly string[]>>> = {
  environments: ["/environments"],
  capabilities: ["/capabilities"],
};

function decodedPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function routeFromPathname(pathname: string): AppRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const taskMatch = /^\/tasks\/([^/]+)$/.exec(normalized);
  if (taskMatch?.[1]) {
    const threadId = decodedPathSegment(taskMatch[1]);
    if (threadId) return { view: "workspace", threadId };
  }

  if (normalized === "/workspace") return { view: "workspace", threadId: null };
  for (const [view, path] of Object.entries(VIEW_ROUTES) as Array<
    [Exclude<AppView, "workspace">, string]
  >) {
    const legacyPaths = LEGACY_VIEW_ROUTES[view] ?? [];
    if (normalized === path || normalized === `/${view}` || legacyPaths.includes(normalized)) {
      return { view };
    }
  }

  return { view: "workspace" };
}

export function pathForView(view: AppView, threadId?: string | null): string {
  if (view === "workspace") {
    return threadId ? `/tasks/${encodeURIComponent(threadId)}` : "/workspace";
  }
  return VIEW_ROUTES[view];
}

export function writeBrowserRoute(
  route: AppRoute,
  mode: "push" | "replace" = "push",
): void {
  const nextPath = pathForView(route.view, route.threadId);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextPath) {
    return;
  }
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", nextPath);
}
