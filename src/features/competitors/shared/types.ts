export type CompetitorView = {
  id: string;
  name: string;
  homepageUrl: string;
  rssUrl: string | null;
};

// Row shape returned by `listCompetitorsForAdmin` (server) and consumed by
// admin UI + health-flag classifier. Lives in `shared/` so isomorphic code
// (the health-flags classifier, its tests) can reference it without
// pulling the server module into the client bundle.
export type CompetitorAdminRow = {
  id: string;
  name: string;
  homepageUrl: string;
  rssUrl: string | null;
  phSlug: string | null;
  pricingUrl: string | null;
  createdAt: string;
  trackedBy: number;
  rawItems7d: number;
  lastIngestedAt: string | null;
};
