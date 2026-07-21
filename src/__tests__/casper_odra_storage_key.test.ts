import { describe, it, expect } from "vitest";
import {
  odraMappingDictionaryKey,
  u64ToBytes,
  accountAddressToBytes,
  AGENT_SKILL_REGISTRY_FIELD_INDEX,
} from "../lib/casper/odra_storage_key.js";

describe("odraMappingDictionaryKey (T13-live, verified against cargo-expand + an independent blake2b256 reference)", () => {
  it("matches an independently computed blake2b256 digest for skills[1] (field index 4, u64 key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,4]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, u64ToBytes(1n));
    expect(key).toBe("1d4c5faba44ae8638dfbc992e8dc85840358a59b5d94830913b71366260cfc77");
    expect(key).toHaveLength(64);
  });

  it("matches an independently computed blake2b256 digest for pendingWithdrawals[account 0x11...] (field index 9, Address key)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0,0,0,9]) + bytes([0]) + bytes([0x11]*32), digest_size=32).hexdigest())"
    const accountHash = "11".repeat(32);
    const key = odraMappingDictionaryKey(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.pendingWithdrawals,
      accountAddressToBytes(accountHash),
    );
    expect(key).toBe("6a963b89254897196fc139e40d0500d62fbcb4f31c2999dc09dadc3cf6cdd1c1");
    expect(key).toHaveLength(64);
  });

  it("is deterministic and distinct per field index (same mapping key, different field)", () => {
    const keyBytes = u64ToBytes(7n);
    const a = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, keyBytes);
    const b = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobs, keyBytes);
    expect(a).not.toBe(b);
    expect(odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, keyBytes)).toBe(a);
  });

  it("rejects a field index outside the u8 range", () => {
    expect(() => odraMappingDictionaryKey(256, u64ToBytes(1n))).toThrow(/must fit in a u8/);
    expect(() => odraMappingDictionaryKey(-1, u64ToBytes(1n))).toThrow(/must fit in a u8/);
  });

  it("matches an independently computed blake2b256 digest for rationaleHash[job 1] (field index 25 — PATH encoding, > 15)", () => {
    // Expected value cross-checked with: python3 -c "import hashlib;
    //   print(hashlib.blake2b(bytes([0xFF, 1, 25]) + (1).to_bytes(8,'little'), digest_size=32).hexdigest())"
    // [0xFF, path_len=1, field_index=25] per odra-core-2.8.2's ContractEnv::index_bytes()
    // (contract_env.rs), read directly — not guessed. See the doc comment above
    // odraMappingDictionaryKey for the full derivation.
    const key = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.rationaleHash, u64ToBytes(1n));
    expect(key).toBe("34514907fcda0f101182c6e5e8f75fac6d30e323abad9fd6ed0da15e566839f1");
    expect(key).toHaveLength(64);
  });

  it("PATH encoding is distinct per field index (no collision between 16 and 25 at the same mapping key)", () => {
    const keyBytes = u64ToBytes(1n);
    const a = odraMappingDictionaryKey(16, keyBytes);
    const b = odraMappingDictionaryKey(AGENT_SKILL_REGISTRY_FIELD_INDEX.rationaleHash, keyBytes);
    expect(a).not.toBe(b);
  });

  it("LEGACY and PATH encodings never collide (index 15 vs 16, same mapping key)", () => {
    const keyBytes = u64ToBytes(1n);
    const legacy = odraMappingDictionaryKey(15, keyBytes);
    const path = odraMappingDictionaryKey(16, keyBytes);
    expect(legacy).not.toBe(path);
  });
});

describe("u64ToBytes", () => {
  it("encodes little-endian, 8 bytes", () => {
    expect(Buffer.from(u64ToBytes(1n)).toString("hex")).toBe("0100000000000000");
    expect(Buffer.from(u64ToBytes(0x0102030405060708n)).toString("hex")).toBe("0807060504030201");
  });

  it("rejects out-of-range values", () => {
    expect(() => u64ToBytes(-1n)).toThrow(/out of range/);
    expect(() => u64ToBytes(2n ** 64n)).toThrow(/out of range/);
  });
});

describe("accountAddressToBytes", () => {
  it("prefixes the Key::Account tag (0x00) to the raw 32-byte hash", () => {
    const bytes = accountAddressToBytes("account-hash-" + "22".repeat(32));
    expect(bytes.length).toBe(33);
    expect(bytes[0]).toBe(0x00);
    expect(Buffer.from(bytes.slice(1)).toString("hex")).toBe("22".repeat(32));
  });

  it("accepts a bare hex hash without the account-hash- prefix", () => {
    const bytes = accountAddressToBytes("33".repeat(32));
    expect(bytes[0]).toBe(0x00);
  });

  it("rejects a malformed hash", () => {
    expect(() => accountAddressToBytes("not-hex")).toThrow(/expected a 32-byte/);
  });
});
