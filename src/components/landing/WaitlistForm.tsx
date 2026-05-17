import { useState } from "react";
import { WAITLIST } from "~/data/landing";
import { normalizeUrl } from "~/lib/url";

type State = "idle" | "submitting" | "done" | "error";

export function WaitlistForm({ source }: { source: string }) {
  const [email, setEmail] = useState("");
  const [position, setPosition] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUrlError(null);

    let normalizedUrl: string | undefined;
    if (companyUrl.trim()) {
      const result = normalizeUrl(companyUrl);
      if (!result) {
        setUrlError("That doesn't look like a URL — try something like acme.com.");
        return;
      }
      normalizedUrl = result;
    }

    setState("submitting");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          position: position || undefined,
          companyUrl: normalizedUrl,
          source,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "something_went_wrong");
        setState("error");
        return;
      }
      setState("done");
    } catch {
      setError("network_error");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="mx-auto mt-2 max-w-[520px] rounded-2xl border-[1.5px] border-ink/20 bg-ink/5 px-6 py-5 text-left text-ink">
        <p className="font-semibold">{WAITLIST.success}</p>
        <p className="mt-1 text-sm text-ink/70">
          We'll reach out from <span className="font-mono">hello@productflash.io</span> when a seat
          opens.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-2 grid max-w-[520px] gap-3 text-left">
      <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/70">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 rounded-md border-[1.5px] border-ink/20 bg-paper px-3 text-sm font-normal normal-case tracking-normal text-ink outline-none placeholder:text-ink/40 focus:border-ink"
          placeholder="you@company.com"
        />
      </label>

      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/70">
          Role
          <input
            type="text"
            autoComplete="organization-title"
            maxLength={120}
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="h-11 rounded-md border-[1.5px] border-ink/20 bg-paper px-3 text-sm font-normal normal-case tracking-normal text-ink outline-none placeholder:text-ink/40 focus:border-ink"
            placeholder="Head of Product"
          />
        </label>

        <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/70">
          Company URL
          <input
            type="text"
            inputMode="url"
            autoComplete="url"
            value={companyUrl}
            onChange={(e) => setCompanyUrl(e.target.value)}
            className="h-11 rounded-md border-[1.5px] border-ink/20 bg-paper px-3 text-sm font-normal normal-case tracking-normal text-ink outline-none placeholder:text-ink/40 focus:border-ink"
            placeholder="acme.com"
          />
          {urlError ? (
            <span className="text-xs font-medium normal-case tracking-normal text-coral">
              {urlError}
            </span>
          ) : null}
        </label>
      </div>

      <button
        type="submit"
        disabled={state === "submitting"}
        className="mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-ink px-8 text-base font-semibold text-white transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
      >
        {state === "submitting" ? "Sending…" : WAITLIST.label}
      </button>

      {state === "error" ? (
        <p className="text-sm font-medium text-coral">
          {error === "invalid_email"
            ? "That email doesn't look right — double-check and resubmit."
            : "Couldn't reach the server — try again in a moment."}
        </p>
      ) : null}
    </form>
  );
}
