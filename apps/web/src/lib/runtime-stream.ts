/**
 * Liveness of the authenticated runtime event stream (`GET /api/codex/events`).
 *
 * `EventSource` reconnects on its own, so a dropped connection is reported
 * rather than treated as a failure: completed events stay on the server and the
 * run continues without this tab. `offline` is the exception — the browser has
 * stopped retrying and only a manual retry recovers.
 */
export interface RuntimeStreamState {
  status: "idle" | "connecting" | "live" | "reconnecting" | "offline";
  /** Consecutive failed connection attempts since the last successful open. */
  attempt: number;
  /**
   * When the last runtime event arrived, captured only as the stream drops.
   * Recording it per message would re-render the shell on every streamed token.
   */
  lastEventAt: number | null;
}

export const idleRuntimeStream: RuntimeStreamState = {
  status: "idle",
  attempt: 0,
  lastEventAt: null,
};

/** Short status word for the composer's runtime chip. */
export function runtimeStreamLabel(status: RuntimeStreamState["status"]): string {
  switch (status) {
    case "live":
      return "connected";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "offline":
      return "disconnected";
    default:
      return "not connected";
  }
}

/** Compact age used by the reconnecting banner. */
export function eventAge(lastEventAt: number | null, now: number): string | null {
  if (lastEventAt === null) return null;
  const seconds = Math.max(0, Math.round((now - lastEventAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
