import { useForm } from "@tanstack/react-form";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import {
  competitors as competitorsTable,
  itemScores,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import { requireSession } from "~/lib/auth-server";
import { getDb } from "~/lib/db";
import { addCompetitorFormSchema } from "~/lib/validation/competitor";
import { settingsProfileFormSchema } from "~/lib/validation/profile";
import { autodetectRSSForHomepage } from "~/sources/rss";

// /app/profile (#32). Standalone view + edit of the AI-generated profile.
//
// Distinct from /app/onboarding: that route is a one-shot terminal-feel
// streaming view tied to the FTE agent run and the confirm-and-continue
// flow. Here we're a plain settings screen — the user lands here from the
// header, tweaks fields, adds/removes competitors, and leaves.

type ProfileView = {
  position: string | null;
  companyName: string | null;
  companyUrl: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
};

type CompetitorView = {
  id: string;
  name: string;
  homepageUrl: string;
  rssUrl: string | null;
};

type ProfileLoaderData = {
  profile: ProfileView;
  competitors: CompetitorView[];
};

const loadProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProfileLoaderData> => {
    const session = await requireSession();
    const db = getDb();

    const [user] = await db
      .select({
        position: usersTable.position,
        companyName: usersTable.companyName,
        companyUrl: usersTable.companyUrl,
        ultimateGoal: usersTable.ultimateGoal,
        focusAreas: usersTable.focusAreas,
      })
      .from(usersTable)
      .where(eq(usersTable.id, session.user.id))
      .limit(1);

    const competitors = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(userCompetitors)
      .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
      .where(eq(userCompetitors.userId, session.user.id))
      .orderBy(asc(competitorsTable.name));

    return {
      profile: {
        position: user?.position ?? null,
        companyName: user?.companyName ?? null,
        companyUrl: user?.companyUrl ?? null,
        ultimateGoal: user?.ultimateGoal ?? null,
        focusAreas: user?.focusAreas ?? null,
      },
      competitors,
    };
  },
);

// Shared with the ProfileEditor below — see src/lib/validation/profile.ts.
const editSchema = settingsProfileFormSchema;

const editProfile = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => editSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const db = getDb();
    await db
      .update(usersTable)
      .set({
        position: data.position,
        companyName: data.companyName,
        companyUrl: data.companyUrl,
        ultimateGoal: data.ultimateGoal,
        focusAreas: data.focusAreas,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, session.user.id));
    // Profile fields are baked into Haiku scoring (#35). Drop the stale
    // cache so the next score run re-classifies under the new context.
    await db.delete(itemScores).where(eq(itemScores.userId, session.user.id));
    return { ok: true as const };
  });

// Shared with the AddCompetitorForm below — see src/lib/validation/competitor.ts.
const addCompetitorSchema = addCompetitorFormSchema;

const addCompetitor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => addCompetitorSchema.parse(data))
  .handler(async ({ data }): Promise<{ competitor: CompetitorView }> => {
    const session = await requireSession();
    const db = getDb();

    let rssUrl: string | null = null;
    try {
      rssUrl = await autodetectRSSForHomepage(data.homepageUrl);
    } catch {
      rssUrl = null;
    }

    // First-writer-wins on the competitors row: insert if the URL is new,
    // do nothing if it already exists. User-facing add MUST NOT overwrite
    // name/rss_url on an existing row — otherwise an authed user can
    // mutate every other user's view of "Notion" or repoint the shared
    // RSS feed at an attacker-controlled URL. The link from this user to
    // the (existing or newly-inserted) row goes through user_competitors.
    await db
      .insert(competitorsTable)
      .values({
        name: data.name,
        homepageUrl: data.homepageUrl,
        rssUrl,
      })
      .onConflictDoNothing({ target: competitorsTable.homepageUrl });

    const [c] = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(competitorsTable)
      .where(eq(competitorsTable.homepageUrl, data.homepageUrl))
      .limit(1);
    if (!c) throw new Error("competitor_upsert_failed");

    await db
      .insert(userCompetitors)
      .values({ userId: session.user.id, competitorId: c.id })
      .onConflictDoNothing();

    return { competitor: c };
  });

