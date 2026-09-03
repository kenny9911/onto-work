import { useState, type FormEvent } from "react";
import { ArrowRight, Check, Command, ShieldCheck, Waypoints } from "lucide-react";
import type { UserSummary } from "@agent-harness/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface LoginScreenProps {
  onAuthenticated: (user: UserSummary) => void;
}

const capabilities = [
  "Isolated Codex runtimes",
  "Provider routing and BYOK",
  "Tenant roles and entitlements",
] as const;

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await api.login(username, password);
      onAuthenticated(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-background lg:grid-cols-[1.08fr_0.92fr]">
      <section className="relative hidden overflow-hidden border-r border-border bg-[#0e1013] p-12 lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)",
            backgroundSize: "38px 38px",
            maskImage: "linear-gradient(to bottom right, black, transparent 76%)",
          }}
        />

        <div className="relative flex items-center gap-3">
          <div className="text-ui-control grid size-9 place-items-center rounded-lg border border-white/10 bg-white/[0.055] font-mono font-semibold text-primary">
            AH
          </div>
          <div>
            <p className="text-ui-control font-semibold tracking-tight">Agent Harness</p>
            <p className="text-ui-micro font-mono uppercase tracking-[0.18em] text-muted-foreground">
              Control plane · preview 01
            </p>
          </div>
        </div>

        <div className="relative max-w-xl pb-8">
          <div className="text-ui-meta mb-8 flex items-center gap-3 text-muted-foreground">
            <span className="h-px w-10 bg-primary/70" />
            Runtime orchestration for serious agent work
          </div>
          <h1 className="max-w-[14ch] text-5xl font-medium leading-[1.02] tracking-[-0.045em] text-[#f1f2f4] xl:text-6xl">
            One quiet place to run every coding agent.
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-[#9299a3]">
            The Codex harness, evolved into a governed workspace for teams,
            private model routes, and local execution.
          </p>

          <div className="mt-12 grid gap-3">
            {capabilities.map((capability, index) => (
              <div
                key={capability}
                className="text-ui-body group flex items-center gap-4 border-t border-white/[0.07] py-3 text-[#c8ccd2]"
              >
                <span className="text-ui-meta font-mono text-[#626a75]">
                  0{index + 1}
                </span>
                <Check className="size-3.5 text-primary/85" aria-hidden="true" />
                <span>{capability}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="text-ui-meta relative grid grid-cols-3 gap-3 text-muted-foreground">
          <span className="flex items-center gap-2"><Waypoints className="size-3.5" /> Runtime-aware</span>
          <span className="flex items-center gap-2"><ShieldCheck className="size-3.5" /> Tenant-isolated</span>
          <span className="flex items-center gap-2"><Command className="size-3.5" /> Keyboard-first</span>
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-9 lg:hidden">
            <div className="text-ui-control mb-8 grid size-10 place-items-center rounded-lg border border-border bg-card font-mono font-semibold text-primary">
              AH
            </div>
          </div>

          <div className="mb-8">
            <p className="text-ui-micro mb-3 font-mono uppercase tracking-[0.2em] text-primary">
              Secure workspace
            </p>
            <h2 className="text-ui-title font-medium tracking-[-0.035em]">Sign in to continue</h2>
            <p className="text-ui-body mt-2 text-muted-foreground">
              Use your workspace credentials. New bootstrap accounts must rotate
              their temporary password after signing in.
            </p>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <label className="text-ui-control block space-y-2">
              <span className="text-[#c7cbd1]">Username</span>
              <Input
                autoComplete="username"
                autoFocus
                className="h-11 border-border bg-card/60"
                onChange={(event) => setUsername(event.target.value)}
                required
                value={username}
              />
            </label>

            <label className="text-ui-control block space-y-2">
              <span className="text-[#c7cbd1]">Password</span>
              <Input
                autoComplete="current-password"
                className="h-11 border-border bg-card/60"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>

            {error ? (
              <div role="alert" className="text-ui-body rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-red-300">
                {error}
              </div>
            ) : null}

            <Button className="h-11 w-full justify-between px-4" disabled={isSubmitting} type="submit">
              <span>{isSubmitting ? "Signing in…" : "Sign in"}</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </form>

          <p className="text-ui-meta mt-6 text-muted-foreground">
            Credentials are handled by the local control plane and are never
            forwarded to model providers.
          </p>
        </div>
      </section>
    </main>
  );
}
