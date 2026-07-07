import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, it, expect } from "vitest";
import {
  CasperX402Plugin,
  CASPER_MAINNET_CAIP2,
  CASPER_TESTNET_CAIP2,
  canonicalizeCasperPaymentPayload,
  casperX402PaymentOption,
  convertCsprToMotes,
  verifyCasperExactPayload,
  type CasperX402SignedPayload,
} from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey } from "../lib/casper/keypair.js";

const FACILITATOR = "https://x402-facilitator.casper.network";
const SECP_SEED = new Uint8Array(32).fill(0x42);
const TEST_KEYPAIR = deriveCasperPrivateKey(SECP_SEED);
const SECP_SEED_OTHER = new Uint8Array(32).fill(0x99);
const OTHER_KEYPAIR = deriveCasperPrivateKey(SECP_SEED_OTHER);

function newPlugin(opts: ConstructorParameters<typeof CasperX402Plugin>[2] = {}) {
  return new CasperX402Plugin(FACILITATOR, () => TEST_KEYPAIR, opts);
}

describe("CasperX402Plugin metadata (T11)", () => {
  it("declares rail=x402 and the two Casper networks", () => {
    const p = newPlugin();
    expect(p.rail).toBe("x402");
    expect(p.id).toBe("x402-casper");
    expect(p.networks).toEqual([CASPER_TESTNET_CAIP2, CASPER_MAINNET_CAIP2]);
  });
});

describe("convertCsprToMotes (T11)", () => {
  it("converts decimal CSPR into 9-decimal motes", () => {
    expect(convertCsprToMotes("0.01")).toBe("10000000"); // 0.01 CSPR × 10^9
    expect(convertCsprToMotes("1")).toBe("1");
    expect(convertCsprToMotes("1.000000001")).toBe("1000000001");
  });

  it("passes through pre-formatted smallest-unit strings unchanged", () => {
    expect(convertCsprToMotes("250000")).toBe("250000");
    expect(convertCsprToMotes("0")).toBe("0");
  });

  it("rejects more than 9 fractional digits (no silent truncation)", () => {
    expect(() => convertCsprToMotes("0.1234567890")).toThrow(/9 decimals/);
  });
});

describe("CasperX402Plugin.quote (T11)", () => {
  it("converts decimal CSPR into motes and surfaces the facilitator URL", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "0.01",
      asset: "",
      payTo: "account-hash-1111111111111111111111111111111111111111111111111111111111111111",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.rail).toBe("x402");
    expect(q.network).toBe(CASPER_TESTNET_CAIP2);
    expect(q.price).toBe("10000000");
    expect(q.asset).toBe("CSPR");
    expect(q.facilitatorUrl).toBe(FACILITATOR);
  });

  it("passes through a pre-formatted smallest-unit string", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "250000",
      asset: "",
      payTo: "x",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.price).toBe("250000");
  });

  it("respects an explicit asset override", async () => {
    const p = newPlugin();
    const q = await p.quote({
      skillId: "1",
      price: "0.01",
      asset: "USDC",
      payTo: "x",
      network: CASPER_TESTNET_CAIP2,
    });
    expect(q.asset).toBe("USDC");
  });

  it("rejects an unsupported network", async () => {
    const p = newPlugin();
    await expect(
      p.quote({ skillId: "1", price: "0.01", asset: "", payTo: "x", network: "ethereum:1" }),
    ).rejects.toThrow(/unsupported network/);
  });
});

