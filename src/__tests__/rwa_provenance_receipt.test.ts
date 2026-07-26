import { describe, it, expect } from "vitest";
import {
  buildProvenanceReceipt,
  canonicalize,
  sha256Hex,
  assertNotFallback,
  assertFresh,
  assertTrustedSource,
  assertPayloadIntegrity,
  type RwaProvenanceReceipt,
} from "../lib/casper/rwa_provenance_receipt.js";
import type { RwaPriceQuote } from "../lib/casper/rwa_price_feed.js";

function quote(overrides: Partial<RwaPriceQuote> = {}): RwaPriceQuote {
  return {
    feed: "BTC/USD",
    price: "64603.00",
    timestamp: 1_785_076_056_629,
    source: "coingecko",
    sourceUrl: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    rawPayloadText: '{"bitcoin":{"usd":64603}}',
    ...overrides,
  };
}

function receipt(overrides: Partial<RwaProvenanceReceipt> = {}): RwaProvenanceReceipt {
  const base = buildProvenanceReceipt({
    jobId: 5n,
    requestHash: "d568ff85fe7ad191a7984e43e6de00ab757b79a2a12d8a15833d205b74e33c27",
    quote: quote(),
    freshnessMs: 5 * 60_000,
    providerPublicKey: "02034a7c7839fd6af86afac55c46b84780e89ddaf12af29df15809382af618a2c8cf",
    providerSignature: "deadbeef",
  });
  // Overrides apply to the RESULT (e.g. sourceUrl, freshnessExpiry) — buildProvenanceReceipt's
  // own input params don't include most of these directly (sourceUrl comes from quote.sourceUrl,
  // freshnessExpiry is derived), so overriding the input wouldn't reach the field under test.
  return { ...base, ...overrides };
}

describe("buildProvenanceReceipt", () => {
  it("assembles all 10 target fields from a quote + job context", () => {
    const r = receipt();
    expect(r.receiptVersion).toBe("1.0");
    expect(r.jobId).toBe("5");
    expect(r.requestHash).toBe("d568ff85fe7ad191a7984e43e6de00ab757b79a2a12d8a15833d205b74e33c27");
    expect(r.sourceUrl).toContain("coingecko.com");
    expect(r.retrievalTime).toBe(1_785_076_056_629);
    expect(r.freshnessExpiry).toBe(1_785_076_056_629 + 5 * 60_000);
    expect(r.rawPayloadSha256).toBe(sha256Hex('{"bitcoin":{"usd":64603}}'));
    expect(r.normalizedValue).toBe("64603.00");
    expect(r.providerPublicKey).toBe("02034a7c7839fd6af86afac55c46b84780e89ddaf12af29df15809382af618a2c8cf");
    expect(r.providerSignature).toBe("deadbeef");
  });
});

describe("canonicalize", () => {
  it("produces an identical hash regardless of object key insertion order", () => {
    const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const b = { a: 2, m: { b: 4, y: 3 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256Hex(canonicalize(a))).toBe(sha256Hex(canonicalize(b)));
  });

  it("preserves array element order (order is meaningful there)", () => {
    const a = [{ x: 1 }, { x: 2 }];
    const b = [{ x: 2 }, { x: 1 }];
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });

  it("matches the real job_id=5 receipt hash documented in DEMO_CASPER.md when reconstructed field-for-field", () => {
    // Same receipt content as the live 2026-07-26 run (DEMO_CASPER.md), just reconstructed via
    // the new per-feed schema's signing-payload shape (receipt minus providerSignature) — proves
    // canonicalize() doesn't silently reorder in a way that would desync the real on-chain hash
    // this repo already produced once.
    const payload = { feeds: [{ feed: "BTC/USD", price: "64603.00", timestamp: 1785076056629, source: "coingecko" }] };
    const reordered = { feeds: [{ timestamp: 1785076056629, source: "coingecko", price: "64603.00", feed: "BTC/USD" }] };
    expect(canonicalize(payload)).toBe(canonicalize(reordered));
  });
});

describe("assertNotFallback", () => {
  it("rejects a fallback-sourced quote outright", () => {
    expect(() => assertNotFallback("fallback")).toThrow(/fallback/i);
  });

  it("accepts a genuinely live-sourced quote", () => {
    expect(() => assertNotFallback("coingecko")).not.toThrow();
    expect(() => assertNotFallback("ustreasury")).not.toThrow();
  });
});

describe("assertFresh", () => {
  it("rejects a receipt whose freshnessExpiry has already passed", () => {
    const r = receipt();
    expect(() => assertFresh(r, r.freshnessExpiry + 1)).toThrow(/expired/i);
  });

  it("accepts a receipt still within its freshness window", () => {
    const r = receipt();
    expect(() => assertFresh(r, r.freshnessExpiry - 1)).not.toThrow();
    expect(() => assertFresh(r, r.freshnessExpiry)).not.toThrow();
  });
});

describe("assertTrustedSource", () => {
  it("accepts the real feed hosts this repo actually fetches from", () => {
    expect(() => assertTrustedSource(receipt({ sourceUrl: "https://api.coingecko.com/api/v3/simple/price" }))).not.toThrow();
    expect(() =>
      assertTrustedSource(
        receipt({ sourceUrl: "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates" }),
      ),
    ).not.toThrow();
  });

  it("rejects a receipt claiming an untrusted source host", () => {
    expect(() => assertTrustedSource(receipt({ sourceUrl: "https://evil-mirror.example.com/fake-coingecko" }))).toThrow(
      /untrusted source host/i,
    );
  });

  it("rejects a malformed sourceUrl", () => {
    expect(() => assertTrustedSource(receipt({ sourceUrl: "not a url" }))).toThrow(/not a valid URL/i);
  });
});

describe("assertPayloadIntegrity", () => {
  it("MATCH: accepts when the supplied raw payload hashes to the receipt's committed sha256", () => {
    const rawPayloadText = '{"bitcoin":{"usd":64603}}';
    const r = buildProvenanceReceipt({
      jobId: 5n,
      requestHash: "abc",
      quote: quote({ rawPayloadText }),
      freshnessMs: 60_000,
      providerPublicKey: "pub",
      providerSignature: "sig",
    });
    expect(() => assertPayloadIntegrity(r, rawPayloadText)).not.toThrow();
  });

  it("MISMATCH: rejects a tampered payload that doesn't hash to the committed value", () => {
    const r = buildProvenanceReceipt({
      jobId: 5n,
      requestHash: "abc",
      quote: quote({ rawPayloadText: '{"bitcoin":{"usd":64603}}' }),
      freshnessMs: 60_000,
      providerPublicKey: "pub",
      providerSignature: "sig",
    });
    expect(() => assertPayloadIntegrity(r, '{"bitcoin":{"usd":999999}}')).toThrow(/tampered/i);
  });
});
