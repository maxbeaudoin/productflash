import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonVariants } from "~/components/ui/button";
import type { WaitlistRow } from "~/features/waitlist/shared/types";

export function WaitlistRowItem({
  row,
  onIssueInvite,
}: {
  row: WaitlistRow;
  onIssueInvite: (id: string) => Promise<{ url: string }>;
}) {
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "issuing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onIssue() {
    setState("issuing");
    setError(null);
    setCopied(false);
    try {
      const { url } = await onIssueInvite(row.id);
      setIssuedUrl(url);
      setState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to issue invite");
      setState("error");
    }
  }

  async function onCopy() {
    if (!issuedUrl) return;
    await navigator.clipboard.writeText(issuedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const joined = formatDate(row.createdAt);

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{row.email}</span>
          <StatePill row={row} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
          <span>Joined {joined}</span>
          {row.position ? <span>· {row.position}</span> : null}
          {row.companyUrl ? (
            <span>
              ·{" "}
              <a
                href={row.companyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-text-muted underline-offset-2 hover:text-text hover:underline"
              >
                {displayUrl(row.companyUrl)}
              </a>
            </span>
          ) : null}
          {row.source ? <span>· via {row.source}</span> : null}
        </div>
        {issuedUrl ? (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-ink-line bg-paper p-3 sm:flex-row sm:items-center">
            <code className="flex-1 truncate font-mono text-xs">{issuedUrl}</code>
            <Button type="button" variant="outline" size="sm" onClick={onCopy} className="shrink-0">
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="shrink-0">
        {row.state === "accepted" && row.userId ? (
          <Link
            to="/admin/users/$userId"
            params={{ userId: row.userId }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View user
          </Link>
        ) : (
          <Button
            type="button"
            onClick={onIssue}
            disabled={state === "issuing"}
            variant={row.state === "invited" ? "outline" : "default"}
            size="sm"
          >
            {state === "issuing" ? "Issuing…" : row.state === "invited" ? "Re-issue" : "Invite"}
          </Button>
        )}
      </div>
    </li>
  );
}

function StatePill({ row }: { row: WaitlistRow }) {
  if (row.state === "accepted" && row.acceptedAt) {
    return (
      <span className="inline-flex items-center rounded-pill bg-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
        Accepted {formatDate(row.acceptedAt)}
      </span>
    );
  }
  if (row.state === "invited" && row.invitedAt) {
    return (
      <span className="inline-flex items-center rounded-pill bg-ink/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
        Invited {formatDate(row.invitedAt)}
      </span>
    );
  }
  return null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return raw;
  }
}