describe("CasperX402Plugin.pay (T11)", () => {
  const PAYEE = "account-hash-2222222222222222222222222222222222222222222222222222222222222222";

  it("returns a receipt with payer = derived Casper account-hash + facilitatorRef", async () => {
    const p = newPlugin();
    const receipt = await p.pay(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );
    expect(receipt.rail).toBe("x402");
    expect(receipt.network).toBe(CASPER_TESTNET_CAIP2);
    expect(receipt.payer.startsWith("account-hash-")).toBe(true);
    expect(receipt.payer.slice("account-hash-".length)).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.amount).toBe("10000000");
    expect(receipt.asset).toBe("CSPR");
    expect(receipt.facilitatorRef).toBe(FACILITATOR);
    // The signed envelope is hex-only; not a real chain hash. Caller stamps it as `X-PAYMENT`.
    expect(receipt.txHash).toMatch(/^[0-9a-f]+$/);
  });

  it("produces a signature node:crypto verifies under the derived public key", async () => {
    // Lock the clock + nonce so we can reconstruct the canonical-JSON byte-for-byte.
    const NOW = 1_700_000_000_000;
    const NONCE = "ab".repeat(32);
    const p = new CasperX402Plugin(FACILITATOR, () => TEST_KEYPAIR, { now: () => NOW, nonce: () => NONCE });
    const receipt = await p.pay(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );

    // Rebuild what the facilitator hashes — same canonical-JSON the plugin signed over.
    const expectedPayload = {
      scheme: "exact" as const,
      network: CASPER_TESTNET_CAIP2,
      payer: receipt.payer,
      payee: PAYEE,
      amount: "10000000",
      asset: "CSPR",
      validAfter: NOW,
      validBefore: NOW + 5 * 60 * 1_000,
      nonce: NONCE,
    };
    const canonical = canonicalizeCasperPaymentPayload(expectedPayload);
    const sigDER = Buffer.from(receipt.txHash!, "hex");
    const pubKey = createPublicKey({ key: TEST_KEYPAIR.publicKey.toPem(), format: "pem" });
    expect(cryptoVerify("sha256", new TextEncoder().encode(canonical), pubKey, sigDER)).toBe(true);

    // And a different key cannot verify the same signature.
    const otherPub = createPublicKey({ key: OTHER_KEYPAIR.publicKey.toPem(), format: "pem" });
    expect(cryptoVerify("sha256", new TextEncoder().encode(canonical), otherPub, sigDER)).toBe(false);
  });

  it("rejects an unsupported network before touching the keystore", async () => {
    let calls = 0;
    const p = new CasperX402Plugin(FACILITATOR, () => {
      calls += 1;
      return TEST_KEYPAIR;
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: "ethereum:1" },
        { agentId: "agent-alpha" },
      ),
    ).rejects.toThrow(/unsupported network/);
    expect(calls).toBe(0); // fail-fast — no keystore access
  });

  it("propagates a not-found agent error from the lookup", async () => {
    const p = new CasperX402Plugin(FACILITATOR, () => {
      throw new Error("[KARMA] Agent not found in keystore: agent-zeta");
    });
    await expect(
      p.pay(
        { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
        { agentId: "agent-zeta" },
      ),
    ).rejects.toThrow(/not found/);
  });

  it("stamps a TTL window — validBefore = validAfter + ttlMs (default 5 min)", async () => {
    const NOW = 1_750_000_000_000;
    let signedJson = "";
    const p = new CasperX402Plugin(
      FACILITATOR,
      (id) => {
        const kp = TEST_KEYPAIR;
        return {
          ...kp,
          publicKey: kp.publicKey,
          sign(msg: Uint8Array) {
            signedJson = new TextDecoder().decode(msg);
            return kp.sign(msg);
          },
        } as typeof kp;
      },
      { now: () => NOW, nonce: () => "cd".repeat(32) },
    );
    await p.pay(
      { skillId: "1", price: "0.01", asset: "", payTo: PAYEE, network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-alpha" },
    );
    const obj = JSON.parse(signedJson) as { validAfter: number; validBefore: number };
    expect(obj.validAfter).toBe(NOW);
    expect(obj.validBefore).toBe(NOW + 5 * 60 * 1_000);
  });
});

