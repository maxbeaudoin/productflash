import { describe, expect, test } from "vitest";
import { type DiscoveryToolContext, DISCOVERY_TOOL_NAMES, executeTool } from "./tools";

// Validation-path tests for the discovery tools. The happy path of
// fetch_page / fetch_sitemap / probe_rss / record_source talks to Firecrawl
// / safeFetch / Postgres and is exercised by the smoke runner against a real
// competitor — these tests cover the in-band error envelope so the agent
// always sees a structured failure instead of an exception.

const CTX: DiscoveryToolContext = {
  competitorId: "11111111-1111-1111-1111-111111111111",
  competitorName: "Acme",
  homepageUrl: "https://acme.example",
};

describe("discovery tools — dispatch", () => {
  test("unknown tool name returns isError", async () => {
    const out = await executeTool(CTX, "no_such_tool", {});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Unknown tool");
  });

  test("all advertised tools are dispatched (no 'unknown tool' for canonical names)", async () => {
    expect(DISCOVERY_TOOL_NAMES).toEqual([
      "fetch_page",
      "fetch_sitemap",
      "probe_rss",
      "record_source",
      "finish",
    ]);
  });
});

describe("discovery tools — finish", () => {
  test("finish carries the terminal flag and summary", async () => {
    const out = await executeTool(CTX, "finish", { summary: "found 3 sources" });
    expect(out.isError).toBe(false);
    expect(out.finished).toBe(true);
    expect(out.finishSummary).toBe("found 3 sources");
    expect(out.content).toContain("found 3 sources");
  });

  test("finish without a summary still terminates", async () => {
    const out = await executeTool(CTX, "finish", {});
    expect(out.finished).toBe(true);
    expect(out.finishSummary).toBe("");
  });
});

describe("discovery tools — fetch_page validation", () => {
  test("rejects missing url", async () => {
    const out = await executeTool(CTX, "fetch_page", {});
    expect(out.isError).toBe(true);
    expect(out.content).toContain("requires a url");
  });

  test("rejects non-http scheme", async () => {
    const out = await executeTool(CTX, "fetch_page", { url: "file:///etc/passwd" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("http(s)");
  });
});

describe("discovery tools — fetch_sitemap validation", () => {
  test("rejects missing url", async () => {
    const out = await executeTool(CTX, "fetch_sitemap", {});
    expect(out.isError).toBe(true);
  });

  test("rejects non-http scheme", async () => {
    const out = await executeTool(CTX, "fetch_sitemap", { url: "gopher://example.com" });
    expect(out.isError).toBe(true);
  });
});

describe("discovery tools — probe_rss validation", () => {
  test("rejects missing url", async () => {
    const out = await executeTool(CTX, "probe_rss", {});
    expect(out.isError).toBe(true);
  });

  test("rejects non-http scheme", async () => {
    const out = await executeTool(CTX, "probe_rss", { url: "javascript:alert(1)" });
    expect(out.isError).toBe(true);
  });
});

describe("discovery tools — record_source validation", () => {
  test("rejects missing fields", async () => {
    const out = await executeTool(CTX, "record_source", {
      source_type: "rss",
      url_or_handle: "",
      rationale: "",
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("requires");
  });

  test("rejects unknown source_type", async () => {
    const out = await executeTool(CTX, "record_source", {
      source_type: "github_releases",
      url_or_handle: "https://example.com/feed",
      rationale: "test",
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("unknown source_type");
  });

  test("rss source_type rejects @handle (must be URL)", async () => {
    const out = await executeTool(CTX, "record_source", {
      source_type: "rss",
      url_or_handle: "@acme",
      rationale: "test",
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("must be http");
  });

  test("webpage source_type rejects non-URL", async () => {
    const out = await executeTool(CTX, "record_source", {
      source_type: "webpage",
      url_or_handle: "@acme",
      rationale: "test",
    });
    expect(out.isError).toBe(true);
  });
});
