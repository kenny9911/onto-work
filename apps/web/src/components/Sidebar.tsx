import type { SubscriptionSummary, ThreadSummary, UserSummary } from "@agent-harness/contracts";
import {
  Blocks, Boxes, FileCheck2, FileStack, FolderGit2, Gauge,
  LogOut, MessageSquareText, Plus, Search, ScrollText,
  ServerCog, ShieldCheck, Users, Workflow, X, CreditCard,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppView } from "@/lib/view";

interface SidebarProps {
  user: UserSummary;
  subscription: SubscriptionSummary;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  view: AppView;
  mobile?: boolean;
  onClose?: () => void;
  onOpenCommandPalette: () => void;
  onNewTask: () => void;
  onSelectThread: (id: string) => void;
  onNavigate: (view: AppView) => void;
  onLogout: () => void;
}

interface NavItem {
  id?: AppView;
  label: string;
  adminOnly?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  count?: (threads: ThreadSummary[]) => number | null;
}

const navGroups: ReadonlyArray<{ label: string; items: readonly NavItem[] }> = [
  {
    label: "Work",
    items: [
      { id: "workspace", label: "Tasks", icon: MessageSquareText, count: (threads) => threads.length },
      { id: "projects", label: "Projects", icon: FolderGit2 },
      { id: "reviews", label: "Reviews", icon: FileCheck2 },
      { id: "artifacts", label: "Artifacts", icon: FileStack },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "agents", label: "Agents", icon: Workflow },
      { id: "providers", label: "Model routes", icon: Boxes },
      { id: "environments", label: "Environments", icon: ServerCog },
      { id: "capabilities", label: "Capabilities", icon: Blocks },
    ],
  },
  {
    label: "Organization",
    items: [
      { id: "team", label: "Team and access", icon: Users, adminOnly: true },
      { id: "usage", label: "Usage", icon: Gauge },
      { id: "billing", label: "Billing", icon: CreditCard, adminOnly: true },
      { id: "audit", label: "Audit log", icon: ScrollText, adminOnly: true },
    ],
  },
  {
    label: "Platform",
    items: [
      // One destination: the platform screen carries organizations, runtime
      // and feature-flag panels together, so three links would all read active.
      { id: "platform", label: "Platform admin", icon: ShieldCheck, adminOnly: true },
    ],
  },
];

