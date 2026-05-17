import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { useState } from "react";
import { z } from "zod";
import { Button, buttonVariants } from "~/components/ui/button";
import { users, waitlist } from "~/db/schema";
import { requireAdminSession } from "~/lib/auth-server";
import { getDb } from "~/lib/db";
import { env } from "~/lib/env";
import { signInviteToken } from "~/lib/invite-token";
import { logger } from "~/lib/logger";

// Minimal admin surface for issuing invites off the public waitlist (#34).
// Lives at /admin/waitlist behind requireAdminSession. Shares no nav with
// the future /admin/users (#16) yet — those converge once #16 lands.

type WaitlistState = "waitlist" | "invited" | "accepted";

type WaitlistRow = {
  id: string;
  email: string;
  name: string | null;
  position: string | null;
  companyUrl: string | null;
  source: string | null;
  invitedAt: string | null;
  createdAt: string;
  // Derived from the joined users row: a row is "accepted" once the
  // invitee actually submitted /signup (status moves past 'pending') or
  // verified the magic link (emailVerified=true). acceptedAt is a best-
  // available proxy — profileConfirmedAt when present, else updatedAt at
  // the moment of acceptance.
  state: WaitlistState;
  userId: string | null;
  acceptedAt: string | null;
};

const filterSchema = z.object({
  state: z.enum(["all", "waitlist", "invited", "accepted"]).catch("all"),
});

const listWaitlist = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdminSession();
  const db = getDb();
  const rows = await db
    .select({
      id: waitlist.id,
      email: waitlist.email,
      name: waitlist.name,
      position: waitlist.position,
      companyUrl: waitlist.companyUrl,
      source: waitlist.source,
      invitedAt: waitlist.invitedAt,
      createdAt: waitlist.createdAt,
      userId: users.id,
      userStatus: users.status,
      emailVerified: users.emailVerified,
      profileConfirmedAt: users.profileConfirmedAt,
      userUpdatedAt: users.updatedAt,
    })
    .from(waitlist)
    .leftJoin(users, eq(users.email, waitlist.email))
    .orderBy(desc(waitlist.createdAt));

  return {
    rows: rows.map<WaitlistRow>((r) => {
      const accepted = Boolean(
        r.userId && (r.emailVerified || (r.userStatus && r.userStatus !== "pending")),
      );
      const state: WaitlistState = accepted ? "accepted" : r.invitedAt ? "invited" : "waitlist";
      const acceptedAt = accepted ? (r.profileConfirmedAt ?? r.userUpdatedAt) : null;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        position: r.position,
        companyUrl: r.companyUrl,
        source: r.source,
        invitedAt: r.invitedAt ? r.invitedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        state,
        userId: r.userId,
        acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
      };
    }),
  };
});

// Signs a fresh token and stamps `invited_at`. Re-issuing on a row that
// already has `invited_at` produces a new token (helpful when the user
// lost the link) — we do NOT bump `invited_at` in that case so the
// timestamp keeps the original outreach moment.
const issueInvite = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const db = getDb();
    const found = await db.select().from(waitlist).where(eq(waitlist.id, data.id)).limit(1);
    const row = found[0];
    if (!row) {
      throw new Error("waitlist row not found");
    }
    const token = signInviteToken({ id: row.id, email: row.email });

    // Pre-create the users row. Better Auth's magic-link plugin runs with
    // `disableSignUp: true` (no self-serve signup in private beta), so the
    // user must exist before they verify the link. Insert is idempotent on
    // email — re-issuing on an already-invited row is a no-op here.
    await db
      .insert(users)
      .values({ email: row.email, status: "pending" })
      .onConflictDoNothing({ target: users.email });

    let invitedAt = row.invitedAt;
    if (!invitedAt) {
      const now = new Date();
      await db.update(waitlist).set({ invitedAt: now }).where(eq(waitlist.id, row.id));
      invitedAt = now;
    }

    const url = `${env.BETTER_AUTH_URL}/signup?invite=${token}`;
    logger.info(
      { admin: session.user.email, target: row.email, reissue: row.invitedAt !== null },
      "invite_issued",
    );
    return { url, invitedAt: invitedAt.toISOString() };
  });

export const Route = createFileRoute("/admin/waitlist")({
  validateSearch: filterSchema,
  loader: async () => listWaitlist(),
  component: AdminWaitlistPage,
});

const FILTERS: { value: z.infer<typeof filterSchema>["state"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "waitlist", label: "Waitlist" },
  { value: "invited", label: "Invited" },
  { value: "accepted", label: "Accepted" },
];

function AdminWaitlistPage() {
  const { rows } = Route.useLoaderData();
  const { state: stateFilter } = Route.useSearch();
  const counts = {
    all: rows.length,
    waitlist: rows.filter((r) => r.state === "waitlist").length,
    invited: rows.filter((r) => r.state === "invited").length,
    accepted: rows.filter((r) => r.state === "accepted").length,
  };
  const filtered = stateFilter === "all" ? rows : rows.filter((r) => r.state === stateFilter);

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Waitlist</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? "signup" : "signups"} · newest first
            </p>
          </div>
        </header>

        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter by status">
          {FILTERS.map((f) => {
            const active = stateFilter === f.value;
            const count = counts[f.value];
            return (
              <Link
                key={f.value}
                to="/admin/waitlist"
                search={{ state: f.value }}
                replace
                className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-xs uppercase tracking-[0.1em] transition-colors ${
                  active
                    ? "border-ink bg-ink text-paper"
                    : "border-ink-line bg-paper-warm text-text-muted hover:border-ink hover:text-text"
                }`}
              >
                {f.label}
                <span
                  className={`font-mono text-[10px] ${active ? "text-paper/70" : "text-text-muted"}`}
                >
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            {rows.length === 0
              ? "Nobody has joined the waitlist yet."
              : "No rows match this filter."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-line rounded-2xl border border-ink-line bg-paper-warm">
            {filtered.map((row: WaitlistRow) => (
              <WaitlistRowItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function WaitlistRowItem({ row }: { row: WaitlistRow }) {
  const router = useRouter();
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "issuing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onIssue() {
    setState("issuing");
    setError(null);
    setCopied(false);
    try {
      const { url } = await issueInvite({ data: { id: row.id } });
      setIssuedUrl(url);
      setState("idle");
      router.invalidate();
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
