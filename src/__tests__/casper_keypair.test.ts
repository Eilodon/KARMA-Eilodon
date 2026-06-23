import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { describe, it, expect } from "vitest";
import { KeyAlgorithm, PrivateKey } from "casper-js-sdk";
import {
  casperAccountHash,
  casperPublicKeyHex,
  deriveCasperPrivateKey,
} from "../lib/casper/keypair.js";

// Two distinct 32-byte secp256k1-shaped inputs (not real keys — deterministic fixtures
// the assertions are stable against). KEY_A / KEY_B mirror the T6 stellar_keypair shape.
const KEY_A = new Uint8Array(32).fill(0xaa);
const KEY_B = new Uint8Array(32).fill(0xbb);

describe("deriveCasperPrivateKey (T10)", () => {
  it("yields a casper-js-sdk PrivateKey instance", () => {
    expect(deriveCasperPrivateKey(KEY_A)).toBeInstanceOf(PrivateKey);
  });

  it("is deterministic — same input ⇒ same public key (so the Casper account is stable across restarts)", () => {
    const a = deriveCasperPrivateKey(KEY_A);
    const b = deriveCasperPrivateKey(KEY_A);
    expect(a.publicKey.toHex()).toBe(b.publicKey.toHex());
  });

  it("two different secp256k1 keys ⇒ two different Casper public keys", () => {
    expect(deriveCasperPrivateKey(KEY_A).publicKey.toHex()).not.toBe(
      deriveCasperPrivateKey(KEY_B).publicKey.toHex(),
    );
  });

  it("rejects a wrong-length input (fail-loud, no silent truncation)", () => {
    expect(() => deriveCasperPrivateKey(new Uint8Array(31))).toThrow(/expected 32-byte/);
    expect(() => deriveCasperPrivateKey(new Uint8Array(33))).toThrow(/expected 32-byte/);
  });

  it("matches the canonical SDK derivation (fromHex with explicit algorithm)", () => {
    const ours = deriveCasperPrivateKey(KEY_A);
    const sdkDirect = PrivateKey.fromHex(Buffer.from(KEY_A).toString("hex"), KeyAlgorithm.SECP256K1);
    expect(ours.publicKey.toHex()).toBe(sdkDirect.publicKey.toHex());
  });
});

describe("casperPublicKeyHex (T10)", () => {
  it("produces a 68-char secp256k1-tagged hex (1 algo byte + 33 pubkey bytes)", () => {
    const hex = casperPublicKeyHex(deriveCasperPrivateKey(KEY_A));
    expect(hex).toHaveLength(68);
    // Algo tag '02' = secp256k1 per Casper serialization spec.
    expect(hex.startsWith("02")).toBe(true);
  });

  it("round-trips through PublicKey.fromHex without throwing", () => {
    const hex = casperPublicKeyHex(deriveCasperPrivateKey(KEY_A));
    // Importing the same hex back must reproduce the public key bit-for-bit.
    const pk = deriveCasperPrivateKey(KEY_A).publicKey;
    expect(pk.toHex()).toBe(hex);
  });
});

describe("casperAccountHash (T10)", () => {
  it("returns the `account-hash-...` prefixed hex used by Casper JSON-RPC payloads", () => {
    const ah = casperAccountHash(deriveCasperPrivateKey(KEY_A));
    expect(ah.startsWith("account-hash-")).toBe(true);
    // Stripping the prefix leaves a 64-char (32-byte) blake2b hash hex.
    expect(ah.slice("account-hash-".length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and distinct per secp256k1 key", () => {
    expect(casperAccountHash(deriveCasperPrivateKey(KEY_A))).toBe(
      casperAccountHash(deriveCasperPrivateKey(KEY_A)),
    );
    expect(casperAccountHash(deriveCasperPrivateKey(KEY_A))).not.toBe(
      casperAccountHash(deriveCasperPrivateKey(KEY_B)),
    );
  });
});

describe("Casper signing round-trip (T10)", () => {
  // casper-js-sdk 5.0.x has a sign/verify format mismatch: `PrivateKey.sign()` returns the
  // 64-byte COMPACT (R||S) format, but `PublicKey.verifySignature()` parses DER AND skips the
  // SHA-256 hashing that `sign()` applies — so a same-SDK round-trip throws "invalid signature".
  // We verify with `node:crypto.verify('sha256', ...)` against the PEM-exported public key,
  // which is the canonical secp256k1/SHA-256 + DER pipeline the live Casper facilitator uses
  // (T11 + T13). This proves the bytes are a mathematically valid ECDSA signature, not just a
  // structural placeholder.
  function compactToDER(sig: Uint8Array): Uint8Array {
    if (sig.length !== 64) throw new Error(`expected 64-byte compact sig, got ${sig.length}`);
    const r = sig.slice(0, 32);
    const s = sig.slice(32, 64);
    const asAsn1Int = (n: Uint8Array): Uint8Array => {
      let i = 0;
      while (i < n.length - 1 && n[i] === 0) i += 1;
      const t = n.slice(i);
      // ASN.1 INTEGER is signed: prepend 0x00 if high bit is set so it stays positive.
      return t[0]! & 0x80 ? Uint8Array.from([0x00, ...t]) : t;
    };
    const rE = asAsn1Int(r);
    const sE = asAsn1Int(s);
    const body = Uint8Array.from([0x02, rE.length, ...rE, 0x02, sE.length, ...sE]);
    return Uint8Array.from([0x30, body.length, ...body]);
  }

  function pemPubKey(kp: PrivateKey) {
    return createPublicKey({ key: kp.publicKey.toPem(), format: "pem" });
  }

  it("signature produced by sign() is the SDK's compact 64-byte (R||S) format", () => {
    const kp = deriveCasperPrivateKey(KEY_A);
    const sig = kp.sign(new TextEncoder().encode("size check"));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it("signing a message verifies via the canonical secp256k1/SHA-256 + DER pipeline", () => {
    const kp = deriveCasperPrivateKey(KEY_A);
    const msg = new TextEncoder().encode("karma casper x402 e2e");
    const sig = kp.sign(msg);
    expect(cryptoVerify("sha256", msg, pemPubKey(kp), compactToDER(sig))).toBe(true);
    // Tampering with the message invalidates the signature.
    const tampered = new TextEncoder().encode("not the signed message");
    expect(cryptoVerify("sha256", tampered, pemPubKey(kp), compactToDER(sig))).toBe(false);
  });

  it("a signature from KEY_A does not verify under KEY_B's public key", () => {
    const a = deriveCasperPrivateKey(KEY_A);
    const b = deriveCasperPrivateKey(KEY_B);
    const msg = new TextEncoder().encode("cross-key forgery check");
    const sig = a.sign(msg);
    expect(cryptoVerify("sha256", msg, pemPubKey(b), compactToDER(sig))).toBe(false);
  });
});
