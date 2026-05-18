import type { FteEventRow, JsonValue } from "./fte-event";

export function computeLiveStatus(events: FteEventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "tool_use" || e.kind === "server_tool_use") {
      return humanizeToolUse(e);
    }
  }
  return events.length > 0 ? "Getting started…" : null;
}

export function humanizeToolUse(e: FteEventRow): string {
  const name = typeof e.payload.name === "string" ? e.payload.name : "";
  const rawInput = e.payload.input;
  const input: Record<string, JsonValue> =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, JsonValue>)
      : {};
  switch (name) {
    case "fetch_url": {
      const url = typeof input.url === "string" ? input.url : "";
      const host = prettyHost(url);
      return host ? `Reading ${host}` : "Reading a page";
    }
    case "discover_rss": {
      const url = typeof input.homepage_url === "string" ? input.homepage_url : "";
      const host = prettyHost(url);
      return host ? `Looking for RSS on ${host}` : "Looking for an RSS feed";
    }
    case "add_competitor": {
      const n = typeof input.name === "string" ? input.name : "";
      return n ? `Adding ${n}` : "Adding a competitor";
    }
    case "save_profile":
      return "Saving your profile";
    case "web_search": {
      const q = typeof input.query === "string" ? input.query : "";
      return q ? `Searching “${q}”` : "Searching the web";
    }
    default:
      return name ? `Running ${name}` : "Thinking…";
  }
}

export function prettyHost(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
