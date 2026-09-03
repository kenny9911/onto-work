import {
  Component,
  Suspense,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

const DEFAULT_PENDING_TIMEOUT_MS = 10_000;

export interface RouteLoadingBoundaryProps {
  children: ReactNode;
  onReload?: () => void;
  resetKey?: string | number;
  timeoutMs?: number;
}

interface RouteErrorBoundaryProps {
  children: ReactNode;
  onReload: () => void;
}

interface RouteErrorBoundaryState {
  failed: boolean;
}

function reloadWindow() {
  if (typeof window !== "undefined") window.location.reload();
}

function RouteLoadSurface({
  description,
  heading,
  onReload,
  role,
}: {
  description: string;
  heading: string;
  onReload: () => void;
  role: "alert" | "status";
}) {
  const descriptionId = useId();
  const headingId = useId();

  return (
    <main className="grid min-w-0 flex-1 place-items-center bg-background px-6">
      <section
        aria-describedby={descriptionId}
        aria-labelledby={headingId}
        aria-live={role === "alert" ? "assertive" : "polite"}
        className="flex max-w-sm flex-col items-center text-center"
        role={role}
      >
        {role === "alert" ? (
          <TriangleAlert aria-hidden="true" className="mb-3 size-5 text-destructive" />
        ) : (
          <LoaderCircle aria-hidden="true" className="mb-3 size-5 animate-spin text-muted-foreground" />
        )}
        <h2 className="text-ui-title font-medium tracking-[-0.02em]" id={headingId}>
          {heading}
        </h2>
        <p className="text-ui-body mt-1.5 text-muted-foreground" id={descriptionId}>
          {description}
        </p>
        <Button className="mt-4" onClick={onReload} size="sm" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          Reload interface
        </Button>
      </section>
    </main>
  );
}

function RouteLoadingFallback({
  onReload,
  timeoutMs,
}: {
  onReload: () => void;
  timeoutMs: number;
}) {
  const [isTakingLonger, setIsTakingLonger] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setIsTakingLonger(true),
      Math.max(0, timeoutMs),
    );
    return () => window.clearTimeout(timer);
  }, [timeoutMs]);

  if (isTakingLonger) {
    return (
      <RouteLoadSurface
        description="The rest of your task has not loaded yet. Reloading can recover a stalled connection."
        heading="Interface is taking longer than expected"
        onReload={onReload}
        role="status"
      />
    );
  }

  return (
    <main className="grid min-w-0 flex-1 place-items-center bg-background">
      <div
        aria-label="Loading interface"
        aria-live="polite"
        className="text-ui-control flex items-center gap-2 text-muted-foreground"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        Loading interface
      </div>
    </main>
  );
}

class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <RouteLoadSurface
          description="The task interface could not be opened. Reload to try again."
          heading="Interface failed to load"
          onReload={this.props.onReload}
          role="alert"
        />
      );
    }

    return this.props.children;
  }
}

/**
 * Keeps route-level code splitting recoverable: a normal loading indicator is
 * shown first, slow loads gain a reload action, and rejected lazy imports are
 * converted into an actionable error instead of a blank workspace.
 */
export function RouteLoadingBoundary({
  children,
  onReload = reloadWindow,
  resetKey,
  timeoutMs = DEFAULT_PENDING_TIMEOUT_MS,
}: RouteLoadingBoundaryProps) {
  return (
    <RouteErrorBoundary key={resetKey} onReload={onReload}>
      <Suspense
        fallback={<RouteLoadingFallback onReload={onReload} timeoutMs={timeoutMs} />}
      >
        {children}
      </Suspense>
    </RouteErrorBoundary>
  );
}