describe("CasperX402Plugin.verify (T11)", () => {
  const baseReceipt = {
    rail: "x402" as const,
    payer: `account-hash-${"a".repeat(64)}`,
    payee: `account-hash-${"b".repeat(64)}`,
    amount: "10000000",
    asset: "CSPR",
    network: CASPER_TESTNET_CAIP2,
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

  it("rejects a malformed Casper payer (must be account-hash-...)", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, payer: "02deadbeef" })).toBe(false);
  });

  it("rejects empty amount or payee", async () => {
    const p = newPlugin();
    expect(await p.verify({ ...baseReceipt, amount: "" })).toBe(false);
    expect(await p.verify({ ...baseReceipt, payee: "" })).toBe(false);
  });
});

describe("casperX402PaymentOption (T11)", () => {
  it("defaults to testnet / CSPR", () => {
    expect(casperX402PaymentOption()).toEqual({
      rail: "x402",
      network: CASPER_TESTNET_CAIP2,
      asset: "CSPR",
    });
  });

  it("respects the network override", () => {
    expect(casperX402PaymentOption(CASPER_MAINNET_CAIP2).network).toBe(CASPER_MAINNET_CAIP2);
  });
});

describe("canonicalize (T11)", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalizeCasperPaymentPayload({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalizeCasperPaymentPayload({ a: { z: 1, y: 2 }, b: [3, 2] })).toBe(
      `{"a":{"y":2,"z":1},"b":[3,2]}`,
    );
  });
});

describe("payWithEnvelope + verifyCasperExactPayload — real crypto verification (T13-live)", () => {
  it("a freshly signed envelope verifies against the payee + network it was built for", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(
      verifyCasperExactPayload(envelope, {
        expectedPayee: envelope.payload.payee,
        expectedNetwork: CASPER_TESTNET_CAIP2,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    const tampered: CasperX402SignedPayload = {
      ...envelope,
      payload: { ...envelope.payload, amount: "999999999" },
    };
    expect(verifyCasperExactPayload(tampered)).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects a signature from a different key than the claimed publicKeyHex", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    const other = new CasperX402Plugin(FACILITATOR, () => OTHER_KEYPAIR);
    const { envelope: otherEnvelope } = await other.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-b" },
    );
    const forged: CasperX402SignedPayload = { ...envelope, signature: otherEnvelope.signature };
    expect(verifyCasperExactPayload(forged)).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects an expired envelope", async () => {
    const p = newPlugin({ now: () => 1_000, ttlMs: 500 });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, { now: 2_000 })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an envelope not yet valid", async () => {
    const p = newPlugin({ now: () => 10_000 });
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, { now: 0 })).toEqual({ ok: false, reason: "not yet valid" });
  });

  it("rejects a payee mismatch", async () => {
    const p = newPlugin();
    const { envelope } = await p.payWithEnvelope(
      { skillId: "1", price: "0.01", asset: "", payTo: "account-hash-" + "ab".repeat(32), network: CASPER_TESTNET_CAIP2 },
      { agentId: "agent-a" },
    );
    expect(verifyCasperExactPayload(envelope, { expectedPayee: "account-hash-" + "ff".repeat(32) })).toEqual({
      ok: false,
      reason: "payee mismatch",
    });
  });
});

describe("CasperX402SignedPayload shape (T11)", () => {
  it("is the type the demo flow stamps on `X-PAYMENT`", () => {
    // Compile-time check that the exported type covers the documented wire shape.
    const sample: CasperX402SignedPayload = {
      x402Version: 1,
      scheme: "exact",
      network: CASPER_TESTNET_CAIP2,
      payload: {
        scheme: "exact",
        network: CASPER_TESTNET_CAIP2,
        payer: "account-hash-0",
        payee: "account-hash-1",
        amount: "1",
        asset: "CSPR",
        validAfter: 0,
        validBefore: 1,
        nonce: "00".repeat(32),
      },
      publicKeyHex: "02".repeat(34),
      signature: "30deadbeef",
    };
    expect(sample.x402Version).toBe(1);
  });
});
