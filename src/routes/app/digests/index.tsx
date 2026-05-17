import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq, sql } from "drizzle-orm";
import { useEffect, useMemo, useState } from "react";
import { digestItems, digests, users } from "~/db/schema";
import { requireSession } from "~/lib/auth-server";
import { getDb } from "~/lib/db";
import { deriveDigestPeriod } from "~/lib/digest-period";
import { computeNextDigestFor, formatRelativeUntil } from "~/lib/next-digest";

type DigestRow = {
  id: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  itemCount: number;
  peek: string | null;
};

const listDigests = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  const db = getDb();
  const [digestRows, profileRows] = await Promise.all([
    db
      .select({
        id: digests.id,
        createdAt: digests.createdAt,
        periodStart: digests.periodStart,
        periodEnd: digests.periodEnd,
        itemCount: digests.itemCount,
      })
      .from(digests)
      .where(eq(digests.userId, session.user.id))
      .orderBy(desc(digests.createdAt)),
    db.select({ tz: users.tz }).from(users).where(eq(users.id, session.user.id)).limit(1),
  ]);

  // Top-scored headline per digest — used as the list row peek. One round
  // trip via `DISTINCT ON`; Drizzle's correlated-subquery templating
  // doesn't carry the outer-query alias through, so we fan out in JS.
  let peeks = new Map<string, string>();
  if (digestRows.length) {
    const peekRows = await db.execute<{ digest_id: string; headline: string }>(sql`
      SELECT DISTINCT ON (${digestItems.digestId})
        ${digestItems.digestId} AS digest_id,
        ${digestItems.headline} AS headline
      FROM ${digestItems}
      WHERE ${digestItems.userId} = ${session.user.id}
      ORDER BY ${digestItems.digestId}, ${digestItems.score} DESC
    `);
    peeks = new Map(peekRows.rows.map((r) => [r.digest_id, r.headline]));
  }

  const userTz = profileRows[0]?.tz ?? null;

  return {
    rows: digestRows.map<DigestRow>((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      periodStart: r.periodStart ? r.periodStart.toISOString() : null,
      periodEnd: r.periodEnd ? r.periodEnd.toISOString() : null,
      itemCount: r.itemCount,
      peek: peeks.get(r.id) ?? null,
    })),
    // The forecast is computed on the client (NextDigestBanner) so we can
    // fall back to the browser-detected tz when `users.tz` is null —
    // server-side we don't know what zone the visitor is in.
    userTz,
  };
});

export const Route = createFileRoute("/app/digests/")({
  loader: async () => listDigests(),
  component: DigestsListPage,
});

// Poll cadence while waiting for the fast-path (#30) first digest. 4s keeps
// the brewing state responsive without hammering the DB; the fast path
// itself takes 1–5 min so the user sees several "still working" polls
// before the row lands.
const BREWING_POLL_MS = 4000;

function DigestsListPage() {
  const { rows, userTz } = Route.useLoaderData();
  const router = useRouter();
  const brewing = rows.length === 0;
  const [autoRoutedTo, setAutoRoutedTo] = useState<string | null>(null);

  // Brewing → poll the loader; when the first digest lands, jump straight
  // into it. We don't auto-route for users who already had a digest before
  // this mount — only the first-row case matches the fast-path UX.
  useEffect(() => {
    if (!brewing) return;
    const id = setInterval(() => {
      void router.invalidate();
    }, BREWING_POLL_MS);
    return () => clearInterval(id);
  }, [brewing, router]);

  useEffect(() => {
    if (rows.length === 0) return;
    const first = rows[0];
    if (autoRoutedTo === first.id) return;
    // Only auto-route if the page mounted in brewing state — i.e. this is the
    // user's first digest landing live. Returning users with existing
    // digests should stay on the list.
    if (!brewing) return;
    setAutoRoutedTo(first.id);
    void router.navigate({ to: "/app/digests/$digestId", params: { digestId: first.id } });
  }, [rows, brewing, autoRoutedTo, router]);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          Your digests
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          What your competitors did, day by day.
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          Newest first. Open one to read the full brief, react with 👍 / 👎 on anything
          load-bearing.
        </p>
      </header>

      {rows.length === 0 ? (
        <BrewingState />
      ) : (
        <>
          <NextDigestBanner userTz={userTz} />
          <DigestList rows={rows} />
        </>
      )}
    </main>
  );
}

