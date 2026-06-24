import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  attestationDigest,
  signAttestation,
  verifyAttestation,
  type SignedAttestation,
} from "../lib/zk/signed_tls_attestation.js";

const KARMA_SEED = new Uint8Array(32).fill(0x4b);
const KARMA_KP = Keypair.fromRawEd25519Seed(Buffer.from(KARMA_SEED));
const OTHER_SEED = new Uint8Array(32).fill(0x99);
const OTHER_KP = Keypair.fromRawEd25519Seed(Buffer.from(OTHER_SEED));

const SAMPLE_BODY = JSON.stringify({ symbol: "BTCUSDT", price: "65432.10" });
const FIELDS = {
  url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
  certSha256: "deadbeef".repeat(8),
  bodySha256: createHash("sha256").update(SAMPLE_BODY).digest("hex"),
  fetchedAt: 1_700_000_000_000,
  body: SAMPLE_BODY,
};

function signed(): SignedAttestation {
  return signAttestation(FIELDS, KARMA_KP);
}

describe("attestationDigest", () => {
  it("is deterministic for the same fields", () => {
    const a = attestationDigest(FIELDS);
    const b = attestationDigest(FIELDS);
    expect(a.equals(b)).toBe(true);
  });

  it("changes if any field changes", () => {
    const base = attestationDigest(FIELDS);
    expect(attestationDigest({ ...FIELDS, url: "https://other" }).equals(base)).toBe(false);
    expect(attestationDigest({ ...FIELDS, fetchedAt: 1 }).equals(base)).toBe(false);
    expect(attestationDigest({ ...FIELDS, certSha256: "00".repeat(32) }).equals(base)).toBe(false);
    expect(attestationDigest({ ...FIELDS, bodySha256: "00".repeat(32) }).equals(base)).toBe(false);
  });
});

describe("signAttestation + verifyAttestation roundtrip", () => {
  it("verifies a freshly signed attestation against the signer's pubkey", () => {
    const att = signed();
    expect(verifyAttestation(att)).toBe(true);
    expect(verifyAttestation(att, { expectedPubkey: KARMA_KP.publicKey() })).toBe(true);
  });

  it("rejects when the expected pubkey does not match", () => {
    const att = signed();
    expect(verifyAttestation(att, { expectedPubkey: OTHER_KP.publicKey() })).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const att = signed();
    const tampered: SignedAttestation = { ...att, body: att.body.replace("65432.10", "1.00") };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("rejects when bodySha256 has been edited to match a tampered body (signature still over old hash)", () => {
    const att = signed();
    const fakeBody = SAMPLE_BODY.replace("65432.10", "1.00");
    const fakeHash = createHash("sha256").update(fakeBody).digest("hex");
    const tampered: SignedAttestation = { ...att, body: fakeBody, bodySha256: fakeHash };
    expect(verifyAttestation(tampered)).toBe(false);
  });

  it("rejects when fetchedAt has been edited", () => {
    const att = signed();
    expect(verifyAttestation({ ...att, fetchedAt: att.fetchedAt + 1 })).toBe(false);
  });

  it("rejects when certSha256 has been edited", () => {
    const att = signed();
    expect(verifyAttestation({ ...att, certSha256: "00".repeat(32) })).toBe(false);
  });

  it("rejects when the cert fingerprint pin does not match", () => {
    const att = signed();
    expect(
      verifyAttestation(att, { expectedCertSha256: "ff".repeat(32) }),
    ).toBe(false);
  });

  it("rejects when the signature was produced by a different key but claims KARMA's pubkey", () => {
    // Sign with OTHER, then lie about the pubkey: verify must still reject because the
    // pubkey we verify against is the one IN the envelope, not the signer's actual key.
    const att = signAttestation(FIELDS, OTHER_KP);
    const lied: SignedAttestation = { ...att, signerPubkey: KARMA_KP.publicKey() };
    expect(verifyAttestation(lied)).toBe(false);
  });

  it("rejects on a malformed signature without throwing", () => {
    const att = signed();
    expect(verifyAttestation({ ...att, signature: "not-base64-!@#" })).toBe(false);
  });

  it("rejects on a malformed pubkey without throwing", () => {
    const att = signed();
    expect(verifyAttestation({ ...att, signerPubkey: "GARBAGE" })).toBe(false);
  });
});