const removeCompetitorSchema = z.object({
  competitorId: z.string().uuid(),
});

const removeCompetitor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => removeCompetitorSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const db = getDb();
    await db
      .delete(userCompetitors)
      .where(
        and(
          eq(userCompetitors.userId, session.user.id),
          eq(userCompetitors.competitorId, data.competitorId),
        ),
      );
    return { ok: true as const };
  });

export const Route = createFileRoute("/app/profile")({
  loader: () => loadProfile(),
  component: ProfilePage,
});

function ProfilePage() {
  const loaded = Route.useLoaderData();
  const router = useRouter();

  const [profile, setProfile] = useState<ProfileView>(loaded.profile);
  const [competitors, setCompetitors] = useState<CompetitorView[]>(loaded.competitors);
  const [editing, setEditing] = useState(false);
  const [addingCompetitor, setAddingCompetitor] = useState(false);

  useEffect(() => {
    setProfile(loaded.profile);
    setCompetitors(loaded.competitors);
  }, [loaded.profile, loaded.competitors]);

  async function onSaveEdit(next: ProfileView) {
    await editProfile({
      data: {
        position: next.position ?? "",
        companyName: next.companyName ?? "",
        companyUrl: next.companyUrl ?? "",
        ultimateGoal: next.ultimateGoal ?? "",
        focusAreas: next.focusAreas ?? [],
      },
    });
    setProfile(next);
    setEditing(false);
    toast.success("Profile updated");
  }

  async function onAddCompetitor(input: { name: string; homepageUrl: string }) {
    const res = await addCompetitor({ data: input });
    setCompetitors((prev) =>
      prev.some((c) => c.id === res.competitor.id)
        ? prev
        : [...prev, res.competitor].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAddingCompetitor(false);
    toast.success(
      res.competitor.rssUrl
        ? `Added ${res.competitor.name} · RSS detected`
        : `Added ${res.competitor.name}`,
    );
  }

  async function onRemoveCompetitor(competitor: CompetitorView) {
    const previous = competitors;
    setCompetitors((prev) => prev.filter((c) => c.id !== competitor.id));
    try {
      await removeCompetitor({ data: { competitorId: competitor.id } });
      toast.success(`Removed ${competitor.name}`);
    } catch {
      setCompetitors(previous);
      toast.error("Could not remove competitor");
      await router.invalidate();
    }
  }

  return (
    <main className="mx-auto max-w-[920px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          Profile
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          Tune what your analyst watches for.
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          Edit your role, goal, and focus areas; add or drop competitors. Changes land in tomorrow's
          digest.
        </p>
      </header>

      {editing ? (
        <ProfileEditor initial={profile} onCancel={() => setEditing(false)} onSave={onSaveEdit} />
      ) : (
        <ProfileCard profile={profile} onEdit={() => setEditing(true)} />
      )}

      <section className="mt-10">
        <CompetitorsList
          competitors={competitors}
          addingCompetitor={addingCompetitor}
          onShowAdd={() => setAddingCompetitor(true)}
          onHideAdd={() => setAddingCompetitor(false)}
          onAddCompetitor={onAddCompetitor}
          onRemoveCompetitor={onRemoveCompetitor}
        />
      </section>
    </main>
  );
}

// ---- profile card ----------------------------------------------------

function ProfileCard({ profile, onEdit }: { profile: ProfileView; onEdit: () => void }) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Your profile</strong> · used to score and
          synthesize each daily brief
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-9 items-center gap-2 rounded-pill border border-[#2a2a38] px-4 text-xs font-semibold uppercase tracking-[0.1em] text-white hover:bg-ink/40"
        >
          Edit
        </button>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <div className="grid gap-6 md:grid-cols-2">
          <DetailRow label="Role" value={profile.position} />
          <DetailRow label="Company" value={profile.companyName} />
        </div>
        <DetailRow label="Company URL" value={profile.companyUrl} mono />
        <DetailRow label="Goal" value={profile.ultimateGoal} />
        <FocusAreas areas={profile.focusAreas} />
      </div>
    </div>
  );
}