// Anticipation card above the digest list. Forecasting runs on the client
// so we can fall back to the browser-detected tz when `users.tz` is null
// (legacy rows from before the signup form started capturing it). The
// forecast respects the per-TZ + Mon-Fri rules of the send dispatcher
// (#17), so on Friday after 7am local the banner reads "Monday at 7:00 AM".
function NextDigestBanner({ userTz }: { userTz: string | null }) {
  const [now, setNow] = useState(() => new Date());
  // Resolve the tz on the client so an empty users.tz still shows local
  // time. `useState(() => ...)` ensures we sample Intl exactly once on
  // mount and stay stable across re-renders.
  const [tz] = useState<string>(() => userTz ?? detectBrowserTz());
  const forecast = useMemo(() => computeNextDigestFor(tz, now), [tz, now]);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const relative = formatRelativeUntil(forecast.at, now);

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-card-lg border border-[#2a2a38] bg-ink-soft px-7 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-[7px] h-[6px] w-[6px] shrink-0 animate-pulse rounded-full bg-coral"
          style={{ boxShadow: "0 0 12px var(--color-coral)" }}
        />
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
            Next brief
          </div>
          <div className="mt-1 text-base font-semibold leading-[1.3] text-white">
            On the way {relative}.
          </div>
          <div className="mt-1 text-[13px] text-[#a8a8b8]">
            Lands <span className="font-mono text-xs text-white">{forecast.whenLabel}</span> ·
            in-app + email
          </div>
        </div>
      </div>
    </div>
  );
}

function detectBrowserTz(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.length > 0) return tz;
  } catch {
    // fall through
  }
  return "UTC";
}

function DigestList({ rows }: { rows: DigestRow[] }) {
  return (
    <ul className="divide-y divide-[#2a2a38] overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft">
      {rows.map((row) => (
        <DigestListRow key={row.id} row={row} />
      ))}
    </ul>
  );
}

function DigestListRow({ row }: { row: DigestRow }) {
  const period = deriveDigestPeriod({
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  });
  const created = new Date(row.createdAt);
  const fallbackDateLabel = created
    .toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .toUpperCase();
  const fallbackTimeLabel = created.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const metaLine =
    period.rangeLabel?.toUpperCase() ?? `${fallbackDateLabel} · ${fallbackTimeLabel}`;
  const kindBadge = period.kind === "catchup" ? "Catch-up" : null;
  const itemLabel =
    row.itemCount === 0
      ? "Nothing notable"
      : `${row.itemCount} ${row.itemCount === 1 ? "item" : "items"}`;
  const peekFallback =
    period.kind === "catchup" ? "Nothing notable this past week." : "Nothing notable overnight.";

  return (
    <li>
      <Link
        to="/app/digests/$digestId"
        params={{ digestId: row.id }}
        className="group flex items-start justify-between gap-6 px-7 py-5 transition-colors hover:bg-[#1a1a23]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 font-mono text-xs text-[#888]">
            <span>{metaLine}</span>
            {kindBadge ? (
              <span className="rounded-pill bg-coral/15 px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.12em] text-coral">
                {kindBadge}
              </span>
            ) : null}
          </div>
          <div className="mt-2 line-clamp-2 text-base font-semibold leading-[1.4] text-white">
            {row.peek ?? peekFallback}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <span className="rounded-pill bg-accent/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
            {itemLabel}
          </span>
          <span
            aria-hidden
            className="text-[#5a5a6a] transition-transform group-hover:translate-x-[2px] group-hover:text-white"
          >
            →
          </span>
        </div>
      </Link>
    </li>
  );
}

function BrewingState() {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.floor(elapsedMs / 1000);
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`;

  return (
    <div
      className="rounded-card-lg border border-[#2a2a38] bg-ink-soft px-7 py-16 text-center"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="mb-3 inline-flex items-center gap-[10px] text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
        <span
          aria-hidden
          className="h-[6px] w-[6px] animate-pulse rounded-full bg-coral"
          style={{ boxShadow: "0 0 12px var(--color-coral)" }}
        />
        Brewing your first brief
      </div>
      <h2 className="text-[clamp(22px,2.4vw,28px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
        Reading your competitors right now.
      </h2>
      <p className="mx-auto mt-3 max-w-[480px] text-[15px] text-[#a8a8b8]">
        Pulling RSS, scanning launches, scoring what matters. Usually 1–3 minutes. We'll jump you
        straight into the brief the moment it lands.
      </p>
      <div className="mt-6 inline-flex items-center gap-[8px] rounded-pill border border-[#2a2a38] bg-ink/40 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a8a8b8]">
        <span className="font-mono text-xs tracking-normal text-accent">{elapsed}</span>
        elapsed
      </div>
    </div>
  );
}
