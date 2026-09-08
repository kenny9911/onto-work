import "./management.css";
import { useEffect, useRef } from "react";
import { ArrowUpRight, FileStack } from "lucide-react";
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
      <header className="management-header">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className="management-heading"
              ref={headingRef}
              tabIndex={-1}
            >
              Artifacts
            </h1>
            <AvailabilityBadge state="FUTURE" />
          </div>
          <p className="management-subtitle">
            Documents and deliverables created through your work.
          </p>
        </div>
      </header>

      <div
        aria-label="Artifacts content"
        className="management-scroll grid place-items-center"
        role="region"
        tabIndex={0}
      >
        <div className="management-empty w-full max-w-[600px]">
          <span className="mb-6 grid size-16 place-items-center rounded-2xl bg-muted">
            <FileStack aria-hidden="true" className="size-7 text-foreground" strokeWidth={1.4} />
          </span>
          <h2 className="text-ui-title font-semibold">Your deliverables will have a home here</h2>
          <p className="text-ui-body mt-3 max-w-md text-muted-foreground">
            The artifact library is not available yet. You can find files and
            changes in the task where they were created.
          </p>
          <Button className="mt-7" onClick={onOpenWorkspace} variant="outline">
            Open task
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
