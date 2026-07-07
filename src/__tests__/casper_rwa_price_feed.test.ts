import { describe, it, expect, vi } from "vitest";
import { fetchBtcUsdPrice } from "../lib/casper/rwa_price_feed.js";

describe("fetchBtcUsdPrice (T13-live)", () => {
  it("parses a successful CoinGecko response into a 2-decimal price string", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ bitcoin: { usd: 63072.4 } }),
    })) as unknown as typeof fetch;

    const quote = await fetchBtcUsdPrice(fakeFetch);

    expect(quote).toMatchObject({ feed: "BTC/USD", price: "63072.40", source: "coingecko" });
    expect(quote.timestamp).toBeGreaterThan(0);
  });

  it("falls back to a fixed price (logged, not silent) on a non-OK HTTP status", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await fetchBtcUsdPrice(fakeFetch);

    expect(quote).toMatchObject({ feed: "BTC/USD", price: "42000.50", source: "fallback" });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("falls back on a malformed response body", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: true, json: async () => ({ nonsense: true }) })) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchBtcUsdPrice(fakeFetch)).source).toBe("fallback");
  });

  it("falls back if fetch itself throws (network error)", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchBtcUsdPrice(fakeFetch)).source).toBe("fallback");
  });
});
