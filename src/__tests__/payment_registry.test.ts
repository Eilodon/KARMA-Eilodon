import { describe, it, expect } from "vitest";
import { PaymentPluginRegistry } from "../lib/payment/registry.js";
import type { IPaymentPlugin, PaymentReceipt, PaymentRequest, PaymentQuote } from "../lib/payment/plugin.js";

/** Minimal stub plugin — only the surface PaymentPluginRegistry interacts with. */
function stub(id: string, rail: "x402" | "escrow", networks: readonly string[]): IPaymentPlugin {
  return {
    id,
    rail,
    networks,
    quote: async (req: PaymentRequest): Promise<PaymentQuote> => ({
      rail,
      network: req.network,
      asset: req.asset,
      price: req.price,
    }),
    pay: async (req: PaymentRequest): Promise<PaymentReceipt> => ({
      rail,
      payer: "0xpayer",
      payee: req.payTo,
      amount: req.price,
      asset: req.asset,
      network: req.network,
    }),
    verify: async () => true,
  };
}

describe("PaymentPluginRegistry", () => {
  it("registers and lists plugins", () => {
    const r = new PaymentPluginRegistry();
    const a = stub("x402-stellar", "x402", ["stellar:testnet"]);
    const b = stub("x402-casper", "x402", ["casper:testnet"]);
    r.register(a);
    r.register(b);
    expect(r.list().map((p) => p.id).sort()).toEqual(["x402-casper", "x402-stellar"]);
  });

  it("rejects a duplicate id (fail-loud)", () => {
    const r = new PaymentPluginRegistry();
    r.register(stub("x402-stellar", "x402", ["stellar:testnet"]));
    expect(() => r.register(stub("x402-stellar", "x402", ["stellar:pubnet"]))).toThrow(/already registered/);
  });

  it("byRail returns only plugins of the given rail", () => {
    const r = new PaymentPluginRegistry();
    r.register(stub("x402-stellar", "x402", ["stellar:testnet"]));
    r.register(stub("escrow-pharos", "escrow", ["pharos:atlantic"]));
    expect(r.byRail("x402").map((p) => p.id)).toEqual(["x402-stellar"]);
    expect(r.byRail("escrow").map((p) => p.id)).toEqual(["escrow-pharos"]);
  });

  it("resolve matches on (rail, network) exactly", () => {
    const r = new PaymentPluginRegistry();
    const a = stub("x402-stellar", "x402", ["stellar:testnet", "stellar:pubnet"]);
    const b = stub("x402-casper", "x402", ["casper:testnet"]);
    r.register(a);
    r.register(b);
    expect(r.resolve("x402", "stellar:testnet")?.id).toBe("x402-stellar");
    expect(r.resolve("x402", "stellar:pubnet")?.id).toBe("x402-stellar");
    expect(r.resolve("x402", "casper:testnet")?.id).toBe("x402-casper");
    expect(r.resolve("x402", "ethereum:mainnet")).toBeNull();
    expect(r.resolve("escrow", "stellar:testnet")).toBeNull();
  });

  it("clear empties the registry", () => {
    const r = new PaymentPluginRegistry();
    r.register(stub("x402-stellar", "x402", ["stellar:testnet"]));
    r.clear();
    expect(r.list()).toEqual([]);
    // re-registering the same id post-clear succeeds (clear truly emptied state, not just hid it)
    expect(() => r.register(stub("x402-stellar", "x402", ["stellar:testnet"]))).not.toThrow();
  });
});
