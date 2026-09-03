import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PROVIDER_CATALOG,
  type AuditEventSummary,
  type DashboardPayload,
  type PlanId,
  type ProviderCatalogItem,
  type SavedProjectSummary,
  type UserRole,
  type UserStatus,
  type UserSummary,
} from "@agent-harness/contracts";
import {
  ArrowUpRight,
  Activity,
  Boxes,
  Check,
  CircleAlert,
  CircleGauge,
  CloudCog,
  CreditCard,
  FolderGit2,
  Gauge,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  ServerCog,
  ShieldCheck,
  Users,
} from "lucide-react";
import { UnavailablePanel } from "@/components/AvailabilityBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AppView } from "@/lib/view";

type ControlPlaneViewId = Extract<
  AppView,
  "projects" | "providers" | "team" | "usage" | "billing" | "audit"
>;

interface ControlPlaneViewProps {
  view: ControlPlaneViewId;
  dashboard: DashboardPayload;
  onOpenSidebar: () => void;
  onProjectsChanged?: (change: SavedProjectCacheChange) => Promise<void> | void;
  onRefresh: () => Promise<void>;
}

export type SavedProjectCacheChange =
  | { type: "upsert"; project: SavedProjectSummary }
  | { type: "refresh" };

const titles: Record<ControlPlaneViewId, { title: string; subtitle: string }> = {
  projects: {
    title: "Projects",
    subtitle: "Saved workspace registry, repository state, and runtime task activity.",
  },
  providers: {
    title: "Model routes",
    subtitle: "Connect Responses-compatible endpoints or use the operator-managed LiteLLM gateway.",
  },
  team: {
    title: "Team",
    subtitle: "Manage workspace access without sharing runtime state or provider credentials.",
  },
  usage: {
    title: "Usage",
    subtitle: "Server-metered requests, concurrency, seats, and Codex token events.",
  },
  billing: {
    title: "Billing",
    subtitle: "Review server-issued entitlements and open Stripe billing when configured.",
  },
  audit: {
    title: "Audit log",
    subtitle: "Tenant-scoped control-plane, approval, provider, member, and billing events.",
  },
};

