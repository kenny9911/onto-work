import { useEffect, useState } from "react";
import { Activity, Check, Circle, LoaderCircle, ShieldAlert, Square } from "lucide-react";
import type { ThreadSummary, TimelineItem } from "@agent-harness/contracts";
import { Button } from "@/components/ui/button";
import { itemPlan } from "@/lib/task-progress";
import type { RuntimeStreamState } from "@/lib/runtime-stream";

export function TaskProgress({ thread, turnId, timeline, agents, stream, onRefresh, onStop, stopping }: {
  thread: ThreadSummary | null; turnId: string | null; timeline: TimelineItem[]; agents: ThreadSummary[];
  stream: RuntimeStreamState; onRefresh: () => void; onStop: () => Promise<void>; stopping: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const current = turnId ? timeline.filter((item) => item.metadata?.turnId === turnId) : timeline;
  const pending = timeline.findLast((item) => item.kind === "approval" && item.status === "pending");
  const unavailable = timeline.findLast((item) => item.kind === "approval" && item.status === "failed"
    && (!turnId || !item.metadata?.turnId || item.metadata.turnId === turnId));
  const activity = current.filter((item) => !["user", "assistant", "approval"].includes(item.kind) && !item.metadata?.plan && !item.id.startsWith("turn-") && !item.id.startsWith("live-overflow-"));
  const plan = itemPlan(current.findLast((item) => item.metadata?.plan));
  const completed = plan.filter((step) => step.status === "completed").length;
  const lastAt = Math.max(0, ...current.map((item) => Date.parse(item.timestamp) || 0));
  const age = lastAt ? Math.max(0, Math.floor((now - lastAt) / 1_000)) : null;
  const disconnected = stream.status === "offline" || stream.status === "reconnecting";
  const quiet = Boolean(turnId) && age !== null && age >= 60;
  const status = pending ? "Waiting for approval" : unavailable && turnId ? "Approval needs attention" : disconnected && turnId ? "Connection interrupted" : thread?.status === "waiting" ? "Waiting for input" : turnId ? "Running" : thread?.status === "failed" ? "Failed" : "Ready";
  const working = Boolean(turnId) && !pending && !unavailable && !disconnected;
  return (
    <section aria-label="Agent status and execution progress" className="rounded-2xl border border-border bg-card p-4 text-foreground sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent status</p>
          <h2 className="mt-2 flex items-center gap-2 text-sm font-medium">
            {pending || unavailable ? <ShieldAlert className="size-4" /> : working ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : <Activity className="size-4" />}
            <span role="status">{status}</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{thread?.agentNickname || "Onto"} · {thread?.model || "Agent"}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={onRefresh} size="sm" variant="outline">Refresh status</Button>
          {turnId ? <Button disabled={stopping} onClick={() => void onStop()} size="sm" variant="outline"><Square className="size-3" />{stopping ? "Stopping…" : "Stop run"}</Button> : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {pending ? "Choose a decision on the approval card to continue."
          : unavailable && turnId ? "This approval could not be completed. Refresh its status, or stop the run and continue the task."
          : disconnected && turnId ? "Live updates are unavailable. Refresh status to check the agent."
          : quiet ? "No new execution activity for over a minute. The agent may be waiting on a tool or model; refresh status or stop the run if needed."
          : turnId ? activity.findLast((item) => item.status === "running")?.title || "Waiting for the next execution event."
          : "This turn is no longer running. You can continue the task below."}
      </p>
      <div className="mt-4 border-t border-border pt-4">
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><h3 className="font-medium text-foreground">Execution timeline</h3><span>{age === null ? "Activity time unavailable" : `Last activity ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago`}</span></div>
        {plan.length ? <div className="mt-3">
          {!turnId ? <p className="mb-1 text-xs text-muted-foreground">Last reported plan</p> : null}
          <p className="text-xs text-muted-foreground">{completed} of {plan.length} plan steps complete</p>
          <progress aria-label="Plan steps complete" className="mt-2 h-1.5 w-full accent-primary" max={plan.length} value={completed} />
          <ol className="mt-2 space-y-2">{plan.map((step, index) => <li className="flex items-start gap-2 text-sm" key={`${index}-${step.step}`}>
            {step.status === "completed" ? <Check className="mt-0.5 size-3.5 shrink-0" /> : step.status === "inProgress" && turnId ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
            <span>{step.step}<span className="sr-only"> — {step.status}</span></span>
          </li>)}</ol>
        </div> : <p className="mt-2 text-xs text-muted-foreground">{activity.filter((item) => item.status === "completed").length} execution events completed · {activity.filter((item) => item.status === "running").length} active</p>}
        {activity.length ? <ol aria-label="Recent execution events" className="mt-3 space-y-2">{activity.slice(-4).map((item) => <li className="flex items-start justify-between gap-3 text-xs" key={item.id}><span className="min-w-0 truncate" title={item.title}>{item.title}</span><span className="shrink-0 text-muted-foreground">{item.status || "reported"}</span></li>)}</ol> : null}
      </div>
      {agents.length ? <div className="mt-4 border-t border-border pt-3"><h3 className="text-xs font-medium">Related agents</h3><ul className="mt-2 space-y-2">{agents.map((agent) => <li className="flex justify-between gap-2 text-xs" key={agent.id}><span className="truncate">{agent.agentNickname || agent.title}</span><span>{agent.status}</span></li>)}</ul></div> : null}
    </section>
  );
}
