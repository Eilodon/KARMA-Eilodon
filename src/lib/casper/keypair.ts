import { Buffer } from "node:buffer";
import { KeyAlgorithm, PrivateKey } from "casper-js-sdk";

/**
 * Casper keypair adapter (T10) — direct reuse of KARMA's existing secp256k1 keystore.
 *
 * Unlike Stellar (T6), Casper natively supports secp256k1 so there is no key-material
 * derivation step: the same 32-byte private key that already signs viem transactions IS
 * the Casper signer's raw secret. We just hand it to casper-js-sdk in the shape the SDK
 * expects (`PrivateKey.fromHex(..., KeyAlgorithm.SECP256K1)`), which wraps the bytes,
 * derives the compressed public key on demand, and exposes Casper's tagged hex format.
 *
 * Properties preserved from the keystore invariant:
 *   • DETERMINISTIC — same secp256k1 key always yields the same Casper account hex.
 *   • IN-CLASS ONLY — the raw private key bytes never leave this function; only the
 *     `PrivateKey` wrapper is returned (signs internally; the bytes are held in its
 *     private field, never exposed by an SDK method).
 *   • NO HKDF — Casper's secp256k1 path means a single backup-unit covers
 *     Ethereum + Stellar + Casper without parallel keystore entries.
 *
 * Tag-byte note (Casper serialization): a secp256k1 public key in hex form is 68 chars
 * (34 bytes) — 1 algorithm-tag byte (`0x02` for secp256k1) followed by the 33-byte
 * compressed pubkey. Tests pin this layout.
 */

const SECP256K1_PRIVATE_KEY_LEN = 32;

/** Pure adapter: secp256k1 private key bytes → casper-js-sdk PrivateKey (signs internally). */
export function deriveCasperPrivateKey(secp256k1PrivKey: Uint8Array): PrivateKey {
  if (secp256k1PrivKey.length !== SECP256K1_PRIVATE_KEY_LEN) {
    throw new Error(`[KARMA] expected ${SECP256K1_PRIVATE_KEY_LEN}-byte secp256k1 key, got ${secp256k1PrivKey.length}`);
  }
  const hex = Buffer.from(secp256k1PrivKey).toString("hex");
  return PrivateKey.fromHex(hex, KeyAlgorithm.SECP256K1);
}

/** Casper public key in tagged hex form (e.g. `02xxx...` for secp256k1). 68 chars. */
export function casperPublicKeyHex(pk: PrivateKey): string {
  return pk.publicKey.toHex();
}

/** Casper account-hash hex string with the `account-hash-` prefix the network uses
 *  for transfer/`AccountHash` JSON-RPC payloads. */
export function casperAccountHash(pk: PrivateKey): string {
  return pk.publicKey.accountHash().toPrefixedString();
}
