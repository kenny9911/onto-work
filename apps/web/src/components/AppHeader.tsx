import type {
  DashboardPayload,
  ProjectSummary,
  ThreadSummary,
} from "@agent-harness/contracts";
import {
  ChevronDown,
  Menu,
  FolderClosed,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AppHeaderProps {
  dashboard: DashboardPayload;
  activeThread: ThreadSummary | null;
  /** Supplies new-task project context before a thread exists. */
  selectedProject?: ProjectSummary | null;
  /** Until tenant metadata is included in the dashboard contract. */
  organizationName?: string | null;
  theme?: "dark" | "light";
  onOpenSidebar: () => void;
  onOpenWorkspace: () => void;
  onOpenCommandPalette: () => void;
  onToggleTheme: () => void;
  onOpenOrganizationMenu?: () => void;
  onOpenAccountMenu?: () => void;
}

function initials(value: string, fallback: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]![0] ?? ""}${parts.at(-1)![0] ?? ""}`.toUpperCase();
  }
  return (parts[0] ?? fallback).slice(0, 2).toUpperCase();
}

function projectContext(
  dashboard: DashboardPayload,
  activeThread: ThreadSummary | null,
  selectedProject: ProjectSummary | null | undefined,
): { name: string; branch: string | null } {
  const registeredProject = activeThread?.projectId
    ? dashboard.projects.find((project) => project.id === activeThread.projectId)
    : undefined;
  const project = registeredProject ?? (activeThread ? undefined : selectedProject);
  return {
    name: project?.name ?? activeThread?.projectName ?? "No project",
    branch: project?.branch ?? null,
  };
}

export function AppHeader({
  dashboard,
  activeThread,
  selectedProject,
  organizationName,
  theme = "light",
  onOpenSidebar,
  onOpenWorkspace,
  onOpenCommandPalette,
  onToggleTheme,
  onOpenOrganizationMenu,
  onOpenAccountMenu,
}: AppHeaderProps) {
  const organization = organizationName?.trim() || "Current organization";
  const organizationInitials = initials(organization, "OR");
  const accountInitials = initials(
    dashboard.user.displayName,
    dashboard.user.username || "U",
  );
  const project = projectContext(dashboard, activeThread, selectedProject);
  const roleLabel = dashboard.user.role === "admin" ? "Administrator" : "Member";

  const organizationContent = (
    <>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-ui-meta font-medium text-secondary-foreground">{organizationInitials}</span>
      <span className="hidden min-w-0 truncate text-ui-control sm:inline">{organization}</span>
      {onOpenOrganizationMenu ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </>
  );

  return (
    <header aria-label="Workspace header" className="flex h-14 min-w-0 shrink-0 items-center border-b border-border bg-background text-foreground">
      <div className="flex h-full shrink-0 items-center gap-2 px-3 min-[900px]:w-64 min-[900px]:border-r min-[900px]:border-sidebar-border min-[900px]:bg-sidebar min-[900px]:px-5">
        <Button aria-label="Open sidebar" className="size-8 rounded-lg min-[900px]:hidden" onClick={onOpenSidebar} size="icon-sm" variant="ghost">
          <Menu aria-hidden="true" className="size-4" />
        </Button>
        <Button aria-label="Open onto-work workspace" className="h-9 gap-2.5 px-0 hover:bg-transparent" onClick={onOpenWorkspace} variant="ghost">
          <span aria-hidden="true" className="relative grid size-7 place-items-center">
            <span className="absolute size-5 rotate-[-15deg] rounded-[6px] border-[1.5px] border-current" />
            <span className="absolute size-5 translate-x-[3px] translate-y-[-2px] rotate-[15deg] rounded-[6px] border-[1.5px] border-current bg-sidebar" />
            <span className="relative size-1.5 rounded-full bg-current" />
          </span>
          <span className="hidden text-[17px] font-semibold tracking-tight min-[390px]:inline">onto-work</span>
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3 px-3 sm:px-5">
        {onOpenOrganizationMenu ? (
          <Button aria-haspopup="menu" aria-label={`Organization: ${organization}`} className="h-9 min-w-0 max-w-52 justify-start gap-2 rounded-lg px-2" onClick={onOpenOrganizationMenu} variant="ghost">
            {organizationContent}
          </Button>
        ) : (
          <div aria-label={`Organization: ${organization}`} className="hidden min-w-0 max-w-52 items-center gap-2 lg:flex" role="group">
            {organizationContent}
          </div>
        )}

        <span aria-hidden="true" className="hidden text-border lg:inline">/</span>
        <button className="hidden h-9 min-w-0 items-center gap-2 rounded-lg px-1 text-left text-ui-control text-secondary-foreground hover:text-foreground md:flex" onClick={onOpenWorkspace} type="button">
          <FolderClosed aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="max-w-40 truncate lg:max-w-48">{project.name}</span>
          {project.branch ? <span className="hidden max-w-44 truncate rounded-md bg-muted px-2 py-1 font-mono text-ui-meta text-muted-foreground 2xl:inline">{project.branch}</span> : null}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search or run command"
            className="size-9 gap-2 rounded-lg text-muted-foreground lg:w-auto lg:px-3"
            onClick={onOpenCommandPalette}
            variant="ghost"
          >
            <Search aria-hidden="true" className="size-4 shrink-0" />
            <span className="hidden text-ui-control font-normal lg:inline">Search</span>
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-ui-meta font-sans font-normal lg:inline">⌘K</kbd>
          </Button>
          <Button
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "light"}
            className="size-9 rounded-lg text-muted-foreground"
            onClick={onToggleTheme}
            size="icon"
            variant="ghost"
          >
            {theme === "dark" ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
          </Button>
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <span className="hidden text-ui-meta text-muted-foreground xl:inline">{roleLabel}</span>
          {onOpenAccountMenu ? (
            <Button aria-haspopup="menu" aria-label={`${dashboard.user.displayName} account`} className="ml-1 size-8 rounded-full bg-accent text-ui-meta font-medium" onClick={onOpenAccountMenu} size="icon-sm" variant="ghost">{accountInitials}</Button>
          ) : (
            <span aria-label={`${dashboard.user.displayName} account`} className="ml-1 grid size-8 place-items-center rounded-full bg-accent text-ui-meta font-medium" role="img" title={`${dashboard.user.displayName} · ${roleLabel}`}>{accountInitials}</span>
          )}
        </div>
      </div>
    </header>
  );
}
