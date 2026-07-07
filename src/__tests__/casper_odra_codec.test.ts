import { describe, it, expect } from "vitest";
import casperSdk from "casper-js-sdk";
import { decodeSkill, decodeJob, decodeComposition } from "../lib/casper/odra_codec.js";

const { CLValue } = casperSdk;

/** Test-only byte builders. Primitive shapes (string/u512/u32/u64/u8/bool) are taken straight
 *  from `casper-js-sdk`'s own CLValue encoders (the SDK is the ground truth for Casper's
 *  bytesrepr format), so these tests validate the decoder's field-splitting logic against
 *  real encodings rather than against a second hand-rolled copy of the same assumptions. */
function str(s: string): Uint8Array {
  return CLValue.newCLString(s).bytes();
}
function u512(v: string): Uint8Array {
  return CLValue.newCLUInt512(v).bytes();
}
function u32(v: number): Uint8Array {
  return CLValue.newCLUInt32(v).bytes();
}
function u64(v: string): Uint8Array {
  return CLValue.newCLUint64(v).bytes();
}
function u8(v: number): Uint8Array {
  return CLValue.newCLUint8(v).bytes();
}
function bool(v: boolean): Uint8Array {
  return CLValue.newCLValueBool(v).bytes();
}
function bytesVec(b: Uint8Array): Uint8Array {
  return Buffer.concat([u32(b.length), Buffer.from(b)]);
}
function address(kind: "Account" | "Contract", hashHex: string): Uint8Array {
  return Buffer.concat([Buffer.from([kind === "Account" ? 0 : 1]), Buffer.from(hashHex, "hex")]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}
function vecU64(values: string[]): Uint8Array {
  return concat(u32(values.length), ...values.map(u64));
}
function vecU32(values: number[]): Uint8Array {
  return concat(u32(values.length), ...values.map(u32));
}

const OWNER_HASH = "11".repeat(32);
const REQUESTER_HASH = "22".repeat(32);
const PROVIDER_HASH = "33".repeat(32);
const EVALUATOR_HASH = "44".repeat(32);

describe("decodeSkill", () => {
  it("decodes a full Skill struct in Rust field order", () => {
    const bytes = concat(
      address("Account", OWNER_HASH),
      str("rwa_price_oracle"),
      str("desc"),
      str("casper-mcp://providers/rwa_price_oracle"),
      u512("10000000"),
      u32(75),
      u64("42"),
      bool(true),
      u64("1700000000"),
      u32(10),
      u8(2),
    );

    const skill = decodeSkill(bytes);

    expect(skill.owner).toEqual({ kind: "Account", hashHex: OWNER_HASH });
    expect(skill.name).toBe("rwa_price_oracle");
    expect(skill.description).toBe("desc");
    expect(skill.mcpEndpoint).toBe("casper-mcp://providers/rwa_price_oracle");
    expect(skill.pricePerCallMotes).toBe(10_000_000n);
    expect(skill.reputationScore).toBe(75);
    expect(skill.totalInvocations).toBe(42n);
    expect(skill.active).toBe(true);
    expect(skill.registeredAt).toBe(1_700_000_000n);
    expect(skill.minReputationToInvoke).toBe(10);
    expect(skill.identityPolicy).toBe(2);
  });

  it("decodes a zero-valued U512 (price_per_call = 0)", () => {
    const bytes = concat(
      address("Contract", OWNER_HASH),
      str(""),
      str(""),
      str(""),
      u512("0"),
      u32(0),
      u64("0"),
      bool(false),
      u64("0"),
      u32(0),
      u8(0),
    );
    const skill = decodeSkill(bytes);
    expect(skill.owner.kind).toBe("Contract");
    expect(skill.pricePerCallMotes).toBe(0n);
    expect(skill.active).toBe(false);
  });
});

describe("decodeJob", () => {
  it("decodes a full Job struct with no evaluator (Option::None)", () => {
    const taskHash = Buffer.from("aa".repeat(32), "hex");
    const resultHash = Buffer.from("bb".repeat(32), "hex");
    const bytes = concat(
      address("Account", REQUESTER_HASH),
      address("Account", PROVIDER_HASH),
      u64("1"),
      bytesVec(taskHash),
      u512("10000000"),
      u64("259200"),
      u8(1), // JobStatus::Delivered
      bytesVec(resultHash),
      u64("1700000000"),
      u64("0"),
      u8(0), // Option::None
      u512("0"),
    );

    const job = decodeJob(bytes);

    expect(job.requester).toEqual({ kind: "Account", hashHex: REQUESTER_HASH });
    expect(job.provider).toEqual({ kind: "Account", hashHex: PROVIDER_HASH });
    expect(job.skillId).toBe(1n);
    expect(Buffer.from(job.taskHash).toString("hex")).toBe("aa".repeat(32));
    expect(job.escrowAmountMotes).toBe(10_000_000n);
    expect(job.deadline).toBe(259_200n);
    expect(job.status).toBe("Delivered");
    expect(Buffer.from(job.resultHash).toString("hex")).toBe("bb".repeat(32));
    expect(job.createdAt).toBe(1_700_000_000n);
    expect(job.completedAt).toBe(0n);
    expect(job.evaluator).toBeUndefined();
    expect(job.evaluatorFeeMotes).toBe(0n);
  });

  it("decodes an evaluator Option::Some(Address) and every JobStatus discriminant", () => {
    const statuses: Array<[number, string]> = [
      [0, "Open"],
      [1, "Delivered"],
      [2, "Completed"],
      [3, "Refunded"],
      [4, "Disputed"],
    ];
    for (const [tag, expected] of statuses) {
      const bytes = concat(
        address("Account", REQUESTER_HASH),
        address("Account", PROVIDER_HASH),
        u64("1"),
        bytesVec(new Uint8Array(0)),
        u512("0"),
        u64("0"),
        u8(tag),
        bytesVec(new Uint8Array(0)),
        u64("0"),
        u64("0"),
        concat(u8(1), address("Contract", EVALUATOR_HASH)), // Option::Some
        u512("5000"),
      );
      const job = decodeJob(bytes);
      expect(job.status).toBe(expected);
      expect(job.evaluator).toEqual({ kind: "Contract", hashHex: EVALUATOR_HASH });
      expect(job.evaluatorFeeMotes).toBe(5000n);
    }
  });

  it("throws on an unknown JobStatus discriminant instead of silently misreading the rest", () => {
    const bytes = concat(
      address("Account", REQUESTER_HASH),
      address("Account", PROVIDER_HASH),
      u64("1"),
      bytesVec(new Uint8Array(0)),
      u512("0"),
      u64("0"),
      u8(99),
    );
    expect(() => decodeJob(bytes)).toThrow(/unknown JobStatus/);
  });
});

describe("decodeComposition", () => {
  it("decodes leaf skill ids (Vec<u64>) and weights (Vec<u32>) in Rust field order", () => {
    const bytes = concat(vecU64(["1", "2", "3"]), vecU32([5000, 3000, 2000]));
    const composition = decodeComposition(bytes);
    expect(composition.leafSkillIds).toEqual([1n, 2n, 3n]);
    expect(composition.weightsBps).toEqual([5000, 3000, 2000]);
  });

  it("decodes a single-leaf composition (the minimum allowed)", () => {
    const bytes = concat(vecU64(["42"]), vecU32([10_000]));
    const composition = decodeComposition(bytes);
    expect(composition.leafSkillIds).toEqual([42n]);
    expect(composition.weightsBps).toEqual([10_000]);
  });
});
