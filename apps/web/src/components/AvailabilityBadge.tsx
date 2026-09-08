import "./management.css";

/**
 * How much of a surface is actually backed by the control plane.
 *
 * This is the binding design vocabulary: a destination is only built when its
 * underlying state is truthful, and anything else is labelled rather than
 * filled with plausible-looking data. `FUTURE` means the screen is deliberately
 * inert — it explains what it would show and why it cannot show it yet.
 */
export type Availability = "LIVE" | "READ-ONLY" | "FUTURE";

const availabilityLabels: Record<Availability, string> = {
  LIVE: "Live",
  "READ-ONLY": "Read only",
  FUTURE: "Not available",
};

export function AvailabilityBadge({ state }: { state: Availability }) {
  return (
    <span
      className="management-availability"
      data-availability={state}
    >
      {availabilityLabels[state]}
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
    <section className="management-unavailable">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-ui-control font-medium">{title}</h3>
        <AvailabilityBadge state="FUTURE" />
      </div>
      <p className="text-ui-body mt-2 text-muted-foreground">{reason}</p>
      {children}
    </section>
  );
}
