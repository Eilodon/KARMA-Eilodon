import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  deriveStellarSeed,
  deriveStellarKeypair,
  keypairFromSeed,
} from "../lib/stellar/keypair.js";

// Two distinct 32-byte secp256k1-shaped inputs (these are NOT real keys — just deterministic
// test fixtures the assertions are stable against).
const KEY_A = new Uint8Array(32).fill(0xaa);
const KEY_B = new Uint8Array(32).fill(0xbb);

describe("deriveStellarSeed (T6)", () => {
  it("derives a 32-byte seed", () => {
    const seed = deriveStellarSeed(KEY_A);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(32);
  });

  it("is deterministic — same input ⇒ same seed", () => {
    expect(deriveStellarSeed(KEY_A)).toEqual(deriveStellarSeed(KEY_A));
  });

  it("domain-separates — different secp256k1 inputs ⇒ different seeds", () => {
    expect(deriveStellarSeed(KEY_A)).not.toEqual(deriveStellarSeed(KEY_B));
  });

  it("rejects a wrong-length input (fail-loud, not silent truncation)", () => {
    expect(() => deriveStellarSeed(new Uint8Array(31))).toThrow(/expected 32-byte/);
    expect(() => deriveStellarSeed(new Uint8Array(33))).toThrow(/expected 32-byte/);
  });
});

describe("keypairFromSeed (T6)", () => {
  it("yields a Stellar Keypair whose publicKey() matches the canonical SDK derivation", () => {
    const seed = deriveStellarSeed(KEY_A);
    const fromOurs = keypairFromSeed(seed);
    const fromSdk = Keypair.fromRawEd25519Seed(Buffer.from(seed));
    expect(fromOurs.publicKey()).toBe(fromSdk.publicKey());
  });

  it("rejects a wrong-length seed", () => {
    expect(() => keypairFromSeed(new Uint8Array(31))).toThrow(/expected 32-byte/);
  });
});

describe("deriveStellarKeypair (T6)", () => {
  it("round-trips: same secp256k1 key ⇒ same Stellar address", () => {
    expect(deriveStellarKeypair(KEY_A).publicKey()).toBe(deriveStellarKeypair(KEY_A).publicKey());
  });

  it("two different secp256k1 keys ⇒ two different Stellar addresses", () => {
    expect(deriveStellarKeypair(KEY_A).publicKey()).not.toBe(deriveStellarKeypair(KEY_B).publicKey());
  });

  it("produces a strkey-valid Stellar G-address", () => {
    const kp = deriveStellarKeypair(KEY_A);
    const addr = kp.publicKey();
    expect(addr.startsWith("G")).toBe(true);
    expect(addr).toHaveLength(56); // 1 prefix + 55 base32 chars
    // The SDK round-trips a valid G-address through fromPublicKey without throwing.
    expect(() => Keypair.fromPublicKey(addr)).not.toThrow();
  });

  it("signing + verifying with the derived keypair works (round-trip)", () => {
    const kp = deriveStellarKeypair(KEY_A);
    const msg = Buffer.from("karma stellar zk track e2e", "utf8");
    const sig = kp.sign(msg);
    expect(kp.verify(msg, sig)).toBe(true);
    // Tampered message → reject.
    expect(kp.verify(Buffer.from("not the signed message"), sig)).toBe(false);
  });
});
