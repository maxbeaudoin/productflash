import type { CompetitorView } from "~/lib/server/competitor-fns";
import { AddCompetitorForm } from "./add-competitor-form";
import { CompetitorRow } from "./competitor-row";

type CompetitorsListProps = {
  competitors: CompetitorView[];
  addingCompetitor: boolean;
  onShowAdd: () => void;
  onHideAdd: () => void;
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>;
  onRemoveCompetitor: (competitor: CompetitorView) => Promise<void>;
  // `card` (default) = standalone card with its own chrome + shadow; used
  // on /app/profile. `inline` = embedded subsection that lives inside a
  // larger card (e.g. the onboarding profile preview).
  variant?: "card" | "inline";
};

export function CompetitorsList(props: CompetitorsListProps) {
  return props.variant === "inline" ? <InlineList {...props} /> : <CardList {...props} />;
}

function CardList({
  competitors,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: CompetitorsListProps) {
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

function InlineList({
  competitors,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: CompetitorsListProps) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
          Competitors
        </div>
        {!addingCompetitor ? (
          <button
            type="button"
            onClick={onShowAdd}
            className="inline-flex items-center gap-[6px] rounded-pill border border-[#2a2a38] px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-white hover:bg-ink/40"
          >
            <span aria-hidden>+</span> Add
          </button>
        ) : null}
      </div>

      {competitors.length === 0 && !addingCompetitor ? (
        <div className="rounded-md border border-dashed border-[#2a2a38] px-4 py-5 text-center text-[14px] text-[#666]">
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
        <AddCompetitorForm onCancel={onHideAdd} onSubmit={onAddCompetitor} />
      ) : null}
    </div>
  );
}
