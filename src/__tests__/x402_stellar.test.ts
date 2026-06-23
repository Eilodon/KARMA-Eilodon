import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarX402Plugin, stellarX402PaymentOption } from "../plugins/x402_stellar.js";
import { deriveStellarKeypair } from "../lib/stellar/keypair.js";

const FACILITATOR = "https://www.x402.org/facilitator";
const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";

// Deterministic Stellar keypair for tests — derived from a known secp256k1-shaped seed.
const SECP_SEED = new Uint8Array(32).fill(0x37);
const TEST_KEYPAIR = deriveStellarKeypair(SECP_SEED);

function newPlugin() {
  // Inject the keypair lookup so tests never touch the real keystore manager.
  return new StellarX402Plugin(FACILITATOR, () => TEST_KEYPAIR);
}

describe("StellarX402Plugin metadata (T7)", () => {
  it("declares rail=x402 and the two Stellar networks", () => {
    const p = newPlugin();
    expect(p.rail).toBe("x402");
    expect(p.id).toBe("x402-stellar");
    expect(p.networks).toEqual([TESTNET, PUBNET]);
  });
});

describe("StellarX402Plugin.quote (T7)", () => {
  it("converts a decimal price into USDC smallest units (7 decimals)", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "0.01",
      asset: "",
      payTo: "GD...",
      network: TESTNET,
    });
    expect(q.rail).toBe("x402");
    expect(q.network).toBe(TESTNET);
    expect(q.price).toBe("100000"); // 0.01 USDC × 10^7
    expect(q.facilitatorUrl).toBe(FACILITATOR);
  });

  it("passes through a pre-formatted smallest-unit string unchanged", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "250000",
      asset: "",
      payTo: "GD...",
      network: TESTNET,
    });
    expect(q.price).toBe("250000");
  });

  it("defaults USDC contract address by network", async () => {
    const p = newPlugin();
    const qTest = await p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "G", network: TESTNET });
    const qPub = await p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "G", network: PUBNET });
    // Both are 56-char Stellar C-addresses (USDC contract) — distinct per network.
    expect(qTest.asset).toMatch(/^C[A-Z0-9]{55}$/);
    expect(qPub.asset).toMatch(/^C[A-Z0-9]{55}$/);
    expect(qTest.asset).not.toBe(qPub.asset);
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    await expect(
      p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "G", network: "ethereum:1" }),
    ).rejects.toThrow(/unsupported network/);
  });
});

describe("StellarX402Plugin.pay (T7)", () => {
  it("uses the agent's Stellar Keypair to build the signer and returns a receipt", async () => {
    const p = newPlugin();
    const receipt = await p.pay(
      { skillId: "1", price: "0.01", asset: "", payTo: "GDSTELLARFAKEPAYEEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", network: TESTNET },
      { agentId: "agent-alpha" },
    );
    expect(receipt.rail).toBe("x402");
    expect(receipt.network).toBe(TESTNET);
    expect(receipt.payer).toBe(TEST_KEYPAIR.publicKey());
    expect(receipt.amount).toBe("100000");
    expect(receipt.facilitatorRef).toBe(FACILITATOR);
  });

  it("rejects an unsupported network before touching the keystore", async () => {
    let calls = 0;
    const p = new StellarX402Plugin(FACILITATOR, () => {
      calls += 1;
      return TEST_KEYPAIR;
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: "G", network: "ethereum:1" },
        { agentId: "agent-alpha" },
      ),
    ).rejects.toThrow(/unsupported network/);
    expect(calls).toBe(0); // fail-fast — no keystore access
  });

  it("propagates a not-found agent error from the lookup", async () => {
    const p = new StellarX402Plugin(FACILITATOR, () => {
      throw new Error("[KARMA] Agent not found in keystore: agent-zeta");
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: "G", network: TESTNET },
        { agentId: "agent-zeta" },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("StellarX402Plugin.verify (T7)", () => {
  const baseReceipt = {
    rail: "x402" as const,
    payer: Keypair.random().publicKey(),
    payee: Keypair.random().publicKey(),
    amount: "100000",
    asset: "USDC-PLACEHOLDER",
    network: TESTNET,
    facilitatorRef: FACILITATOR,
  };

  it("accepts a structurally well-formed receipt", async () => {
    const p = newPlugin();
    expect(await p.verify(baseReceipt)).toBe(true);
  });

  it("rejects a non-x402 rail", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, rail: "escrow" })).toBe(false);
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, network: "ethereum:1" })).toBe(false);
  });

  it("rejects a malformed Stellar payer address", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, payer: "not-a-stellar-address" })).toBe(false);
  });

  it("rejects empty amount or payee", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, amount: "" })).toBe(false);
    expect(await p.verify({ ...baseReceipt, payee: "" })).toBe(false);
  });
});

describe("stellarX402PaymentOption (T7)", () => {
  it("defaults to testnet/USDC", () => {
    const opt = stellarX402PaymentOption();
    expect(opt).toEqual({ rail: "x402", network: TESTNET, asset: expect.any(String) });
  });

  it("respects the network override", () => {
    const opt = stellarX402PaymentOption(PUBNET);
    expect(opt.network).toBe(PUBNET);
    expect(opt.asset.length).toBeGreaterThan(40);
  });
});