// Comma-separated focusAreas string → validated array — same trick as
// /app/onboarding's profile editor.
const profileEditFormSchema = settingsProfileFormSchema.extend({
  focusAreas: z.string().transform((v, ctx) => {
    const parsed = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const result = settingsProfileFormSchema.shape.focusAreas.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Add at least one focus area.",
      });
      return z.NEVER;
    }
    return result.data;
  }),
});

function ProfileEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: ProfileView;
  onCancel: () => void;
  onSave: (next: ProfileView) => Promise<void> | void;
}) {
  const form = useForm({
    defaultValues: {
      position: initial.position ?? "",
      companyName: initial.companyName ?? "",
      companyUrl: initial.companyUrl ?? "",
      ultimateGoal: initial.ultimateGoal ?? "",
      focusAreas: (initial.focusAreas ?? []).join(", "),
    },
    validators: { onChange: profileEditFormSchema },
    onSubmit: async ({ value }) => {
      const parsed = profileEditFormSchema.safeParse(value);
      if (!parsed.success) return;
      try {
        await onSave(parsed.data);
      } catch {
        toast.error("Could not save changes. Try again.");
        throw new Error("save_failed");
      }
    },
  });

  const labelClass = "text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]";
  const inputClass =
    "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";
  const urlInputClass =
    "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 font-mono text-sm text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";
  const textareaClass =
    "min-h-[88px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 py-3 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5 text-[13px] text-[#888]">
        <strong className="font-semibold text-white">Edit profile</strong> · change anything that's
        drifted
      </div>

      <div className="grid gap-5 px-7 py-7">
        <form.Field name="position">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Role">
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="companyName">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Company">
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="companyUrl">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Company URL">
              <input
                id={field.name}
                type="url"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                placeholder="https://your-company.com"
                className={urlInputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="ultimateGoal">
          {(field) => (
            <FieldShell field={field} labelClassName={labelClass} label="Goal">
              <textarea
                id={field.name}
                rows={3}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={textareaClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="focusAreas">
          {(field) => (
            <FieldShell
              field={field}
              labelClassName={labelClass}
              label={
                <span className="inline-flex items-center gap-2">
                  Focus areas
                  <span className="rounded-pill bg-accent/10 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
                    comma separated
                  </span>
                </span>
              }
            >
              <input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <form.Subscribe
          selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-11 items-center gap-2 rounded-pill bg-accent px-6 text-sm font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        {label}
      </div>
      <div className={`text-[15px] text-white ${mono ? "font-mono text-sm" : ""}`}>
        {value && value.length > 0 ? value : <span className="text-[#666]">—</span>}
      </div>
    </div>
  );
}

function FocusAreas({ areas }: { areas: string[] | null }) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        Focus areas
      </div>
      <div className="flex flex-wrap gap-2">
        {(areas ?? []).map((area) => (
          <span
            key={area}
            className="rounded-pill bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent"
          >
            {area}
          </span>
        ))}
        {(areas ?? []).length === 0 ? <span className="text-[15px] text-[#666]">—</span> : null}
      </div>
    </div>
  );
}

// ---- competitors -----------------------------------------------------

function CompetitorsList({
  competitors,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: {
  competitors: CompetitorView[];
  addingCompetitor: boolean;
  onShowAdd: () => void;
  onHideAdd: () => void;
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>;
  onRemoveCompetitor: (competitor: CompetitorView) => Promise<void>;
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Competitors</strong> · {competitors.length}{" "}
          tracked
        </div>
        {!addingCompetitor ? (
          <button
            type="button"
            onClick={onShowAdd}
            className="inline-flex h-9 items-center gap-[6px] rounded-pill border border-[#2a2a38] px-4 text-xs font-semibold uppercase tracking-[0.1em] text-white hover:bg-ink/40"
          >
            <span aria-hidden>+</span> Add
          </button>
        ) : null}
      </div>

      <div className="px-7 py-7">
        {competitors.length === 0 && !addingCompetitor ? (
          <div className="rounded-md border border-dashed border-[#2a2a38] px-4 py-8 text-center text-[14px] text-[#666]">
            No competitors yet. Add one to start tracking.
          </div>
        ) : null}

        {competitors.length > 0 ? (
          <ul className="divide-y divide-[#2a2a38] overflow-hidden rounded-md border border-[#2a2a38]">
            {competitors.map((c) => (
              <CompetitorRow key={c.id} competitor={c} onRemove={() => onRemoveCompetitor(c)} />
            ))}
          </ul>
        ) : null}

        {addingCompetitor ? (
          <div className={competitors.length > 0 ? "mt-4" : ""}>
            <AddCompetitorForm onCancel={onHideAdd} onSubmit={onAddCompetitor} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CompetitorRow({
  competitor,
  onRemove,
}: {
  competitor: CompetitorView;
  onRemove: () => void | Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <li className="group flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">{competitor.name}</div>
        <a
          href={competitor.homepageUrl}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-[11px] text-[#666] hover:text-accent"
        >
          {competitor.homepageUrl}
        </a>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {competitor.rssUrl ? (
          <a
            href={competitor.rssUrl}
            target="_blank"
            rel="noreferrer"
            title={competitor.rssUrl}
            className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent hover:bg-accent/25"
          >
            rss
          </a>
        ) : null}
        <button
          type="button"
          onClick={async () => {
            setRemoving(true);
            try {
              await onRemove();
            } finally {
              setRemoving(false);
            }
          }}
          disabled={removing}
          aria-label={`Remove ${competitor.name}`}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-lg leading-none text-[#666] transition-colors hover:border-coral/40 hover:bg-coral/10 hover:text-coral disabled:opacity-40"
        >
          ×
        </button>
      </div>
    </li>
  );
}

function AddCompetitorForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: { name: string; homepageUrl: string }) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: { name: "", homepageUrl: "" },
    validators: { onChange: addCompetitorFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await onSubmit(value);
        formApi.reset();
      } catch {
        toast.error("Could not add competitor. Try again.");
        throw new Error("add_competitor_failed");
      }
    },
  });

  const inputClass =
    "h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent aria-invalid:border-coral aria-invalid:focus:border-coral";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="grid gap-3 rounded-md border border-[#2a2a38] bg-ink/40 px-4 py-4"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <form.Field name="name">
          {(field) => (
            <FieldShell field={field} label="" labelClassName="sr-only">
              <input
                id={field.name}
                type="text"
                placeholder="Notion"
                value={field.state.value}
                autoFocus
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                aria-label="Competitor name"
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="homepageUrl">
          {(field) => (
            <FieldShell field={field} label="" labelClassName="sr-only">
              <input
                id={field.name}
                type="text"
                inputMode="url"
                placeholder="https://notion.so"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                aria-label="Competitor homepage URL"
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form.Subscribe
          selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-10 items-center gap-2 rounded-pill bg-accent px-5 text-sm font-semibold text-ink hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting ? "Adding…" : "Add competitor"}
              </button>
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="inline-flex h-10 items-center gap-2 rounded-pill border border-[#2a2a38] px-4 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
        </form.Subscribe>
        <span className="text-[11px] uppercase tracking-[0.1em] text-[#666]">
          we'll auto-detect RSS
        </span>
      </div>
    </form>
  );
}
