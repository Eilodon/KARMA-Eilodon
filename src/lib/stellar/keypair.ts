import { hkdfSync } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Stellar ed25519 keypair derived from KARMA's existing secp256k1 keystore (T6).
 *
 * KARMA's keystore is Web3 Secret Storage v3 (secp256k1, scrypt) — not directly usable for
 * Stellar, which signs with ed25519. Rather than adding a parallel keystore file or making
 * users manage two secrets, we derive the Stellar seed from the same secp256k1 entropy via
 * RFC 5869 HKDF with a context-specific salt+info:
 *
 *   seed = HKDF-SHA256(ikm = secp256k1PrivKey,
 *                      salt = "karma-stellar-v1",
 *                      info = "ed25519-seed",
 *                      L    = 32)
 *
 * Properties this gives us:
 *   • DETERMINISTIC — same agent secp256k1 key always yields the same Stellar address.
 *     A user's pre-funded testnet account stays usable across restarts.
 *   • DOMAIN-SEPARATED — the salt+info bind the seed to KARMA's Stellar use case, so the
 *     same ikm under a different protocol would derive a different (independent) seed.
 *   • ONE-WAY — HKDF is a PRF; the secp256k1 key cannot be recovered from the Stellar seed.
 *     Compromising the Stellar seed does NOT compromise the Ethereum signer.
 *   • NO NEW STORAGE — the keystore file stays single-secret-per-agent.
 *
 * Caveat (security): the secp256k1 ikm passes through this function as plain bytes. Callers
 * MUST derive while the raw key is still in scope (inside `decryptV3`) and not retain it
 * elsewhere. KeystoreManager.load handles this — outside callers receive only the Stellar
 * Keypair (which signs internally), never the raw seed.
 */

/** Domain-separation labels — bump the version suffix to rotate everyone's derived seeds. */
const SALT = Buffer.from("karma-stellar-v1", "utf8");
const INFO = Buffer.from("ed25519-seed", "utf8");

/** Pure HKDF: secp256k1 private key bytes → 32-byte ed25519 seed. */
export function deriveStellarSeed(secp256k1PrivKey: Uint8Array): Uint8Array {
  if (secp256k1PrivKey.length !== 32) {
    throw new Error(`[KARMA] expected 32-byte secp256k1 key, got ${secp256k1PrivKey.length}`);
  }
  const ab = hkdfSync("sha256", secp256k1PrivKey, SALT, INFO, 32);
  return new Uint8Array(ab);
}

/** Build a Stellar Keypair from the derived seed. The seed is consumed (callers MUST NOT retain it). */
export function keypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== 32) {
    throw new Error(`[KARMA] expected 32-byte Stellar seed, got ${seed.length}`);
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/** One-shot: derive + build keypair. The intermediate seed is local-scope only. */
export function deriveStellarKeypair(secp256k1PrivKey: Uint8Array): Keypair {
  const seed = deriveStellarSeed(secp256k1PrivKey);
  return keypairFromSeed(seed);
}
