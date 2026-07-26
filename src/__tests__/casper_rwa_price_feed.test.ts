import { describe, it, expect, vi } from "vitest";
import { fetchBtcUsdPrice, fetchUsTreasuryYield } from "../lib/casper/rwa_price_feed.js";

describe("fetchBtcUsdPrice (T13-live)", () => {
  it("parses a successful CoinGecko response into a 2-decimal price string", async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ bitcoin: { usd: 63072.4 } }),
    })) as unknown as typeof fetch;

    const quote = await fetchBtcUsdPrice(fakeFetch);

    expect(quote).toMatchObject({ feed: "BTC/USD", price: "63072.40", source: "coingecko" });
    expect(quote.timestamp).toBeGreaterThan(0);
    expect(quote.rawPayloadText).toBe(JSON.stringify({ bitcoin: { usd: 63072.4 } }));
    expect(quote.sourceUrl).toContain("coingecko.com");
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
    const fakeFetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ nonsense: true }) })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchBtcUsdPrice(fakeFetch)).source).toBe("fallback");
    warnSpy.mockRestore();
  });

  it("falls back if fetch itself throws (network error)", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchBtcUsdPrice(fakeFetch)).source).toBe("fallback");
    warnSpy.mockRestore();
  });
});

describe("fetchUsTreasuryYield (T13-live)", () => {
  it("parses a successful US Treasury Fiscal Data response into a 2-decimal yield string", async () => {
    // Real shape verified against api.fiscaldata.treasury.gov/.../v2/accounting/od/avg_interest_rates
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          data: [
            {
              record_date: "2026-06-30",
              security_type_desc: "Marketable",
              security_desc: "Treasury Bills",
              avg_interest_rate_amt: "3.706",
              src_line_nbr: "1",
            },
          ],
          meta: { count: 1 },
        }),
    })) as unknown as typeof fetch;

    const quote = await fetchUsTreasuryYield(fakeFetch);

    expect(quote).toMatchObject({ feed: "UST-BILLS/AVG-YIELD", price: "3.71", source: "ustreasury" });
    expect(quote.timestamp).toBeGreaterThan(0);
    expect(quote.rawPayloadText.length).toBeGreaterThan(0);
    expect(quote.sourceUrl).toContain("fiscaldata.treasury.gov");
  });

  it("falls back to a fixed yield (logged, not silent) on a non-OK HTTP status", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await fetchUsTreasuryYield(fakeFetch);

    expect(quote).toMatchObject({ feed: "UST-BILLS/AVG-YIELD", price: "4.25", source: "fallback" });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("falls back on a malformed response body", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ data: [] }) })) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchUsTreasuryYield(fakeFetch)).source).toBe("fallback");
    warnSpy.mockRestore();
  });

  it("falls back if fetch itself throws (network error)", async () => {
    const fakeFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await fetchUsTreasuryYield(fakeFetch)).source).toBe("fallback");
    warnSpy.mockRestore();
  });

  it("falls back on a real AbortSignal timeout, not just a generic throw — the actual live scenario documented in DEMO_CASPER.md", async () => {
    const fakeFetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Real fetch signature is `fetchImpl(url, { signal: AbortSignal.timeout(5_000) })` — trigger
    // that same abort mechanism directly rather than waiting 5s, by aborting a manual controller
    // wired the same way `AbortSignal.timeout` fires internally.
    const controller = new AbortController();
    const quotePromise = fetchUsTreasuryYield(((url: string) =>
      fakeFetch(url, { signal: controller.signal })) as unknown as typeof fetch);
    controller.abort();
    const quote = await quotePromise;

    expect(quote.source).toBe("fallback");
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
