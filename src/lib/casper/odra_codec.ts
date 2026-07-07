/**
 * Decoders for `#[odra::odra_type]` struct/enum values read back off-chain (T13-live).
 *
 * Odra serializes these via `casper_types::bytesrepr::ToBytes`/`FromBytes` — the same
 * convention used natively by every Casper CLValue — and a `Mapping<K, V>` dictionary read
 * comes back as `CLType::List(U8)` (one `CLValue::U8` per byte), confirmed against a real
 * deployed contract read. That's true for *every* value type Odra stores this way, not just
 * contract-defined structs — `decodeU32`/`decodeU512` below decode a plain `u32`/`U512`
 * Mapping value from the exact same wire shape, not the native `CLValue.ui32`/`.ui512` a
 * hand-built mock would suggest. Field layout below is pinned to
 * `contracts-odra/src/agent_skill_registry.rs`'s `Skill`/`Job`/`JobStatus` definitions, in
 * declaration order — reordering those Rust fields without updating this file will silently
 * desync the two. Byte-level rules (string = u32-LE length + utf8; U512 = u8 length + LE
 * magnitude; Option = 1-byte tag; enum-without-data = u8 discriminant in declaration order)
 * were confirmed empirically against this repo's pinned `casper-js-sdk` version, not assumed.
 */

export type CasperAddressKind = "Account" | "Contract";

export interface CasperAddress {
  kind: CasperAddressKind;
  hashHex: string;
}

export type DecodedJobStatus = "Open" | "Delivered" | "Completed" | "Refunded" | "Disputed";

const JOB_STATUS_VARIANTS: readonly DecodedJobStatus[] = [
  "Open",
  "Delivered",
  "Completed",
  "Refunded",
  "Disputed",
];

export interface DecodedSkill {
  owner: CasperAddress;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCallMotes: bigint;
  reputationScore: number;
  totalInvocations: bigint;
  active: boolean;
  registeredAt: bigint;
  minReputationToInvoke: number;
  identityPolicy: number;
}

export interface DecodedJob {
  requester: CasperAddress;
  provider: CasperAddress;
  skillId: bigint;
  taskHash: Uint8Array;
  escrowAmountMotes: bigint;
  deadline: bigint;
  status: DecodedJobStatus;
  resultHash: Uint8Array;
  createdAt: bigint;
  completedAt: bigint;
  evaluator: CasperAddress | undefined;
  evaluatorFeeMotes: bigint;
}

class OdraBytesReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `[odra-codec] buffer underrun: need ${n} byte(s) at offset ${this.pos}, have ${this.buf.length}`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0];
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u32(): number {
    const b = this.take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  u64(): bigint {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  /** Casper's variable-length big-number encoding: 1-byte length prefix + that many LE bytes. */
  u512(): bigint {
    const len = this.u8();
    const b = this.take(len);
    let v = 0n;
    for (let i = len - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  /** `Vec<u8>` / `casper_types::bytesrepr::Bytes`: u32-LE length prefix + raw bytes. */
  bytesVec(): Uint8Array {
    return this.take(this.u32());
  }

  string(): string {
    return Buffer.from(this.bytesVec()).toString("utf8");
  }

  /** Odra `Address`: 1-byte variant tag (0 = Account, 1 = Contract) + raw 32-byte hash. */
  address(): CasperAddress {
    const tag = this.u8();
    const hash = this.take(32);
    return { kind: tag === 0 ? "Account" : "Contract", hashHex: Buffer.from(hash).toString("hex") };
  }

  option<T>(inner: () => T): T | undefined {
    return this.u8() === 0 ? undefined : inner();
  }

  jobStatus(): DecodedJobStatus {
    const tag = this.u8();
    const status = JOB_STATUS_VARIANTS[tag];
    if (status === undefined) {
      throw new Error(`[odra-codec] unknown JobStatus discriminant: ${tag}`);
    }
    return status;
  }
}

/** Decodes a `Skill` struct's raw on-chain bytes (see `contracts-odra/src/agent_skill_registry.rs`). */
export function decodeSkill(bytes: Uint8Array): DecodedSkill {
  const r = new OdraBytesReader(bytes);
  return {
    owner: r.address(),
    name: r.string(),
    description: r.string(),
    mcpEndpoint: r.string(),
    pricePerCallMotes: r.u512(),
    reputationScore: r.u32(),
    totalInvocations: r.u64(),
    active: r.bool(),
    registeredAt: r.u64(),
    minReputationToInvoke: r.u32(),
    identityPolicy: r.u8(),
  };
}

/** Decodes a `Job` struct's raw on-chain bytes (see `contracts-odra/src/agent_skill_registry.rs`). */
export function decodeJob(bytes: Uint8Array): DecodedJob {
  const r = new OdraBytesReader(bytes);
  return {
    requester: r.address(),
    provider: r.address(),
    skillId: r.u64(),
    taskHash: r.bytesVec(),
    escrowAmountMotes: r.u512(),
    deadline: r.u64(),
    status: r.jobStatus(),
    resultHash: r.bytesVec(),
    createdAt: r.u64(),
    completedAt: r.u64(),
    evaluator: r.option(() => r.address()),
    evaluatorFeeMotes: r.u512(),
  };
}

/** Decodes a plain `u32` `Mapping`/`Var` value's raw bytes (e.g. `agent_rep[account]`) — same
 *  `List(U8)` wrapping as compound structs, not a native `CLValue.ui32` (confirmed against a
 *  real deployed contract read: `bonded_amount`/`agent_rep` come back exactly like `Skill`/`Job`
 *  bytes, not as their "native" CLType — the Mapping storage layer is byte-uniform regardless
 *  of the Rust value type it holds). */
export function decodeU32(bytes: Uint8Array): number {
  return new OdraBytesReader(bytes).u32();
}

/** Decodes a plain `U512` `Mapping`/`Var` value's raw bytes (e.g. `bonded_amount[account]`,
 *  `pending_withdrawals[account]`) — see `decodeU32`'s note; same reasoning applies. */
export function decodeU512(bytes: Uint8Array): bigint {
  return new OdraBytesReader(bytes).u512();
}
