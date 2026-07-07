/**
 * RWA price feed (T13-live) — a real quote from a public price API, not the hardcoded
 * "BTC/USD = 42000.50" stub the offline demos use. Best-effort: falls back to a fixed value
 * (clearly logged, never silent) if the network call fails, so a demo run never hard-crashes
 * on a flaky connection.
 */

const FALLBACK_PRICE_USD = "42000.50";

export interface RwaPriceQuote {
  feed: string;
  price: string;
  timestamp: number;
  source: "coingecko" | "fallback";
}

/** Real BTC/USD spot price from CoinGecko's public API (no key required). */
export async function fetchBtcUsdPrice(fetchImpl: typeof fetch = fetch): Promise<RwaPriceQuote> {
  try {
    const res = await fetchImpl("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`CoinGecko returned HTTP ${res.status}`);
    const body = (await res.json()) as { bitcoin?: { usd?: number } };
    const usd = body.bitcoin?.usd;
    if (typeof usd !== "number") throw new Error("CoinGecko response missing bitcoin.usd");
    return { feed: "BTC/USD", price: usd.toFixed(2), timestamp: Date.now(), source: "coingecko" };
  } catch (e) {
    console.warn(
      `[rwa-price-feed] live CoinGecko fetch failed (${e instanceof Error ? e.message : String(e)}), ` +
      `using fallback price — this demo run is NOT reflecting a real live quote.`,
    );
    return { feed: "BTC/USD", price: FALLBACK_PRICE_USD, timestamp: Date.now(), source: "fallback" };
  }
}
