import type { SubscriptionSummary, ThreadSummary, UserSummary } from "@agent-harness/contracts";
import { Plus, Search, X } from "lucide-react";
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
  attention?: boolean;
  count?: (threads: ThreadSummary[]) => number | null;
}

const navGroups: ReadonlyArray<{ label: string; items: readonly NavItem[] }> = [
  {
    label: "Work",
    items: [
      { id: "workspace", label: "Tasks", count: (threads) => threads.length },
      { id: "projects", label: "Projects" },
      { id: "reviews", label: "Reviews" },
      { id: "artifacts", label: "Artifacts" },
    ],
  },
  {
    label: "Operate",
    items: [
      { id: "agents", label: "Agents" },
      { id: "providers", label: "Model routes", attention: true },
      { id: "environments", label: "Environments" },
      { id: "capabilities", label: "Capabilities" },
    ],
  },
  {
    label: "Manage",
    items: [
      { id: "team", label: "Team and access", adminOnly: true },
      { id: "usage", label: "Usage" },
      { id: "billing", label: "Billing", adminOnly: true },
      { id: "audit", label: "Audit log", adminOnly: true },
    ],
  },
  {
    label: "Platform",
    items: [
      // One destination: the platform screen carries organizations, runtime
      // and feature-flag panels together, so three links would all read active.
      { id: "platform", label: "Platform admin", adminOnly: true },
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
    return { dot: "running-dot bg-primary", label: "running", text: "text-primary" };
  }
  if (status === "failed") {
    return { dot: "bg-destructive", label: "failed", text: "text-destructive" };
  }
  if (status === "completed") {
    return { dot: "bg-[var(--syn-add)]", label: "complete", text: "text-[var(--syn-add)]" };
  }
  if (status === "waiting") {
    return { dot: "bg-waiting", label: "waiting", text: "text-waiting" };
  }
  return { dot: "bg-muted-foreground", label: "idle", text: "text-muted-foreground" };
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

  return (
    <aside
      className={cn(
        "flex h-full w-[272px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        mobile ? "w-[min(88vw,320px)] shadow-2xl" : "hidden min-[900px]:flex",
      )}
    >
      <div className="shrink-0 border-b border-sidebar-border px-2 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            aria-keyshortcuts="Meta+Shift+N Control+Shift+N"
            className="text-ui-control h-[30px] min-w-0 flex-1 justify-center gap-2 rounded-[5px] bg-primary px-3 font-semibold tracking-[-0.01em] text-primary-foreground shadow-none hover:bg-primary/90"
            onClick={onNewTask}
            size="sm"
          >
            <Plus aria-hidden="true" className="size-3.5 stroke-[2.5]" />
            <span>New task</span>
            <kbd className="text-ui-micro font-mono font-medium opacity-55">⌘⇧N</kbd>
          </Button>
          {mobile ? (
            <Button
              aria-label="Close sidebar"
              className="size-[30px] shrink-0 rounded-[5px] border border-sidebar-border bg-transparent"
              onClick={onClose}
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="relative mt-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-label="Filter tasks"
            className="text-ui-control h-[30px] w-full rounded-[5px] border border-sidebar-border bg-background/40 py-1 pl-8 pr-9 text-foreground placeholder:text-muted-foreground focus:border-input focus:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter tasks"
            ref={filterRef}
            type="search"
            value={query}
          />
          <button
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search or jump"
            className="text-ui-micro absolute right-0 top-0 grid h-[30px] w-8 place-items-center rounded-r-[5px] font-mono text-muted-foreground transition-colors hover:text-foreground"
            onClick={onOpenCommandPalette}
            title="Search or run command (⌘K)"
            type="button"
          >
            /
          </button>
        </div>
      </div>

      <nav aria-label="Workspace navigation" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {navGroups.map((group, groupIndex) => {
          const visibleItems = group.items.filter(
            (item) => !item.adminOnly || user.role === "admin",
          );
          if (!visibleItems.length) return null;
          return (
            <section
              aria-labelledby={`sidebar-group-${group.label.toLocaleLowerCase()}`}
              className={cn(
                groupIndex > 0 && "mt-[18px]",
                group.label === "Platform" && "border-t border-dashed border-sidebar-border pt-3",
              )}
              key={group.label}
            >
              <h2
                className={cn(
                  "text-ui-micro mb-1.5 px-2 font-mono font-medium uppercase tracking-[0.19em] text-[color:var(--ink-4)]",
                  group.label === "Platform" && "text-human",
                )}
                id={`sidebar-group-${group.label.toLocaleLowerCase()}`}
              >
                {group.label === "Platform" ? "▣ " : null}{group.label}
              </h2>
              <div className="space-y-px">
                {visibleItems.map((item) => {
                  const active = item.id === "workspace"
                    ? view === "workspace"
                    : Boolean(item.id && view === item.id);
                  const count = item.count?.(threads) ?? null;
                  const billingAttention = item.id === "billing" && subscription.status !== "active";
                  return (
                    <button
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "text-ui-control relative flex h-[29px] w-full items-center rounded-[4px] px-2 text-left tracking-[-0.01em] transition-colors",
                        active
                          ? "bg-accent/55 font-medium text-foreground before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-[2px] before:rounded-full before:bg-primary"
                          : "text-secondary-foreground hover:bg-accent/35 hover:text-foreground",
                        item.disabled && "cursor-default text-[color:var(--ink-4)] hover:bg-transparent hover:text-[color:var(--ink-4)]",
                      )}
                      disabled={item.disabled}
                      key={`${group.label}-${item.label}`}
                      onClick={() => item.id && navigate(item.id)}
                      type="button"
                    >
                      <span className={cn(active && "pl-1.5")}>{item.label}</span>
                      {count !== null ? (
                        <span className="text-ui-meta ml-auto font-mono text-[color:var(--ink-4)]">{count}</span>
                      ) : null}
                      {item.attention || billingAttention ? (
                        <span
                          aria-hidden="true"
                          className="text-ui-micro ml-auto grid size-3.5 place-items-center rounded-[3px] border border-waiting/25 bg-waiting/10 font-mono text-waiting"
                          title="Attention"
                        >
                          !
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        <section aria-labelledby="sidebar-active-tasks" className="mt-6">
          <div className="mb-1.5 flex items-center gap-1.5 px-2">
            <h2
              className="text-ui-micro font-mono font-medium uppercase tracking-[0.19em] text-[color:var(--ink-4)]"
              id="sidebar-active-tasks"
            >
              Active
            </h2>
            <span aria-hidden="true" className="text-ui-micro font-mono text-[color:var(--ink-4)]">·</span>
            <span className="text-ui-micro font-mono text-[color:var(--ink-4)]">{filteredThreads.length}</span>
          </div>

          <div className="space-y-1.5">
            {filteredThreads.length ? (
              filteredThreads.map((thread) => {
                const selected = view === "workspace" && activeThreadId === thread.id;
                const tone = statusTone(thread.status);
                return (
                  <button
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "w-full rounded-[5px] border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-primary/45 bg-primary/[0.13] text-foreground"
                        : "border-sidebar-border bg-background/35 text-secondary-foreground hover:border-input hover:bg-accent/45",
                    )}
                    key={thread.id}
                    onClick={() => selectThread(thread.id)}
                    type="button"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
                      <span className={cn("text-ui-micro font-mono font-medium uppercase tracking-[0.12em]", tone.text)}>
                        {tone.label}
                      </span>
                      <span className="text-ui-meta ml-auto font-mono text-muted-foreground">
                        {relativeTime(thread.updatedAt)}
                      </span>
                    </span>
                    <span className="text-ui-control mt-1.5 block line-clamp-2 font-medium tracking-[-0.01em]">
                      {thread.title}
                    </span>
                    <span className="text-ui-meta mt-1 block truncate font-mono text-[color:var(--ink-4)]">
                      {thread.projectName ?? "No project"}
                      {thread.model ? ` · ${thread.model}` : ""}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="text-ui-meta rounded-[5px] border border-dashed border-sidebar-border px-3 py-3 text-muted-foreground">
                {query ? "No tasks match this filter." : "Your first task will appear here."}
              </div>
            )}
          </div>
        </section>
      </nav>

      <div className="text-ui-meta flex h-[31px] shrink-0 items-center border-t border-sidebar-border px-2.5 font-mono tracking-[0.04em] text-muted-foreground">
        <span aria-hidden="true" className="mr-2 size-1.5 rounded-full bg-healthy" />
        <span>control plane healthy</span>
        <button
          aria-label="Sign out"
          className="ml-auto rounded-sm px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onLogout}
          title="Sign out"
          type="button"
        >
          2/2 slots
        </button>
      </div>
    </aside>
  );
}
