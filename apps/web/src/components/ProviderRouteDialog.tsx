import { useId, useRef, useState, type FormEvent } from "react";
import { PROVIDER_CATALOG, type ProviderConnection, type ProviderTestResult } from "@agent-harness/contracts";
import { Check, CircleAlert, LoaderCircle, Pencil, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ProviderTestFeedback({ result }: { result: ProviderTestResult }) {
  const Icon = result.success ? Check : CircleAlert;
  return (
    <div
      className={cn("rounded-lg border p-3 text-ui-body", result.success ? "border-[var(--healthy)]/25 bg-[var(--c-run-dim)]" : "border-destructive/25 bg-destructive/5")}
      role={result.success ? "status" : "alert"}
    >
      <div className="flex items-center gap-2 font-medium">
        <Icon aria-hidden="true" className={cn("size-4 shrink-0", result.success ? "text-[var(--healthy)]" : "text-destructive")} />
        {result.success ? "Connection successful" : "Connection failed"}
        <span className="ml-auto whitespace-nowrap text-ui-meta font-normal text-muted-foreground">{result.latencyMs.toLocaleString()} ms</span>
      </div>
      <p className="mt-1 break-words text-muted-foreground">{result.message}</p>
      <p className="mt-1 break-all font-mono text-ui-code text-muted-foreground">{result.model}</p>
    </div>
  );
}

export function ProviderRouteDialog({ connection, initialCatalogId, disabled, onSaved }: {
  connection?: ProviderConnection;
  initialCatalogId?: string;
  disabled?: boolean;
  onSaved: () => Promise<void>;
}) {
  const initial = PROVIDER_CATALOG.find((item) => item.id === (connection?.catalogId ?? initialCatalogId)) ?? PROVIDER_CATALOG[0]!;
  const [open, setOpen] = useState(false);
  const [catalogId, setCatalogId] = useState(initial.id);
  const selected = PROVIDER_CATALOG.find((item) => item.id === catalogId)!;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const pendingRef = useRef(false);
  const formId = useId();
  const keepsCredential = Boolean(connection?.hasCredential && connection.catalogId === catalogId);

  function changeOpen(nextOpen: boolean) {
    if (pendingRef.current) return;
    if (nextOpen) {
      setCatalogId(initial.id);
      setName(connection?.name ?? initial.name);
      setBaseUrl(connection?.baseUrl ?? initial.defaultBaseUrl ?? "");
      setModel(connection?.defaultModel ?? initial.defaultModel ?? "");
      setApiKey("");
      setEnabled(connection?.enabled ?? true);
      setIsDefault(connection?.isDefault ?? true);
      setError(null);
      setResult(null);
    }
    setOpen(nextOpen);
  }

  function selectProvider(nextId: string) {
    const next = PROVIDER_CATALOG.find((item) => item.id === nextId);
    if (!next) return;
    setCatalogId(next.id);
    setName(next.name);
    setBaseUrl(next.defaultBaseUrl ?? "");
    setModel(next.defaultModel ?? "");
    setApiKey("");
    setResult(null);
    setError(null);
  }

  async function submit(action: "save" | "test") {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    setResult(null);
    const values = {
      id: connection?.id,
      catalogId,
      name: name.trim(),
      baseUrl: selected.adapter === "litellm" ? undefined : baseUrl.trim() || null,
      defaultModel: model.trim() || null,
      apiKey: apiKey.trim() || (connection && connection.catalogId !== catalogId ? null : undefined),
      enabled,
      isDefault,
    };
    try {
      if (action === "test") {
        const response = await api.testProvider(values);
        setResult(response.result);
      } else {
        await api.saveProvider(values);
        await onSaved();
        setApiKey("");
        setOpen(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not ${action === "test" ? "test" : "save"} model route`);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit("save");
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger asChild>
        <Button
          aria-label={connection ? `Edit ${connection.name} route` : initialCatalogId ? `Configure ${initial.name}` : undefined}
          className="gap-2"
          disabled={disabled}
          size="sm"
          variant={connection || initialCatalogId ? "outline" : "default"}
        >
          {connection ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
          {connection ? "Edit" : initialCatalogId ? "Configure" : "Add route"}
        </Button>
      </DialogTrigger>
      <DialogContent className="management-dialog border-border bg-card sm:max-w-[560px]">
        <form onChange={() => { setResult(null); setError(null); }} onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{connection ? "Edit model route" : "Add a model route"}</DialogTitle>
            <DialogDescription>Choose a provider and model, then test the connection before saving.</DialogDescription>
          </DialogHeader>
          <fieldset className="grid min-w-0 gap-4 py-5" disabled={pending !== null}>
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Provider
              <Select disabled={pending !== null} onValueChange={selectProvider} value={catalogId}>
                <SelectTrigger aria-label="Provider" className="h-10 bg-background/40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_CATALOG.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <p className="text-ui-body text-muted-foreground">{selected.description}</p>
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Display name
              <Input className="h-10" maxLength={160} onChange={(event) => setName(event.target.value)} required value={name} />
            </label>
            {selected.adapter === "litellm" ? (
              <div aria-label="LiteLLM endpoint policy" className="rounded-lg border border-border p-3" role="note">
                <p className="text-ui-control font-medium">Operator-managed LiteLLM endpoint</p>
                <p className="mt-1 text-ui-body text-muted-foreground">Choose a model alias and, if needed, a scoped token. The gateway URL cannot be changed in the browser.</p>
              </div>
            ) : (
              <div className="grid gap-2">
                <label className="grid gap-2 text-ui-control text-muted-foreground">
                  Endpoint
                  <Input aria-describedby={`${formId}-endpoint`} className="h-10 font-mono text-ui-code" maxLength={2048} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selected.local ? "http://127.0.0.1:11434/v1" : "https://…/v1"} required type="url" value={baseUrl} />
                </label>
                <p className="text-ui-meta text-muted-foreground" id={`${formId}-endpoint`}>Use HTTPS. Local or private endpoints require your server administrator to enable access.</p>
              </div>
            )}
            <label className="grid gap-2 text-ui-control text-muted-foreground">
              Default model
              <Input className="h-10 font-mono text-ui-code" maxLength={256} onChange={(event) => setModel(event.target.value)} placeholder="Enter a model ID" required value={model} />
            </label>
            {selected.keyLabel ? (
              <div className="grid gap-2">
                <label className="grid gap-2 text-ui-control text-muted-foreground" htmlFor={`${formId}-key`}>
                  {selected.keyLabel}
                  <Input aria-describedby={`${formId}-key-help`} autoComplete="off" className="h-10 font-mono text-ui-code" id={`${formId}-key`} maxLength={16384} onChange={(event) => setApiKey(event.target.value)} placeholder={keepsCredential ? "Keep saved credential" : "Enter credential"} type="password" value={apiKey} />
                </label>
                <p className="text-ui-meta text-muted-foreground" id={`${formId}-key-help`}>
                  {keepsCredential ? "Leave blank to keep the saved credential. Enter a new value to replace it." : selected.adapter === "litellm" ? "Optional if your server administrator configured a shared credential." : "Credentials are encrypted and stored on the server."}
                </p>
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-ui-control text-muted-foreground">
              <input checked={enabled} className="size-4 accent-[var(--primary)]" onChange={(event) => { setEnabled(event.target.checked); if (!event.target.checked) setIsDefault(false); }} type="checkbox" />
              Enable this route
            </label>
            <label className="flex items-center gap-2 text-ui-control text-muted-foreground">
              <input checked={isDefault} className="size-4 accent-[var(--primary)]" disabled={!enabled} onChange={(event) => setIsDefault(event.target.checked)} type="checkbox" />
              Use as the default route for new tasks
            </label>
          </fieldset>
          <div className="mb-5 grid gap-3">
            <p className="text-ui-meta text-muted-foreground">Testing sends a small request to this model and may use provider credits. Changes take effect when you save.</p>
            {pending === "test" ? <p className="flex items-center gap-2 text-ui-body text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />Testing connection…</p> : null}
            {result ? <ProviderTestFeedback result={result} /> : null}
            {error ? <p className="text-ui-body text-destructive" role="alert">{error}</p> : null}
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button disabled={pending !== null} onClick={(event) => { if (event.currentTarget.form?.reportValidity()) void submit("test"); }} type="button" variant="outline"><Play className="size-3.5" />Test connection</Button>
            <Button disabled={pending !== null} onClick={() => changeOpen(false)} type="button" variant="ghost">Cancel</Button>
            <Button disabled={pending !== null} type="submit">{pending === "save" ? "Saving…" : connection ? "Save changes" : "Save route"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
