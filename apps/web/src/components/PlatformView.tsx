import { useEffect, useRef } from "react";
import type { DashboardPayload } from "@agent-harness/contracts";
import { FileText, ShieldCheck } from "lucide-react";
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
      <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1
              className="text-lg font-medium tracking-[-0.025em]"
              ref={headingRef}
              tabIndex={-1}
            >
              Platform admin
            </h1>
            <AvailabilityBadge state="FUTURE" />
          </div>
          <p className="text-ui-body mt-0.5 line-clamp-2 text-muted-foreground sm:truncate">
            Cross-tenant scope. Not implemented — this deployment has no platform
            role separate from tenant administration.
          </p>
        </div>
      </header>

      <div
        aria-label="Platform admin content"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-7"
        role="region"
        tabIndex={0}
      >
        <section
          className="flex items-start gap-3 rounded-lg border border-human/40 bg-human/[0.08] p-4"
          role="note"
        >
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-human" />
          <div className="min-w-0">
            <p className="text-ui-micro font-mono uppercase tracking-[0.14em] text-human">
              Platform scope · all tenants
            </p>
            <p className="text-ui-body mt-1.5 text-[var(--ink-2)]">
              Actions here would affect every organization, so they stay behind a
              boundary that does not exist yet. Today an{" "}
              <code className="font-mono text-[var(--ink-1)]">admin</code> is an
              administrator <em>of one tenant</em>; there is no separate platform
              role, session surface, or audited break-glass grant. Building this
              screen against tenant-admin authority would misrepresent who can
              see what.
            </p>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <UnavailablePanel
            reason="Listing organizations, plans, seats and entitlement snapshots across tenants needs a cross-tenant read API and a platform-administration boundary. Neither exists, and no row is shown rather than presenting this tenant as if it were the whole platform."
            title="Organizations"
          >
            <Button
              className="mt-3"
              onClick={() => onNavigate("team")}
              size="sm"
              variant="outline"
            >
              Open team and access for this tenant
            </Button>
          </UnavailablePanel>

          <div className="space-y-4">
            {/* Runtime facts the control plane genuinely reports, kept separate
                from the fleet view this screen cannot yet provide. */}
            <section className="rounded-lg border border-border bg-card/25 p-4">
              <div className="flex items-center gap-2">
                <h3 className="text-ui-control font-medium">Runtime and jobs</h3>
                <AvailabilityBadge state="READ-ONLY" />
              </div>
              <dl className="mt-3 space-y-2">
                <div className="flex items-center gap-3 border-b border-border pb-2">
                  <dt className="text-ui-control text-muted-foreground">Runtime status</dt>
                  <dd className="text-ui-code ml-auto font-mono">{dashboard.runtime.status}</dd>
                </div>
                <div className="flex items-center gap-3 border-b border-border pb-2">
                  <dt className="text-ui-control text-muted-foreground">Supervised app-servers</dt>
                  <dd className="text-ui-code ml-auto font-mono">{dashboard.runtime.activeRuntimes}</dd>
                </div>
                <div className="flex items-center gap-3">
                  <dt className="text-ui-control text-muted-foreground">Active runs</dt>
                  <dd className="text-ui-code ml-auto font-mono">
                    {dashboard.usage.activeRuns} / {dashboard.usage.activeRunLimit}
                  </dd>
                </div>
              </dl>
              <p className="text-ui-meta mt-3 text-muted-foreground">
                One host, one supervised process group. This is a local process
                manager, not a fleet — capacity is a single number and it is
                honest about that.
              </p>
            </section>

            <UnavailablePanel
              reason="Feature flags would need a platform-owned configuration store and a rollout audit trail. The deployment's only runtime switches are operator environment variables, which are intentionally not writable from a browser."
              title="Feature flags"
            />
          </div>
        </div>

        <UnavailablePanel
          reason="A time-limited, dual-approved grant that lets a platform administrator read into a tenant, written to both the platform and tenant audit logs. This requires the platform role boundary above, so no grant can be issued or displayed."
          title="Break-glass grants"
        />

        <p className="text-ui-meta flex items-center gap-2 text-muted-foreground">
          <FileText aria-hidden="true" className="size-3.5 shrink-0" />
          Scope and exit criteria are tracked in ADR-0001 and the threat model.
        </p>
      </div>
    </>
  );
}
