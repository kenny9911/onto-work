import { cn } from "@/lib/utils";

/**
 * How much of a surface is actually backed by the control plane.
 *
 * This is the binding design vocabulary: a destination is only built when its
 * underlying state is truthful, and anything else is labelled rather than
 * filled with plausible-looking data. `FUTURE` means the screen is deliberately
 * inert — it explains what it would show and why it cannot show it yet.
 */
export type Availability = "LIVE" | "READ-ONLY" | "FUTURE";

const availabilityStyles: Record<Availability, string> = {
  LIVE: "border-primary/20 bg-primary/[0.08] text-primary",
  "READ-ONLY": "border-cyan-400/20 bg-cyan-400/[0.07] text-cyan-300",
  FUTURE: "border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.07] text-[var(--waiting)]",
};

export function AvailabilityBadge({ state }: { state: Availability }) {
  return (
    <span
      className={cn(
        "text-ui-micro inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono font-medium tracking-[0.12em]",
        availabilityStyles[state],
      )}
    >
      {state}
    </span>
  );
}

/**
 * A panel that names what it would contain and why that data does not exist
 * yet. Used instead of rendering an empty table or invented rows.
 */
export function UnavailablePanel({
  title,
  reason,
  children,
}: {
  title: string;
  reason: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-dashed border-border bg-card/25 p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-ui-control font-medium">{title}</h3>
        <AvailabilityBadge state="FUTURE" />
      </div>
      <p className="text-ui-body mt-2 text-muted-foreground">{reason}</p>
      {children}
    </section>
  );
}
