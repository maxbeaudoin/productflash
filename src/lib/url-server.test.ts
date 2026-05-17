import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock safe-fetch before importing the module under test. Tests reach into
// the mock to seed per-call behavior. Pattern mirrors safe-fetch.test.ts so
// the env/logger side-imports stay quiet.
const envMock = vi.hoisted(() => ({
  env: { NODE_ENV: "test" as string, LOG_LEVEL: "silent" as string },
}));
vi.mock("./env", () => envMock);

const safeFetchMock = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  SafeFetchError: class SafeFetchError extends Error {
    readonly code: string;
    readonly url: string;
    constructor(code: string, url: string, message: string) {
      super(message);
      this.code = code;
      this.url = url;
    }
  },
}));
vi.mock("./safe-fetch", () => safeFetchMock);

const { verifyAndCanonicalize } = await import("./url-server");

describe("verifyAndCanonicalize", () => {
  beforeEach(() => {
    safeFetchMock.safeFetch.mockReset();
  });

  function res(init: { status: number; url?: string }): Response {
    const r = new Response(null, { status: init.status });
    if (init.url) Object.defineProperty(r, "url", { value: init.url });
    return r;
  }

  test("happy path: 200 HEAD returns the canonical URL from res.url", async () => {
    safeFetchMock.safeFetch.mockResolvedValueOnce(res({ status: 200, url: "https://acme.com" }));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
    expect(safeFetchMock.safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.safeFetch).toHaveBeenCalledWith(
      "https://acme.com",
      expect.objectContaining({ method: "HEAD", timeoutMs: 1500 }),
    );
  });

  test("redirect captured: returns the final-hop URL safeFetch landed on", async () => {
    // safeFetch follows redirects internally; its returned res.url is the
    // final hop. We verify the verifier surfaces that, not the input.
    safeFetchMock.safeFetch.mockResolvedValueOnce(
      res({ status: 200, url: "https://www.acme.com" }),
    );
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://www.acme.com");
  });

  test("405 on HEAD → retries with GET + Range; 200 returns canonical", async () => {
    safeFetchMock.safeFetch
      .mockResolvedValueOnce(res({ status: 405, url: "https://acme.com" }))
      .mockResolvedValueOnce(res({ status: 200, url: "https://acme.com" }));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
    expect(safeFetchMock.safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetchMock.safeFetch).toHaveBeenNthCalledWith(
      2,
      "https://acme.com",
      expect.objectContaining({ method: "GET", headers: { Range: "bytes=0-0" } }),
    );
  });

  test("206 Partial Content on GET-with-Range is treated as success", async () => {
    safeFetchMock.safeFetch
      .mockResolvedValueOnce(res({ status: 405, url: "https://acme.com" }))
      .mockResolvedValueOnce(res({ status: 206, url: "https://acme.com" }));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
  });

  test("timeout falls back to the input — never error the user", async () => {
    safeFetchMock.safeFetch.mockRejectedValue(
      new safeFetchMock.SafeFetchError("timeout", "https://acme.com", "timed out"),
    );
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
  });

  test("DNS failure falls back silently", async () => {
    safeFetchMock.safeFetch.mockRejectedValue(
      new safeFetchMock.SafeFetchError("dns_failure", "https://nope.invalid", "no host"),
    );
    const got = await verifyAndCanonicalize("https://nope.invalid");
    expect(got).toBe("https://nope.invalid");
  });

  test("private_address (SSRF reject) falls back silently — the row still gets written", async () => {
    safeFetchMock.safeFetch.mockRejectedValue(
      new safeFetchMock.SafeFetchError("private_address", "http://169.254.169.254", "private"),
    );
    const got = await verifyAndCanonicalize("http://169.254.169.254");
    expect(got).toBe("http://169.254.169.254");
  });

  test("404 falls back to the input (don't reject — site might gate HEAD on auth)", async () => {
    safeFetchMock.safeFetch.mockResolvedValueOnce(res({ status: 404, url: "https://acme.com" }));
    safeFetchMock.safeFetch.mockResolvedValueOnce(res({ status: 404, url: "https://acme.com" }));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
  });

  test("unexpected (non-SafeFetchError) throw is caught and falls back", async () => {
    safeFetchMock.safeFetch.mockRejectedValue(new Error("boom"));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
  });

  test("strips trailing slash on root path from canonical URL", async () => {
    safeFetchMock.safeFetch.mockResolvedValueOnce(res({ status: 200, url: "https://acme.com/" }));
    const got = await verifyAndCanonicalize("https://acme.com");
    expect(got).toBe("https://acme.com");
  });
});
