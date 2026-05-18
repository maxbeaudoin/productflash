import type { FteEventRow } from "./fte-event";

export type Stats = {
  pagesRead: number;
  webSearches: number;
  competitorsAdded: number;
  elapsedMs: number | null;
};

export function findSaveProfileTs(events: FteEventRow[]): number | null {
  for (const e of events) {
    if (e.kind === "tool_use" && e.payload.name === "save_profile") {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}

export function buildStats(events: FteEventRow[]): Stats {
  let pagesRead = 0;
  let webSearches = 0;
  let competitorsAdded = 0;
  let startTs: number | null = null;
  let lastTs: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) {
      if (startTs === null) startTs = t;
      lastTs = t;
    }
    if (e.kind === "tool_result") {
      const name = typeof e.payload.name === "string" ? e.payload.name : "";
      if (name === "fetch_url" && !e.payload.error) pagesRead++;
      if (name === "add_competitor" && !e.payload.error) competitorsAdded++;
    } else if (e.kind === "server_tool_use") {
      webSearches++;
    }
  }
  return {
    pagesRead,
    webSearches,
    competitorsAdded,
    elapsedMs: startTs !== null && lastTs !== null ? lastTs - startTs : null,
  };
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
