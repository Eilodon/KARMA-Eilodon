import blake2b from "blake2b";

const DIGEST_LEN = 32;

/**
 * Derives the Casper dictionary-item key Odra uses for `Var<T>` / `Mapping<K, V>` fields on the
 * casper-wasm backend — reverse-engineered from `odra-core`'s actual source (not guessed):
 *
 *   - Every field of a `#[odra::module]` struct lives in ONE shared dictionary named `"state"`
 *     (`odra-casper-wasm-env`'s `consts::STATE_KEY`).
 *   - `ContractEnv::current_key()` = `blake2b256(index_bytes ++ mapping_data)`, hex-encoded
 *     (lowercase, 64 chars) — see `contract_env.rs` in the `odra-core` crate.
 *   - `index_bytes` has TWO encodings, per `ContractEnv::index_bytes()` (read directly from
 *     `odra-core-2.8.2/src/contract_env.rs`, not guessed) — this module only ever reads
 *     TOP-LEVEL fields (path length 1, no `SubModule` nesting), so `path = [fieldIndex]` always:
 *       - **Legacy** (`fieldIndex` ≤ 15): big-endian `u32` of the index — 4 bytes, e.g. index 4 →
 *         `[0,0,0,4]`. Preserves storage keys from before the path encoding existed.
 *       - **Path** (`fieldIndex` > 15): `[0xFF, path_len, ...path]` = `[0xFF, 1, fieldIndex]` for
 *         a top-level field. The `0xFF` prefix can't collide with legacy keys (whose first byte
 *         never exceeds `0x0F`); `path_len` disambiguates nesting depth from mapping-key bytes.
 *   - `mapping_data` is the mapping key's `bytesrepr` serialization (`ToBytes::to_bytes()`).
 *
 * Field indices are macro-assigned in struct declaration order **starting at 1, not 0**
 * (verified with `cargo +nightly expand --lib agent_skill_registry` against
 * `contracts-odra/src/agent_skill_registry.rs` — recomputing by hand undercounts by one).
 * See `contracts-odra/README.md` for the full verified index table.
 */
export function odraMappingDictionaryKey(fieldIndex: number, mappingKeyBytes: Uint8Array): string {
  if (!Number.isInteger(fieldIndex) || fieldIndex < 0 || fieldIndex > 255) {
    throw new Error(`[odra-storage-key] field index ${fieldIndex} must fit in a u8 (0-255)`);
  }
  const indexBytes =
    fieldIndex <= 15
      ? Uint8Array.from([0, 0, 0, fieldIndex])
      : Uint8Array.from([0xff, 1, fieldIndex]); // path encoding, path_len=1 — see doc comment above
  const preimage = new Uint8Array(indexBytes.length + mappingKeyBytes.length);
  preimage.set(indexBytes, 0);
  preimage.set(mappingKeyBytes, indexBytes.length);
  const digest = blake2b(DIGEST_LEN).update(preimage).digest();
  return Buffer.from(digest).toString("hex");
}

/** `u64` `bytesrepr` encoding — 8 bytes, little-endian (casper_types convention for all
 *  fixed-width integers). */
export function u64ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`[odra-storage-key] u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Casper `Key::Account` `bytesrepr` encoding — 1-byte tag (`0x00`) + the 32-byte account hash.
 *  Odra's `Address::to_bytes()` delegates to `Key::from(address).to_bytes()`; every agent
 *  address this contract keys `Mapping`s by is an account (never a contract package). */
export function accountAddressToBytes(accountHashHex: string): Uint8Array {
  const hex = accountHashHex.replace(/^account-hash-/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[odra-storage-key] expected a 32-byte account hash hex, got: ${accountHashHex}`);
  }
  const out = new Uint8Array(33);
  out.set(Buffer.from(hex, "hex"), 1);
  out[0] = 0x00; // Key::Account tag
  return out;
}

/** `contracts-odra/src/agent_skill_registry.rs`'s `AgentSkillRegistry` module field indices —
 *  pinned by `cargo expand`, not recomputed. Only the fields this module currently reads. */
export const AGENT_SKILL_REGISTRY_FIELD_INDEX = {
  skills: 4,
  jobs: 5,
  pendingWithdrawals: 9,
  agentRep: 11,
  bondedAmount: 12,
  /** `compositions: Mapping<u64, Composition>` — index 14, confirmed via `cargo +nightly expand
   *  --lib agent_skill_registry` (same method as every other index above), not recomputed by hand. */
  compositions: 14,
  /** `cross_chain_rep: Mapping<Address, u32>` — index 15, confirmed the same way. */
  crossChainRep: 15,
  /** `rationale_hash: Mapping<u64, Bytes>` (P2-A) — index 25, confirmed via `cargo +nightly
   *  expand --lib agent_skill_registry` (its `ModuleComponent::instance(env, 25u8)` call is
   *  printed directly in the expanded output). First field index in this table that needs the
   *  PATH encoding branch (> 15) — exercises it for real, not just in a synthetic unit test. */
  rationaleHash: 25,
} as const;