function PageHeader({
  view,
  action,
}: {
  view: ControlPlaneViewId;
  action?: React.ReactNode;
}) {
  const copy = titles[view];
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  return (
    <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-border px-4 py-4 sm:px-7">
      <div className="min-w-0 flex-1">
        <h1
          className="text-lg font-medium tracking-[-0.025em]"
          ref={headingRef}
          tabIndex={-1}
        >
          {copy.title}
        </h1>
        <p className="mt-0.5 truncate text-ui-control text-muted-foreground">{copy.subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function PageScrollRegion({
  view,
  children,
}: {
  view: ControlPlaneViewId;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-label={`${titles[view].title} content`}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-7"
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

function ProviderGlyph({ provider }: { provider: ProviderCatalogItem }) {
  const Icon = provider.local ? ServerCog : provider.family === "router" ? CloudCog : Boxes;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary/60">
      <Icon className="size-4 text-[#c8cdd3]" />
    </span>
  );
}

function AddProviderDialog({ onSaved }: { onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [catalogId, setCatalogId] = useState(PROVIDER_CATALOG[0]?.id ?? "openai");
  const selected = PROVIDER_CATALOG.find((item) => item.id === catalogId) ?? PROVIDER_CATALOG[0]!;
  const [name, setName] = useState(selected.name);
  const [baseUrl, setBaseUrl] = useState(selected.defaultBaseUrl ?? "");
  const [model, setModel] = useState(selected.defaultModel ?? "");
  const [apiKey, setApiKey] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const apiKeyInputId = `provider-api-key-${selected.id}`;

  function selectProvider(nextId: string) {
    const next = PROVIDER_CATALOG.find((item) => item.id === nextId);
    if (!next) return;
    setCatalogId(next.id);
    setName(next.name);
    setBaseUrl(next.defaultBaseUrl ?? "");
    setModel(next.defaultModel ?? "");
    setApiKey("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.saveProvider({
        catalogId,
        name,
        baseUrl: selected.adapter === "litellm" ? undefined : baseUrl || null,
        defaultModel: model || null,
        apiKey: apiKey || undefined,
        enabled: true,
        isDefault,
      });
      await onSaved();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save model route");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="gap-2" size="sm"><Plus className="size-3.5" /> Add route</Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-[#191c21] sm:max-w-[520px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a model route</DialogTitle>
            <DialogDescription>
              Secrets are encrypted by the control plane. Gateway-backed providers use the LiteLLM endpoint fixed by the server operator.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-5">
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Provider
              <Select onValueChange={selectProvider} value={catalogId}>
                <SelectTrigger className="h-10 bg-background/40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_CATALOG.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div className="rounded-md border border-border/80 bg-background/25 px-3 py-2.5 text-ui-body text-muted-foreground">
              <span className="font-medium text-foreground">{selected.nativeCodex ? "Native route." : "Gateway route."}</span>{" "}
              {selected.description}
            </div>

            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Display name
              <Input className="h-10 bg-background/40" onChange={(event) => setName(event.target.value)} required value={name} />
            </label>

            {selected.adapter === "litellm" ? (
              <div
                aria-label="LiteLLM endpoint policy"
                className="rounded-md border border-human/20 bg-human/[0.045] px-3 py-2.5"
                role="note"
              >
                <p className="text-ui-control font-medium text-foreground">Operator-managed LiteLLM endpoint</p>
                <p className="mt-1 text-ui-body text-muted-foreground">
                  This tenant selects a model alias and optional scoped token. The gateway URL cannot be changed in the browser.
                </p>
              </div>
            ) : (
              <label className="grid gap-2 text-ui-control text-muted-foreground">
                Endpoint
                <Input
                  aria-describedby="provider-endpoint-policy"
                  className="h-10 bg-background/40 font-mono text-ui-code"
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={selected.local ? "http://127.0.0.1:11434/v1" : "https://…/v1"}
                  required
                  type="url"
                  value={baseUrl}
                />
                <span className="text-ui-body" id="provider-endpoint-policy">
                  {selected.local
                    ? "Local loopback endpoints are allowed for local providers."
                    : "Use HTTPS. Private-network endpoints require an explicit server-operator opt-in."}
                </span>
              </label>
            )}

            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Default model
              <Input className="h-10 bg-background/40 font-mono text-ui-code" onChange={(event) => setModel(event.target.value)} value={model} />
            </label>

            {selected.keyLabel ? (
              <label
                className="grid gap-2 text-ui-control text-muted-foreground"
                htmlFor={apiKeyInputId}
              >
                {selected.keyLabel}
                {selected.adapter === "litellm" ? " (optional when the operator configured a shared credential)" : ""}
                <Input
                  autoComplete="off"
                  className="h-10 bg-background/40 font-mono text-ui-code"
                  id={apiKeyInputId}
                  key={selected.id}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={selected.adapter === "litellm" ? "Tenant-scoped gateway token" : "Stored encrypted"}
                  type="password"
                  value={apiKey}
                />
              </label>
            ) : null}

            <label className="flex items-center gap-2 text-ui-control text-muted-foreground">
              <input checked={isDefault} className="size-3.5 accent-[var(--primary)]" onChange={(event) => setIsDefault(event.target.checked)} type="checkbox" />
              Use as the default route for new tasks
            </label>

            {error ? <p role="alert" className="text-ui-body text-red-300">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={saving} type="submit">{saving ? "Saving…" : "Save route"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProvidersView({
  dashboard,
  onRefresh,
}: Omit<ControlPlaneViewProps, "view" | "onOpenSidebar">) {
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<{ id: string; message: string } | null>(null);
  const providerMutationRef = useRef<string | null>(null);
  const enabledProviders = dashboard.providers.filter((provider) => provider.enabled);
  const activeProvider = enabledProviders.find((provider) => provider.isDefault) ?? enabledProviders[0];

  async function toggleProvider(connection: DashboardPayload["providers"][number]) {
    if (dashboard.user.role !== "admin" || providerMutationRef.current) return;
    providerMutationRef.current = connection.id;
    setPendingProviderId(connection.id);
    setProviderError(null);
    try {
      await api.saveProvider({
        id: connection.id,
        catalogId: connection.catalogId,
        enabled: !connection.enabled,
        isDefault: connection.enabled && connection.isDefault ? false : connection.isDefault,
      });
      await onRefresh();
    } catch (cause) {
      setProviderError({
        id: connection.id,
        message: cause instanceof Error ? cause.message : "Could not update model route",
      });
    } finally {
      providerMutationRef.current = null;
      setPendingProviderId(null);
    }
  }

  return (
    <>
      <PageHeader action={dashboard.user.role === "admin" ? <AddProviderDialog onSaved={onRefresh} /> : undefined} view="providers" />
      <PageScrollRegion view="providers">
        <div className="mx-auto max-w-5xl">
          <section className="mb-8 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <p className="font-mono text-ui-micro uppercase tracking-[0.15em] text-muted-foreground">Enabled routes</p>
              <p className="mt-2 text-2xl font-medium tracking-tight">{enabledProviders.length}</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <p className="font-mono text-ui-micro uppercase tracking-[0.15em] text-muted-foreground">Active route</p>
              <p className="mt-2 truncate text-sm font-medium">{activeProvider?.name ?? "Not configured"}</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <p className="font-mono text-ui-micro uppercase tracking-[0.15em] text-muted-foreground">Credential boundary</p>
              <p className="mt-2 text-sm font-medium">Server-side encrypted</p>
            </div>
          </section>

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-ui-control font-medium">Provider catalog</h2>
            <span className="font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">Responses facade</span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {PROVIDER_CATALOG.map((provider) => {
              const connection = dashboard.providers.find((item) => item.catalogId === provider.id);
              const connectionStatus = !connection
                ? "Not configured"
                : connection.enabled
                  ? "Configured"
                  : "Disabled";
              return (
                <article className="rounded-lg border border-border bg-card/25 p-4" key={provider.id}>
                  <div className="flex items-start gap-3">
                    <ProviderGlyph provider={provider} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium">{provider.name}</h3>
                        <span className={cn("rounded-sm px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-wider", provider.nativeCodex ? "bg-emerald-500/10 text-emerald-300" : "bg-human/10 text-human")}>
                          {provider.nativeCodex ? "native" : "gateway"}
                        </span>
                        {connection?.isDefault ? <span className="ml-auto font-mono text-ui-micro uppercase tracking-wider text-primary">default</span> : null}
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-ui-body text-muted-foreground">{provider.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 border-t border-border/70 pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-ui-meta text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            connection?.enabled
                              ? "bg-emerald-400"
                              : connection
                                ? "bg-amber-400"
                                : "bg-[#555d67]",
                          )}
                        />
                        <span className="shrink-0">{connectionStatus}</span>
                        {connection?.defaultModel ? (
                          <span className="truncate">· {connection.defaultModel}</span>
                        ) : null}
                      </span>
                      {connection && dashboard.user.role === "admin" ? (
                        <Button
                          aria-label={`${connection.enabled ? "Disable" : "Enable"} ${provider.name} route`}
                          disabled={pendingProviderId !== null}
                          onClick={() => void toggleProvider(connection)}
                          size="sm"
                          variant="ghost"
                        >
                          {pendingProviderId === connection.id
                            ? "Updating…"
                            : connection.enabled
                              ? "Disable"
                              : "Enable"}
                        </Button>
                      ) : null}
                    </div>
                    {providerError && providerError.id === connection?.id ? (
                      <p className="mt-2 text-ui-body text-red-300" role="alert">
                        {providerError.message}
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>

          {/* Routing behaviour from the binding design. The control plane picks
              exactly one server-selected route per run and records it on the
              usage event; there is no fallback chain, no hop history and no
              synthetic request. Each panel says so rather than drawing an empty
              policy list or a zeroed chart. */}
          <div className="mt-8 grid gap-3 lg:grid-cols-2">
            <UnavailablePanel
              reason="Ordered fallback with per-hop timeouts and a capability floor. Admission resolves a single route before a run starts and refuses the run if that route is not entitled, so there is no second attempt to order. Adding a chain also needs the side-effect boundary below to be enforced server-side."
              title="Fallback policy"
            >
              <p className="text-ui-meta mt-3 rounded-md border border-human/40 bg-human/[0.06] p-3 text-[var(--ink-2)]">
                <span className="font-medium text-[var(--ink-1)]">Side-effect boundary.</span>{" "}
                When it exists, fallback must stop permanently once a turn has
                produced a non-idempotent effect: the turn fails with the reason
                instead of silently re-running on another provider.
              </p>
            </UnavailablePanel>

            <div className="space-y-3">
              <UnavailablePanel
                reason="Requests per hour, fallback-hop rate and error mix over 24h. Usage events record the route and model actually used, but they are aggregated per entitlement period only — there is no time-bucketed query, so no chart is drawn."
                title="Route analytics"
              />
              <UnavailablePanel
                reason="Sending a probe request through a route to see which hop answers. The server exposes no provider test endpoint, and issuing a real model call from this screen would consume tenant quota without a usage reservation."
                title="Test console"
              />
            </div>
          </div>
        </div>
      </PageScrollRegion>
    </>
  );
}

function AddUserDialog({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await api.createUser({ username, displayName, password, role });
      await onCreated();
      setOpen(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create user");
    }
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild><Button className="gap-2" size="sm"><Plus className="size-3.5" /> Add member</Button></DialogTrigger>
      <DialogContent className="border-border bg-[#191c21] sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Add a team member</DialogTitle>
            <DialogDescription>The member receives an isolated Codex home and must rotate this temporary password.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5">
            <label className="grid gap-2 text-ui-control text-muted-foreground">Display name<Input onChange={(event) => setDisplayName(event.target.value)} required value={displayName} /></label>
            <label className="grid gap-2 text-ui-control text-muted-foreground">Username<Input autoComplete="off" onChange={(event) => setUsername(event.target.value)} required value={username} /></label>
            <label className="grid gap-2 text-ui-control text-muted-foreground">Temporary password<Input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
            <label className="grid gap-2 text-ui-control text-muted-foreground">Role
              <Select onValueChange={(value) => setRole(value as UserRole)} value={role}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="member">Member</SelectItem><SelectItem value="admin">Admin</SelectItem></SelectContent>
              </Select>
            </label>
            {error ? <p role="alert" className="text-ui-body text-red-300">{error}</p> : null}
          </div>
          <DialogFooter><Button onClick={() => setOpen(false)} type="button" variant="ghost">Cancel</Button><Button type="submit">Create member</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TeamView({ dashboard }: Pick<ControlPlaneViewProps, "dashboard">) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const userMutationRef = useRef<string | null>(null);

  async function loadUsers() {
    setLoading(true);
    try {
      const result = await api.listUsers();
      setUsers(result.users);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  async function updateStatus(userId: string, status: UserStatus) {
    if (userMutationRef.current) return;
    userMutationRef.current = userId;
    setPendingUserId(userId);
    setError(null);
    try {
      await api.setUserStatus(userId, status);
      await loadUsers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update member status");
    } finally {
      userMutationRef.current = null;
      setPendingUserId(null);
    }
  }

  return (
    <>
      <PageHeader action={<AddUserDialog onCreated={loadUsers} />} view="team" />
      <PageScrollRegion view="team">
        <div className="mx-auto max-w-5xl">
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card/30 p-4"><Users className="size-4 text-primary" /><p className="mt-4 text-2xl font-medium">{users.length || "—"}</p><p className="mt-1 text-ui-control text-muted-foreground">Workspace members</p></div>
            <div className="rounded-lg border border-border bg-card/30 p-4"><ShieldCheck className="size-4 text-emerald-400" /><p className="mt-4 text-sm font-medium">Isolated runtimes</p><p className="mt-1 text-ui-control text-muted-foreground">One Codex home per user</p></div>
            <div className="rounded-lg border border-border bg-card/30 p-4"><KeyRound className="size-4 text-[#9aa3ad]" /><p className="mt-4 text-sm font-medium">Tenant-scoped keys</p><p className="mt-1 text-ui-control text-muted-foreground">Never returned to the browser</p></div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card/25">
            <div className="grid grid-cols-[1fr_110px_110px_80px] gap-3 border-b border-border px-4 py-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground">
              <span>Member</span><span>Role</span><span>Status</span><span />
            </div>
            {loading ? <p className="p-5 text-ui-body text-muted-foreground">Loading team…</p> : null}
            {error ? <p role="alert" className="p-5 text-ui-body text-red-300">{error}</p> : null}
            {users.map((member) => (
              <div className="grid grid-cols-[1fr_110px_110px_80px] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0" key={member.id}>
                <div className="flex min-w-0 items-center gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-ui-meta font-medium">{member.displayName.slice(0, 2).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-ui-control font-medium">{member.displayName}</span><span className="block truncate font-mono text-ui-meta text-muted-foreground">@{member.username}</span></span></div>
                <span className="text-ui-control capitalize text-muted-foreground">{member.role}</span>
                <span className="flex items-center gap-1.5 text-ui-control capitalize text-muted-foreground"><span aria-hidden="true" className={cn("size-1.5 rounded-full", member.status === "active" ? "bg-emerald-400" : "bg-red-400")} />{member.status}</span>
                {member.id !== dashboard.user.id ? <Button aria-label={`${member.status === "active" ? "Suspend" : "Restore"} ${member.displayName}`} disabled={loading || pendingUserId !== null} onClick={() => void updateStatus(member.id, member.status === "active" ? "suspended" : "active")} size="sm" variant="ghost">{pendingUserId === member.id ? "Updating…" : member.status === "active" ? "Suspend" : "Restore"}</Button> : <span className="text-right font-mono text-ui-micro text-muted-foreground">YOU</span>}
              </div>
            ))}
          </div>
        </div>
      </PageScrollRegion>
    </>
  );
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact" });
const auditTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function AddProjectDialog({
  onCreated,
}: {
  onCreated: (project: SavedProjectSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setDialogOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.registerProject({ name, workspacePath });
      onCreated(result.project);
      setOpen(false);
      setName("");
      setWorkspacePath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not register project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={setDialogOpen} open={open}>
      <DialogTrigger asChild>
        <Button className="gap-2" size="sm"><Plus className="size-3.5" /> Register project</Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-[#191c21] sm:max-w-[520px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Register an existing workspace</DialogTitle>
            <DialogDescription>
              The server resolves the canonical path and requires an active organization workspace grant before saving it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5">
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Project name
              <Input
                autoComplete="off"
                className="h-10 bg-background/40"
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agent Harness"
                required
                value={name}
              />
            </label>
            <div className="grid gap-2 text-ui-control text-muted-foreground">
              <label htmlFor="project-workspace-path">Existing workspace path</label>
              <Input
                aria-describedby="project-workspace-path-help"
                autoComplete="off"
                className="h-10 bg-background/40 font-mono text-ui-code"
                id="project-workspace-path"
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="/absolute/path/inside/an/allowed/root"
                required
                value={workspacePath}
              />
              <span className="text-ui-body" id="project-workspace-path-help">
                Registration does not create, clone, or move the directory.
              </span>
            </div>
            {error ? <p className="text-ui-body text-red-300" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={saving} type="submit">{saving ? "Registering…" : "Register project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSettingsDialog({
  project,
  onUpdated,
}: {
  project: SavedProjectSummary;
  onUpdated: (project: SavedProjectSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [enabled, setEnabled] = useState(project.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setDialogOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setName(project.name);
      setEnabled(project.enabled);
      setError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateProject(project.id, { name, enabled });
      onUpdated(result.project);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={setDialogOpen} open={open}>
      <DialogTrigger asChild>
        <Button aria-label={`Manage ${project.name}`} className="gap-1.5" size="sm" variant="ghost">
          <Pencil className="size-3" /> Manage
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-[#191c21] sm:max-w-[480px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Manage saved project</DialogTitle>
            <DialogDescription>
              Rename this registry entry or control whether it is available for new work. Its canonical path cannot be edited.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-5">
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Project name
              <Input
                className="h-10 bg-background/40"
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <div className="rounded-md border border-border/80 bg-background/25 px-3 py-2.5">
              <p className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Canonical path</p>
              <p className="mt-1.5 break-all font-mono text-ui-code text-[#c5cad0]">{project.path}</p>
            </div>
            <label className="flex items-start gap-3 rounded-md border border-border/80 bg-background/25 px-3 py-3 text-ui-control">
              <input
                checked={enabled}
                className="mt-0.5 size-3.5 accent-[var(--primary)]"
                onChange={(event) => setEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="block font-medium">Enabled for new work</span>
                <span className="mt-1 block text-ui-body text-muted-foreground">
                  Re-enabling requires the server to verify the path and workspace grant again.
                </span>
              </span>
            </label>
            {error ? <p className="text-ui-body text-red-300" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setOpen(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={saving} type="submit">{saving ? "Saving…" : "Save project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function projectAvailabilityStyle(project: SavedProjectSummary): string {
  if (!project.enabled) return "border-border bg-white/[0.04] text-muted-foreground";
  if (project.availability === "available") {
    return "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-300";
  }
  if (project.availability === "workspace_grant_revoked") {
    return "border-red-400/20 bg-red-400/[0.07] text-red-300";
  }
  return "border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.07] text-[var(--waiting)]";
}

function projectAvailabilityLabel(project: SavedProjectSummary): string {
  if (!project.enabled) return "disabled";
  if (project.availability === "workspace_grant_revoked") return "grant revoked";
  return project.availability;
}

function ProjectsView({
  dashboard,
  onProjectsChanged,
}: Omit<ControlPlaneViewProps, "view" | "onRefresh" | "onOpenSidebar">) {
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectReadGeneration = useRef(0);
  const activeTasks = dashboard.threads.filter(
    (thread) => thread.status === "running" || thread.status === "waiting",
  ).length;
  const enabledProjects = projects.filter((project) => project.enabled).length;
  const availableProjects = projects.filter(
    (project) => project.enabled && project.availability === "available",
  ).length;

  async function loadProjects() {
    const generation = projectReadGeneration.current + 1;
    projectReadGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      const result = await api.listProjects();
      if (generation !== projectReadGeneration.current) return;
      setProjects(result.projects);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (generation !== projectReadGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load saved projects");
    } finally {
      if (generation === projectReadGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  async function loadMoreProjects() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.listProjects(50, nextCursor);
      setProjects((current) => {
        const existingIds = new Set(current.map((project) => project.id));
        return [...current, ...result.projects.filter((project) => !existingIds.has(project.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more saved projects");
    } finally {
      setLoadingMore(false);
    }
  }

  function addProject(project: SavedProjectSummary) {
    projectReadGeneration.current += 1;
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    setLoading(false);
    setError(null);
    void onProjectsChanged?.({ type: "upsert", project });
  }

  function updateProject(project: SavedProjectSummary) {
    projectReadGeneration.current += 1;
    setProjects((current) => current.map((item) => item.id === project.id ? project : item));
    setLoading(false);
    setError(null);
    void onProjectsChanged?.({ type: "upsert", project });
  }

  async function refreshProjects() {
    await Promise.all([loadProjects(), onProjectsChanged?.({ type: "refresh" })]);
  }

  return (
    <>
      <PageHeader
        action={dashboard.user.role === "admin" ? <AddProjectDialog onCreated={addProject} /> : undefined}
        view="projects"
      />
      <PageScrollRegion view="projects">
        <div className="mx-auto max-w-5xl">
          <section className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <FolderGit2 className="size-4 text-primary" />
              <p className="mt-4 text-2xl font-medium">{loading ? "—" : projects.length}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Saved project registry</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <ShieldCheck className="size-4 text-[var(--healthy)]" />
              <p className="mt-4 text-2xl font-medium">{loading ? "—" : `${availableProjects}/${enabledProjects}`}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Available / enabled projects</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <Activity className="size-4 text-human" />
              <p className="mt-4 text-2xl font-medium">{activeTasks}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Runtime-derived active task states</p>
            </div>
          </section>

          <div className="mt-7 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Saved projects</h2>
              <p className="mt-1 text-ui-body text-muted-foreground">
                Durable organization registry. Repository details are inspected on the server for each read.
              </p>
            </div>
            <Button className="gap-2" disabled={loading} onClick={() => void refreshProjects()} size="sm" variant="outline">
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
            </Button>
          </div>

          {error ? (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-400/20 bg-red-400/[0.045] p-4" role="alert">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-300" />
              <div className="min-w-0 flex-1">
                <p className="text-ui-control font-medium">
                  {projects.length ? "Saved project refresh failed" : "Saved project registry unavailable"}
                </p>
                <p className="mt-1 text-ui-body text-muted-foreground">{error}</p>
              </div>
              {!projects.length ? <Button onClick={() => void refreshProjects()} size="sm" variant="ghost">Retry</Button> : null}
            </div>
          ) : null}

          {loading ? (
            <div aria-busy="true" className="mt-4 grid min-h-44 place-items-center rounded-lg border border-border bg-card/20">
              <div className="flex items-center gap-2 text-ui-control text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" /> Loading saved projects
              </div>
            </div>
          ) : !error && projects.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
              <FolderGit2 className="mx-auto size-5 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-medium">No saved projects</h3>
              <p className="mx-auto mt-2 max-w-md text-ui-body text-muted-foreground">
                {dashboard.user.role === "admin"
                  ? "Register an existing directory covered by an organization workspace grant."
                  : "An administrator can register an existing directory covered by an organization workspace grant."}
              </p>
            </div>
          ) : projects.length ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {projects.map((project) => (
                <article className="rounded-lg border border-border bg-card/25 p-5" key={project.id}>
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary/60">
                      <FolderGit2 className="size-4 text-primary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 truncate text-sm font-medium">{project.name}</h3>
                        <span className={cn("rounded-sm border px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-wider", projectAvailabilityStyle(project))}>
                          {projectAvailabilityLabel(project)}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-ui-meta text-muted-foreground" title={project.path}>{project.path}</p>
                    </div>
                    {dashboard.user.role === "admin" ? <ProjectSettingsDialog onUpdated={updateProject} project={project} /> : null}
                  </div>

                  <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/70 pt-4 text-ui-control">
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Repository</dt>
                      <dd className="mt-1.5 truncate capitalize">{project.repositoryStatus.replaceAll("_", " ")}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Working tree</dt>
                      <dd className={cn("mt-1.5", project.dirty === true && "text-[var(--waiting)]")}>{project.dirty === null ? "Not reported" : project.dirty ? "Dirty" : "Clean"}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Branch</dt>
                      <dd className="mt-1.5 truncate font-mono text-ui-code">{project.branch ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Commit</dt>
                      <dd className="mt-1.5 truncate font-mono text-ui-code">{project.headCommit?.slice(0, 10) ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Upstream</dt>
                      <dd className="mt-1.5 truncate font-mono text-ui-code">{project.upstream ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-ui-micro uppercase tracking-[0.13em] text-muted-foreground">Origin</dt>
                      <dd className="mt-1.5 truncate font-mono text-ui-code" title={project.remoteUrl ?? undefined}>{project.remoteUrl ?? "Not reported"}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : null}

          {nextCursor && !loading ? (
            <div className="mt-5 flex justify-center">
              <Button disabled={loadingMore} onClick={() => void loadMoreProjects()} variant="outline">
                {loadingMore ? "Loading…" : "Load more projects"}
              </Button>
            </div>
          ) : null}
        </div>
      </PageScrollRegion>
    </>
  );
}

function UsageMeter({
  label,
  value,
  limit,
}: {
  label: string;
  value: number;
  limit: number;
}) {
  const normalizedValue = Math.max(0, value);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const percentage = hasLimit ? Math.round((normalizedValue / limit) * 100) : 0;
  const visualPercentage = Math.min(100, percentage);
  const meterMaximum = hasLimit ? limit : Math.max(1, normalizedValue);
  const meterValue = Math.min(normalizedValue, meterMaximum);
  const valueText = hasLimit
    ? `${normalizedValue.toLocaleString()} of ${limit.toLocaleString()} used (${percentage}%)`
    : `${normalizedValue.toLocaleString()} used; no limit reported`;
  return (
    <div className="rounded-lg border border-border bg-card/25 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-control font-medium">{label}</span>
        <span className="font-mono text-ui-meta text-muted-foreground">
          {compactNumber.format(normalizedValue)} / {hasLimit ? compactNumber.format(limit) : "—"}
        </span>
      </div>
      <div
        aria-label={`${label} usage`}
        aria-valuemax={meterMaximum}
        aria-valuemin={0}
        aria-valuenow={meterValue}
        aria-valuetext={valueText}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary"
        role="meter"
      >
        <div
          className={cn(
            "h-full rounded-full",
            percentage >= 90 ? "bg-red-400" : percentage >= 70 ? "bg-[var(--waiting)]" : "bg-primary",
          )}
          style={{ width: `${visualPercentage}%` }}
        />
      </div>
      <p className="mt-2 font-mono text-ui-meta text-muted-foreground">
        {hasLimit ? `${percentage}% used` : "Limit unavailable"}
      </p>
    </div>
  );
}

function UsageView({
  dashboard,
}: Pick<ControlPlaneViewProps, "dashboard">) {
  const { usage } = dashboard;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  return (
    <>
      <PageHeader view="usage" />
      <PageScrollRegion view="usage">
        <div className="mx-auto max-w-5xl">
          <section className="mb-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <Gauge className="size-4 text-primary" />
              <p className="mt-4 text-2xl font-medium">{compactNumber.format(totalTokens)}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Settled input + output tokens</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <Activity className="size-4 text-[var(--healthy)]" />
              <p className="mt-4 text-2xl font-medium">{usage.activeRuns}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Active reserved runs</p>
            </div>
            <div className="rounded-lg border border-border bg-card/30 p-4">
              <Users className="size-4 text-human" />
              <p className="mt-4 text-2xl font-medium">{usage.seatsUsed}</p>
              <p className="mt-1 text-ui-control text-muted-foreground">Active workspace seats</p>
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-3">
            <UsageMeter label="Requests" limit={usage.requestLimit} value={usage.requestsUsed} />
            <UsageMeter label="Concurrent runs" limit={usage.activeRunLimit} value={usage.activeRuns} />
            <UsageMeter label="Seats" limit={usage.seatLimit} value={usage.seatsUsed} />
          </section>

          <section className="mt-6 overflow-hidden rounded-lg border border-border bg-card/25">
            <div className="grid grid-cols-2 gap-4 border-b border-border px-4 py-3 font-mono text-ui-micro uppercase tracking-[0.14em] text-muted-foreground sm:grid-cols-4">
              <span>Input tokens</span><span>Output tokens</span><span>Period start</span><span>Period end</span>
            </div>
            <div className="grid grid-cols-2 gap-4 px-4 py-4 text-ui-control sm:grid-cols-4">
              <span className="font-mono">{usage.inputTokens.toLocaleString()}</span>
              <span className="font-mono">{usage.outputTokens.toLocaleString()}</span>
              <span>{new Date(usage.periodStart).toLocaleDateString()}</span>
              <span>{usage.periodEnd ? new Date(usage.periodEnd).toLocaleDateString() : "Open-ended"}</span>
            </div>
          </section>
          <div className="mt-6 rounded-lg border border-[var(--waiting)]/20 bg-[var(--waiting)]/[0.045] p-4 text-ui-body text-muted-foreground">
            Tokens are settled from exact Codex turn events. Currency cost is intentionally unavailable until route-specific, versioned pricing and provider reconciliation are configured.
          </div>
        </div>
      </PageScrollRegion>
    </>
  );
}

function AuditView() {
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.listAuditEvents()
      .then((result) => {
        if (!active) return;
        setEvents(result.events);
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load audit events");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <PageHeader view="audit" />
      <PageScrollRegion view="audit">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-center gap-2 text-ui-control text-muted-foreground">
            <ScrollText className="size-3.5 text-human" />
            Latest 100 tenant events · metadata is scalar-filtered before it reaches the browser
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-card/25">
            {loading ? <p className="p-5 text-ui-body text-muted-foreground">Loading audit log…</p> : null}
            {error ? <p className="p-5 text-ui-body text-red-300" role="alert">{error}</p> : null}
            {!loading && !error && events.length === 0 ? (
              <p className="p-5 text-ui-body text-muted-foreground">No audit events have been recorded.</p>
            ) : null}
            {events.map((event) => (
              <article className="border-b border-border/60 px-4 py-3 last:border-b-0" key={event.id}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-ui-code font-medium text-foreground">{event.action}</span>
                  <span className="rounded-sm bg-white/[0.04] px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-wider text-muted-foreground">{event.targetType}</span>
                  <time className="ml-auto font-mono text-ui-meta text-muted-foreground" dateTime={event.createdAt}>
                    {auditTimestamp.format(new Date(event.createdAt))}
                  </time>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-ui-meta text-muted-foreground">
                  <span>actor {event.actorUserId ?? "system"}</span>
                  {event.targetId ? <span>target {event.targetId}</span> : null}
                  {Object.entries(event.metadata).map(([key, value]) => (
                    <span key={key}>{key}={String(value)}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </PageScrollRegion>
    </>
  );
}

const plans: Array<{ id: PlanId; name: string; summary: string; facts: string[] }> = [
  {
    id: "free",
    name: "Free",
    summary: "Built-in evaluation tier",
    facts: ["No Stripe subscription", "Limits enforced by the server", "One default seat"],
  },
  {
    id: "pro",
    name: "Pro",
    summary: "Paid Stripe subscription tier",
    facts: ["Operator-configured Stripe price", "Server-issued limits", "Webhook-verified activation"],
  },
  {
    id: "team",
    name: "Team",
    summary: "Paid workspace subscription tier",
    facts: ["Operator-configured Stripe price", "Seats read from the subscription", "Webhook-verified activation"],
  },
];

function BillingView({ dashboard }: Pick<ControlPlaneViewProps, "dashboard">) {
  const [message, setMessage] = useState<string | null>(null);

  async function selectPlan(plan: "pro" | "team") {
    try {
      const result = await api.createCheckout(plan);
      if (result.url) window.location.assign(result.url);
      else setMessage(result.message ?? "Stripe is not configured for this environment.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not open checkout");
    }
  }

  async function openPortal() {
    try {
      const result = await api.createPortal();
      if (result.url) window.location.assign(result.url);
      else setMessage(result.message ?? "No billing portal is available yet.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not open billing portal");
    }
  }

  return (
    <>
      <PageHeader action={dashboard.subscription.status === "active" && dashboard.subscription.stripeConfigured ? <Button onClick={openPortal} size="sm" variant="outline"><CreditCard className="mr-2 size-3.5" /> Manage billing</Button> : undefined} view="billing" />
      <PageScrollRegion view="billing">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-start justify-between rounded-lg border border-primary/20 bg-primary/[0.045] p-5">
            <div><p className="font-mono text-ui-micro uppercase tracking-[0.16em] text-primary">Current plan</p><h2 className="mt-2 text-xl font-medium capitalize">{dashboard.subscription.plan}</h2><p className="mt-1 text-ui-control text-muted-foreground">{dashboard.subscription.status === "none" ? "Local plan · no active subscription" : dashboard.subscription.status}</p></div>
            <CircleGauge className="size-5 text-primary" />
          </div>

          {message ? <div role="status" className="mb-5 rounded-md border border-border bg-card px-4 py-3 text-ui-body text-muted-foreground">{message}</div> : null}

          <div className="grid gap-3 md:grid-cols-3">
            {plans.map((plan) => {
              const current = plan.id === dashboard.subscription.plan;
              const paidPlan = plan.id === "pro" || plan.id === "team";
              const checkoutUnavailable = paidPlan && !dashboard.subscription.stripeConfigured;
              const facts = current
                ? [
                    `${compactNumber.format(dashboard.usage.requestLimit)} requests per metering period`,
                    `${dashboard.usage.activeRunLimit.toLocaleString()} concurrent runs`,
                    `${dashboard.usage.seatLimit.toLocaleString()} active seats`,
                  ]
                : plan.facts;
              return (
                <article className={cn("flex min-h-[310px] flex-col rounded-lg border bg-card/25 p-5", current ? "border-primary/45" : "border-border")} key={plan.id}>
                  <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{plan.name}</h3>{current ? <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-ui-micro uppercase tracking-wider text-primary">current</span> : null}</div>
                  <p className="mt-5 text-xl font-medium tracking-[-0.025em]">
                    {plan.id === "free"
                      ? "Included"
                      : dashboard.subscription.stripeConfigured
                        ? "Price shown in Stripe"
                        : "Stripe checkout unavailable"}
                  </p>
                  <p className="mt-2 text-ui-body text-muted-foreground">{plan.summary}</p>
                  <ul className="mt-7 space-y-3">
                    {facts.map((fact) => <li className="flex items-center gap-2 text-ui-control text-[#c2c7cd]" key={fact}><Check aria-hidden="true" className="size-3.5 text-emerald-400" />{fact}</li>)}
                  </ul>
                  <Button className="mt-auto" disabled={current || plan.id === "free" || checkoutUnavailable} onClick={() => (plan.id === "pro" || plan.id === "team") && selectPlan(plan.id)} variant={plan.id === "team" ? "default" : "outline"}>{current ? "Current plan" : plan.id === "free" ? "No self-service switch" : checkoutUnavailable ? "Checkout unavailable" : <>Choose {plan.name}<ArrowUpRight aria-hidden="true" className="ml-2 size-3.5" /></>}</Button>
                </article>
              );
            })}
          </div>

          <div className="mt-6 flex items-center gap-3 rounded-lg border border-border bg-card/20 p-4"><ShieldCheck className="size-4 text-emerald-400" /><p className="text-ui-body text-muted-foreground">Entitlements are computed on the server from verified Stripe webhooks. Checkout redirects never grant access by themselves.</p></div>
        </div>
      </PageScrollRegion>
    </>
  );
}

export function ControlPlaneView(props: ControlPlaneViewProps) {
  if (props.view === "projects") {
    return (
      <ProjectsView
        dashboard={props.dashboard}
        onProjectsChanged={props.onProjectsChanged}
      />
    );
  }
  if (props.view === "providers") return <ProvidersView {...props} />;
  if (props.view === "team") {
    return <TeamView dashboard={props.dashboard} />;
  }
  if (props.view === "usage") {
    return <UsageView dashboard={props.dashboard} />;
  }
  if (props.view === "audit") return <AuditView />;
  if (props.view === "billing") {
    return <BillingView dashboard={props.dashboard} />;
  }
  const exhaustiveView: never = props.view;
  return exhaustiveView;
}
