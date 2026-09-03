import type {
  DashboardPayload,
  ProjectSummary,
  ThreadSummary,
} from "@agent-harness/contracts";
import {
  ChevronDown,
  Menu,
  PanelTop,
  Search,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  theme = "dark",
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
  const roleLabel = dashboard.user.role === "admin" ? "ORG ADMIN" : "MEMBER";

  return (
    <header
      aria-label="Workspace header"
      className="relative flex h-11 min-w-0 shrink-0 items-stretch gap-2.5 border-b border-border bg-[var(--c-plate)] px-3 text-foreground"
    >
      <div className="flex shrink-0 items-center border-r border-border pl-8 pr-2.5 min-[900px]:pl-0">
        <Button
          aria-label="Open Agent Harness workspace"
          className="text-ui-control h-8 justify-start gap-2 px-0 font-semibold tracking-[-0.02em] hover:bg-transparent"
          onClick={onOpenWorkspace}
          variant="ghost"
        >
          <span
            aria-hidden="true"
            className="text-ui-code inline-flex items-center font-mono font-medium leading-none text-muted-foreground"
          >
            [<span className="text-primary">▮</span>]
          </span>
          <span className="hidden whitespace-nowrap min-[390px]:inline">Agent Harness</span>
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Button
          aria-disabled={onOpenOrganizationMenu ? undefined : true}
          aria-haspopup={onOpenOrganizationMenu ? "menu" : undefined}
          aria-label={`Organization: ${organization}`}
          className={cn(
            "text-ui-control h-7 min-w-0 justify-start gap-2 border-border bg-card/35 px-2 shadow-none hover:bg-accent",
            "max-sm:max-w-12 sm:max-w-[280px]",
          )}
          onClick={onOpenOrganizationMenu}
          tabIndex={onOpenOrganizationMenu ? undefined : -1}
          variant="outline"
        >
          <span className="text-ui-micro grid size-5 shrink-0 place-items-center rounded-[4px] bg-human/15 font-mono font-semibold text-human">
            {organizationInitials}
          </span>
          <span className="hidden min-w-0 truncate font-medium sm:inline">{organization}</span>
          <span className="text-ui-micro hidden shrink-0 rounded-[4px] border border-border px-1.5 py-0.5 font-mono uppercase tracking-[0.16em] text-muted-foreground lg:inline">
            Org
          </span>
          <ChevronDown className="hidden size-3 shrink-0 text-muted-foreground sm:block" />
        </Button>

        <span aria-hidden="true" className="text-ui-code hidden font-mono text-muted-foreground md:inline">/</span>

        <button className="hidden h-7 min-w-0 items-center gap-2 rounded-[5px] border border-transparent px-2 text-left hover:bg-accent md:flex" onClick={onOpenWorkspace} type="button">
          <PanelTop aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-ui-control max-w-40 truncate font-semibold lg:max-w-56">
            {project.name}
          </span>
          {project.branch ? (
            <span className="text-ui-meta hidden max-w-48 truncate font-mono text-muted-foreground xl:inline">
              {project.branch}
            </span>
          ) : null}
        </button>

        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          <Button
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Search or run command"
            className="h-7 w-7 justify-start gap-2 border-border bg-card/20 px-2 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground sm:w-[200px]"
            onClick={onOpenCommandPalette}
            variant="outline"
          >
            <Search aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="text-ui-control hidden truncate text-left font-normal sm:inline">
              Search or run command
            </span>
            <kbd className="text-ui-micro ml-auto hidden shrink-0 rounded-[4px] border border-border px-1 py-0.5 font-mono font-normal text-muted-foreground lg:inline">
              ⌘K
            </kbd>
          </Button>

          <Button
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={theme === "light"}
            className="size-7 border-border bg-card/20 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            onClick={onToggleTheme}
            size="icon-sm"
            variant="outline"
          >
            <Sun aria-hidden="true" className="size-3.5" />
          </Button>

          <div className="flex h-11 items-center gap-1.5 border-l border-border pl-2.5">
            <span className="text-ui-micro hidden rounded-[4px] border border-human/25 bg-human/10 px-2 py-1 font-mono font-semibold tracking-[0.18em] text-human lg:inline">
              {roleLabel}
            </span>

            {onOpenAccountMenu ? (
              <Button
                aria-haspopup="menu"
                aria-label={`${dashboard.user.displayName} account`}
                className="text-ui-micro size-7 rounded-full border-border bg-card/45 font-mono text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                onClick={onOpenAccountMenu}
                size="icon-sm"
                variant="outline"
              >
                {accountInitials}
              </Button>
            ) : (
              <span
                aria-label={`${dashboard.user.displayName} account`}
                className="text-ui-micro grid size-7 place-items-center rounded-full border border-border bg-card/45 font-mono text-muted-foreground"
                role="img"
                title={`${dashboard.user.displayName} · ${roleLabel}`}
              >
                {accountInitials}
              </span>
            )}
          </div>
        </div>
      </div>

      <Button
        aria-label="Open sidebar"
        className="absolute left-1 top-1.5 min-[900px]:hidden"
        onClick={onOpenSidebar}
        size="icon-sm"
        variant="ghost"
      >
        <Menu aria-hidden="true" className="size-4" />
      </Button>
    </header>
  );
}
