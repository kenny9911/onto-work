import { useEffect, useRef } from "react";
import { FileStack } from "lucide-react";
import { AvailabilityBadge } from "@/components/AvailabilityBadge";
import { Button } from "@/components/ui/button";

/**
 * Artifacts — files an agent writes as a deliverable rather than a source
 * change.
 *
 * Codex reports file changes, but nothing distinguishes a deliverable from an
 * edit, and the control plane stores no artifact catalog, retention policy or
 * ownership binding. Rather than relabel every file change as an artifact, this
 * destination stays empty and says what would populate it.
 */
export function ArtifactsView({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1
              className="text-lg font-medium tracking-[-0.025em]"
              ref={headingRef}
              tabIndex={-1}
            >
              Artifacts
            </h1>
            <AvailabilityBadge state="FUTURE" />
          </div>
          <p className="text-ui-body mt-0.5 line-clamp-2 text-muted-foreground sm:truncate">
            Deliverables produced by a run, separate from the source changes in a
            task diff.
          </p>
        </div>
      </header>

      <div
        aria-label="Artifacts content"
        className="grid min-h-0 flex-1 place-items-center overflow-y-auto overscroll-contain p-6 sm:p-10"
        role="region"
        tabIndex={0}
      >
        <div className="max-w-[420px] text-center">
          <FileStack
            aria-hidden="true"
            className="mx-auto mb-3 size-8 text-[var(--ink-4)]"
            strokeWidth={1.2}
          />
          <p className="text-ui-title font-semibold">No artifacts in this project yet</p>
          <p className="text-ui-body mt-2 text-muted-foreground">
            Artifacts appear here when an agent writes a file that is a
            deliverable rather than a source change — a design note, a benchmark,
            a generated migration. Nothing is created for you in advance.
          </p>
          <p className="text-ui-meta mt-3 text-[var(--ink-4)]">
            The runtime does not yet mark a file change as a deliverable, so this
            list stays empty instead of repeating the task diff.
          </p>
          <Button className="mt-4" onClick={onOpenWorkspace} size="sm" variant="outline">
            Open the running task
          </Button>
        </div>
      </div>
    </>
  );
}
