import type { ThreadSummary, UserRole } from "@agent-harness/contracts";
import {
  Blocks,
  Boxes,
  CircleDollarSign,
  FileCheck2,
  FileStack,
  FolderGit2,
  Gauge,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AppView } from "@/lib/view";

interface CommandPaletteProps {
  open: boolean;
  role: UserRole;
  threads: ThreadSummary[];
  onNavigate: (view: AppView) => void;
  onNewTask: () => void;
  onOpenChange: (open: boolean) => void;
  onSelectThread: (threadId: string) => void;
}

export function CommandPalette({
  open,
  role,
  threads,
  onNavigate,
  onNewTask,
  onOpenChange,
  onSelectThread,
}: CommandPaletteProps) {
  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="top-[18%] max-w-[620px] translate-y-0 overflow-hidden border-border bg-[#15191f] p-0 shadow-2xl sm:rounded-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search tasks or navigate to an existing Agent Harness view.
        </DialogDescription>
        <Command className="rounded-xl bg-transparent">
          <CommandInput
            aria-label="Search commands and tasks"
            className="h-12"
            placeholder="Search tasks and commands…"
          />
          <CommandList className="max-h-[min(430px,62vh)] p-2">
            <CommandEmpty>No matching task or command.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem onSelect={() => run(onNewTask)} value="new task create">
                <Plus />
                Start a new task
                <CommandShortcut>⌘N</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Work">
              <CommandItem onSelect={() => run(() => onNavigate("workspace"))} value="workspace task cockpit">
                <LayoutDashboard />
                Task cockpit
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("projects"))} value="projects repositories worktrees">
                <FolderGit2 />
                Projects
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("reviews"))} value="reviews completed failed idle task evidence">
                <FileCheck2 />
                Reviews
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("artifacts"))} value="artifacts deliverables outputs">
                <FileStack />
                Artifacts
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Operate">
              <CommandItem onSelect={() => run(() => onNavigate("agents"))} value="agents supervision child tasks branches">
                <Workflow />
                Agents
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("providers"))} value="model routes providers">
                <Boxes />
                Model routes
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("environments"))} value="environments runtime projects effective policy">
                <ServerCog />
                Environments
              </CommandItem>
              <CommandItem onSelect={() => run(() => onNavigate("capabilities"))} value="capabilities mcp tools skills inventory">
                <Blocks />
                Capabilities
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Manage">
              <CommandItem onSelect={() => run(() => onNavigate("usage"))} value="usage quota tokens concurrency seats">
                <Gauge />
                Usage
              </CommandItem>
              {role === "admin" ? (
                <>
                  <CommandItem onSelect={() => run(() => onNavigate("team"))} value="team members access">
                    <Users />
                    Team
                  </CommandItem>
                  <CommandItem onSelect={() => run(() => onNavigate("billing"))} value="plan subscription billing">
                    <CircleDollarSign />
                    Billing
                  </CommandItem>
                  <CommandItem onSelect={() => run(() => onNavigate("audit"))} value="audit events governance">
                    <ScrollText />
                    Audit log
                  </CommandItem>
                  <CommandItem onSelect={() => run(() => onNavigate("platform"))} value="platform admin organizations tenants runtime fleet">
                    <ShieldCheck />
                    Platform admin
                  </CommandItem>
                </>
              ) : null}
            </CommandGroup>
            {threads.length ? (
              <>
                <CommandSeparator className="my-1" />
                <CommandGroup heading="Recent tasks">
                  {threads.map((thread) => (
                    <CommandItem
                      key={thread.id}
                      onSelect={() => run(() => onSelectThread(thread.id))}
                      value={`${thread.title} ${thread.preview} ${thread.projectName ?? ""}`}
                    >
                      <MessageSquareText />
                      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                      <span className="text-ui-micro shrink-0 font-mono capitalize text-muted-foreground">
                        {thread.status}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
          <div className="text-ui-meta flex items-center justify-between border-t border-border/80 px-3 py-2 font-mono text-muted-foreground">
            <span>↑↓ navigate · ↵ open</span>
            <span>disabled items explain why · nothing is hidden</span>
            <span>Esc close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
