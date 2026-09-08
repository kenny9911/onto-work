import "./management.css";
import { useEffect, useRef } from "react";
import type { DashboardPayload } from "@agent-harness/contracts";
import { ShieldCheck } from "lucide-react";
import {
  AvailabilityBadge,
  UnavailablePanel,
} from "@/components/AvailabilityBadge";
import { Button } from "@/components/ui/button";
import type { AppView } from "@/lib/view";

/**
 * Platform scope — organizations, runtime fleet and feature flags across every
 * tenant.
 *
 * The control plane has no platform-administration boundary yet: roles are
 * `admin`/`member` within a single tenant, there is no cross-tenant read API,
 * no fleet beyond the one supervised host, and no break-glass grant record. So
 * this destination is deliberately inert. It states what platform scope will
 * own and what the deployment can honestly report today, and it renders no
 * organization rows at all rather than inventing a tenant table.
 */
export function PlatformView({
  dashboard,
  onNavigate,
}: {
  dashboard: DashboardPayload;
  onNavigate: (view: AppView) => void;
}) {
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
              Platform admin
            </h1>
            <AvailabilityBadge state="FUTURE" />
          </div>
          <p className="management-subtitle">
            Organization-wide administration and runtime oversight.
          </p>
        </div>
      </header>

      <div
        aria-label="Platform admin content"
        className="management-scroll"
        role="region"
        tabIndex={0}
      >
        <div className="management-content space-y-8">
        <section
          className="management-panel flex items-start gap-4"
          role="note"
        >
          <span className="management-icon">
            <ShieldCheck aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-body font-semibold">Platform administration is not available yet</h2>
            <p className="text-ui-body mt-2 max-w-3xl text-muted-foreground">
              Your administrator access covers this workspace. Manage your team
              and view runtime information below.
            </p>
          </div>
        </section>

        <div className="grid gap-8 xl:grid-cols-2">
          <UnavailablePanel
            reason="A view across organizations is not available. You can manage members and access for your current workspace."
            title="Organizations"
          >
            <Button
              className="mt-5"
              onClick={() => onNavigate("team")}
              size="sm"
              variant="outline"
            >
              Manage workspace team
            </Button>
          </UnavailablePanel>

          <div className="space-y-6">
            {/* Runtime facts the control plane genuinely reports, kept separate
                from the fleet view this screen cannot yet provide. */}
            <section className="management-panel">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-ui-control font-medium">Runtime and jobs</h3>
                <AvailabilityBadge state="READ-ONLY" />
              </div>
              <dl className="mt-5 space-y-4">
                <div className="flex items-center gap-3 border-b border-border pb-4">
                  <dt className="text-ui-control text-muted-foreground">Runtime status</dt>
                  <dd className="text-ui-control ml-auto tabular-nums">{dashboard.runtime.status}</dd>
                </div>
                <div className="flex items-center gap-3 border-b border-border pb-4">
                  <dt className="text-ui-control text-muted-foreground">Supervised app-servers</dt>
                  <dd className="text-ui-control ml-auto tabular-nums">{dashboard.runtime.activeRuntimes}</dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="text-ui-control text-muted-foreground">Active runs</dt>
                  <dd className="text-ui-control ml-auto tabular-nums">
                    {dashboard.usage.activeRuns} / {dashboard.usage.activeRunLimit}
                  </dd>
                </div>
              </dl>
              <p className="text-ui-control mt-5 text-muted-foreground">
                These figures describe the runtime on this host. A view across
                multiple hosts is not available.
              </p>
            </section>

            <UnavailablePanel
              reason="Runtime configuration is managed by the server operator. Feature flags cannot be changed from this workspace."
              title="Feature flags"
            />
          </div>
        </div>

        <UnavailablePanel
          reason="Temporary access to another organization's workspace is not supported. No access grants can be created here."
          title="Break-glass grants"
        />

        </div>
      </div>
    </>
  );
}