function relativeTime(timestamp: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusTone(status: ThreadSummary["status"]): {
  dot: string;
  label: string;
  text: string;
} {
  if (status === "running") {
    return { dot: "running-dot bg-healthy", label: "Running", text: "text-healthy" };
  }
  if (status === "failed") {
    return { dot: "bg-destructive", label: "Failed", text: "text-destructive" };
  }
  if (status === "completed") {
    return { dot: "bg-[var(--syn-add)]", label: "Complete", text: "text-[var(--syn-add)]" };
  }
  if (status === "waiting") {
    return { dot: "bg-waiting", label: "Waiting", text: "text-waiting" };
  }
  return { dot: "bg-muted-foreground", label: "Idle", text: "text-muted-foreground" };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function Sidebar({
  user,
  subscription,
  threads,
  activeThreadId,
  view,
  mobile = false,
  onClose,
  onOpenCommandPalette,
  onNewTask,
  onSelectThread,
  onNavigate,
  onLogout,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const filteredThreads = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return threads;
    return threads.filter((thread) =>
      [thread.title, thread.preview, thread.projectName, thread.model]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, threads]);

  useEffect(() => {
    function focusFilter(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      filterRef.current?.focus();
    }

    window.addEventListener("keydown", focusFilter);
    return () => window.removeEventListener("keydown", focusFilter);
  }, []);

  function selectThread(threadId: string) {
    onSelectThread(threadId);
    if (mobile) onClose?.();
  }

  function navigate(nextView: AppView) {
    onNavigate(nextView);
    if (mobile) onClose?.();
  }

  function renderNavigationGroup(group: (typeof navGroups)[number]) {
    const visibleItems = group.items.filter((item) => !item.adminOnly || user.role === "admin");
    if (!visibleItems.length) return null;
    return (
      <section aria-labelledby={`sidebar-group-${group.label.toLocaleLowerCase()}`} className={cn(group.label !== "Work" && "mt-5")} key={group.label}>
        <h2 className="mb-1 px-3 text-ui-meta font-medium text-muted-foreground" id={`sidebar-group-${group.label.toLocaleLowerCase()}`}>
          {group.label}
        </h2>
        <div className="space-y-0.5">
          {visibleItems.map((item) => {
            const active = item.id === view;
            const count = item.count?.(threads) ?? null;
            const Icon = item.icon;
            return (
              <button
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-[38px] w-full items-center gap-3 rounded-lg px-3 text-left text-ui-control transition-colors",
                  active ? "bg-background font-medium text-foreground" : "text-secondary-foreground hover:bg-card/70 hover:text-foreground",
                  item.disabled && "cursor-default opacity-45",
                )}
                disabled={item.disabled}
                key={item.label}
                onClick={() => item.id && navigate(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
                <span>{item.label}</span>
                {count !== null ? <span className="ml-auto text-ui-meta tabular-nums text-muted-foreground">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </section>
  );
    }

  const accountInitials = user.displayName.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "U";

  return (
    <aside
      className={cn(
        "flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        mobile ? "w-[min(88vw,320px)] max-w-full shadow-xl" : "hidden min-[900px]:flex",
      )}
    >
      <div className="shrink-0 px-3 pb-2 pt-4">
        <div className="flex items-center gap-2">
          <Button
            aria-keyshortcuts="Meta+Shift+N Control+Shift+N"
            className="h-10 min-w-0 flex-1 justify-start gap-2.5 rounded-xl px-3.5 font-medium shadow-none"
            onClick={onNewTask}
          >
            <Plus aria-hidden="true" className="size-4" />
            <span>New task</span>
            <kbd className="ml-auto text-ui-meta font-sans font-normal opacity-60">⌘⇧N</kbd>
          </Button>
          {mobile ? (
            <Button aria-label="Close sidebar" className="size-10 rounded-xl" onClick={onClose} size="icon" variant="ghost">
              <X aria-hidden="true" className="size-4" />
            </Button>
          ) : null}
        </div>
        <div className="relative mt-2">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Filter tasks"
            className="h-[38px] w-full rounded-xl border border-transparent bg-transparent py-2 pl-10 pr-10 text-ui-control text-foreground placeholder:text-muted-foreground hover:bg-card/70 focus:border-input focus:bg-background"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a task"
            ref={filterRef}
            type="search"
            value={query}
          />
          <button
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search or jump"
            className="absolute right-1 top-1 grid size-[30px] place-items-center rounded-lg text-ui-meta text-muted-foreground hover:bg-card/70 hover:text-foreground"
            onClick={onOpenCommandPalette}
            title="Search tasks and commands (⌘K)"
            type="button"
          >
            /
          </button>
        </div>
      </div>

      <nav aria-label="Workspace navigation" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-5">
        {navGroups.filter((group) => group.label === "Work").map(renderNavigationGroup)}

        <section aria-labelledby="sidebar-active-tasks" className="mt-6 border-t border-sidebar-border pt-4">
          <div className="mb-2 flex items-center justify-between px-3">
            <h2 className="text-ui-meta font-medium text-muted-foreground" id="sidebar-active-tasks">Recent tasks</h2>
            <span className="text-ui-meta tabular-nums text-muted-foreground">{filteredThreads.length}</span>
          </div>
          <div className="space-y-1">
            {filteredThreads.length ? filteredThreads.map((thread) => {
              const selected = view === "workspace" && activeThreadId === thread.id;
              const tone = statusTone(thread.status);
              return (
                <button
                  aria-current={selected ? "page" : undefined}
                  className={cn("w-full rounded-xl px-3 py-2.5 text-left transition-colors", selected ? "bg-background text-foreground" : "text-secondary-foreground hover:bg-card/70")}
                  key={thread.id}
                  onClick={() => selectThread(thread.id)}
                  type="button"
                >
                  <span className="block truncate text-ui-control font-medium">{thread.title}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-ui-meta text-muted-foreground">
                    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
                    <span className={tone.text}>{tone.label}</span>
                    {thread.projectName ? <span className="truncate">· {thread.projectName}</span> : null}
                    <span className="ml-auto shrink-0 tabular-nums">{relativeTime(thread.updatedAt)}</span>
                  </span>
                </button>
              );
            }) : (
              <p className="px-3 py-2 text-ui-meta leading-5 text-muted-foreground">
                {query ? "No tasks match this filter." : "Your first task will appear here."}
              </p>
            )}
          </div>
        </section>

        {navGroups.filter((group) => group.label !== "Work").map(renderNavigationGroup)}
      </nav>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-sidebar-border px-4 py-3.5">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-ui-meta font-semibold text-foreground">{accountInitials}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-control font-medium text-foreground">{user.displayName}</p>
          <p className="mt-0.5 text-ui-meta capitalize text-muted-foreground">{subscription.plan} plan · {user.role === "admin" ? "Admin" : "Member"}</p>
        </div>
        <Button aria-label="Sign out" className="size-8 rounded-lg text-muted-foreground" onClick={onLogout} size="icon-sm" title="Sign out" variant="ghost">
          <LogOut aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </aside>
  );
}
