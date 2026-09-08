import { useState, type FormEvent } from "react";
import { ArrowRight, FolderClosed, MessageSquareText, ShieldCheck } from "lucide-react";
import type { UserSummary } from "@agent-harness/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

interface LoginScreenProps {
  onAuthenticated: (user: UserSummary) => void;
}

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
    <main className="h-dvh overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full max-w-[1600px] flex-col">
        <header className="flex h-24 shrink-0 items-center justify-between px-6 sm:px-10 lg:px-16">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="relative grid size-8 place-items-center">
              <span className="absolute size-6 rotate-[-15deg] rounded-[7px] border-[1.5px] border-current" />
              <span className="absolute size-6 translate-x-[3px] translate-y-[-2px] rotate-[15deg] rounded-[7px] border-[1.5px] border-current bg-background" />
              <span className="relative size-1.5 rounded-full bg-current" />
            </span>
            <span className="text-lg font-semibold tracking-tight">onto-work</span>
          </div>
          <span className="hidden text-ui-control text-muted-foreground sm:inline">Your workspace for agent work</span>
        </header>

        <div className="grid flex-1 items-center gap-12 px-6 pb-12 pt-8 sm:px-10 lg:grid-cols-[1.15fr_1fr] lg:gap-20 lg:px-16 lg:pb-20">
          <section className="hidden max-w-xl lg:block">
            <p className="mb-6 flex items-center gap-2 text-ui-control text-muted-foreground"><span className="size-1.5 rounded-full bg-human" aria-hidden="true" /> A little more room to focus</p>
            <h1 className="text-[52px] font-medium leading-[1.14] tracking-[-0.045em] xl:text-[64px]">
              Good work<br />starts with<br /><span className="text-muted-foreground">a clear space.</span>
            </h1>
            <p className="mt-7 max-w-[390px] text-base leading-7 text-muted-foreground">
              Bring your projects, ideas, and agents together. Follow the work as it happens, from the first thought to the final change.
            </p>
            <div className="mt-12 flex max-w-md flex-wrap gap-x-6 gap-y-4 border-t border-border pt-6 text-ui-control text-secondary-foreground">
              <span className="flex items-center gap-2"><FolderClosed aria-hidden="true" className="size-4 text-muted-foreground" /> Your projects</span>
              <span className="flex items-center gap-2"><MessageSquareText aria-hidden="true" className="size-4 text-muted-foreground" /> Focused tasks</span>
              <span className="flex items-center gap-2"><ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" /> Private by design</span>
            </div>
          </section>

          <section className="flex items-center justify-center lg:min-h-[580px] lg:rounded-[32px] lg:bg-sidebar lg:px-10 lg:py-14" aria-labelledby="sign-in-heading">
            <div className="w-full max-w-[360px]">
              <div className="mb-9">
                <p className="mb-3 text-ui-control text-muted-foreground">Welcome back</p>
                <h2 className="text-[30px] font-medium leading-tight tracking-[-0.035em]" id="sign-in-heading">Make room for<br />your next idea.</h2>
                <p className="mt-4 text-ui-body leading-6 text-muted-foreground">Sign in to your onto-work workspace.</p>
              </div>
              <form className="space-y-5" onSubmit={handleSubmit}>
                <label className="block space-y-2 text-ui-control font-medium">
                  <span>Username</span>
                  <Input autoComplete="username" autoFocus className="h-12 rounded-xl border-border bg-background px-4 font-normal shadow-none" onChange={(event) => setUsername(event.target.value)} required value={username} />
                </label>
                <label className="block space-y-2 text-ui-control font-medium">
                  <span>Password</span>
                  <Input autoComplete="current-password" className="h-12 rounded-xl border-border bg-background px-4 font-normal shadow-none" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
                </label>
                {error ? <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-ui-body text-destructive" role="alert">{error}</div> : null}
                <Button className="mt-2 h-12 w-full justify-between rounded-xl px-4 shadow-none" disabled={isSubmitting} type="submit">
                  <span>{isSubmitting ? "Signing in…" : "Sign in"}</span>
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Button>
              </form>
              <p className="mt-6 text-ui-meta leading-5 text-muted-foreground">First time here? Use the credentials from your workspace administrator. You may be asked to set a new password.</p>
            </div>
          </section>
        </div>
        <footer className="flex shrink-0 items-center justify-between px-6 pb-7 text-ui-meta text-muted-foreground sm:px-10 lg:px-16">
          <span>Think it through. Bring it to life.</span>
          <span className="hidden items-center gap-1.5 sm:flex"><ShieldCheck aria-hidden="true" className="size-3.5" /> Your credentials stay in your workspace</span>
        </footer>
      </div>
    </main>
  );
}
