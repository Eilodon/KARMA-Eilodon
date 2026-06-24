import { describe, it, expect, beforeAll } from "vitest";
import {
  buildCircuitInput,
  buildEpochTree,
  pathFor,
  CIRCUIT_N,
  CIRCUIT_DEPTH,
  type RepAggInputs,
  type RepAggTuple,
  type PoseidonField,
  type PoseidonFn,
} from "../lib/zk/reputation_aggregation.js";

// circomlibjs ships no .d.ts; we drive it through the same dynamic-import as the wrapper.
let poseidon: PoseidonFn;
let F: PoseidonField;

beforeAll(async () => {
  // @ts-expect-error circomlibjs ships without type declarations
  const mod = await import("circomlibjs");
  poseidon = (await mod.buildPoseidon()) as PoseidonFn & { F: PoseidonField };
  F = poseidon.F;
});

const ALICE_SECRET = 99887766554433221100n;
const EPOCH = 202606n;

function realisticTuples(): RepAggTuple[] {
  // 6 tuples across 5 distinct categories, weighted avg = 80.
  return [
    { providerId: 100, categoryId: 1, score: 80, jobCount: 5 },
    { providerId: 200, categoryId: 1, score: 90, jobCount: 5 },
    { providerId: 300, categoryId: 2, score: 70, jobCount: 5 },
    { providerId: 400, categoryId: 3, score: 85, jobCount: 5 },
    { providerId: 500, categoryId: 4, score: 75, jobCount: 5 },
    { providerId: 600, categoryId: 5, score: 80, jobCount: 5 },
  ];
}

describe("buildEpochTree", () => {
  it("zero-leaf tree has stable depth-N root", () => {
    const { root, levels } = buildEpochTree(poseidon, F, 4, []);
    // All-zero leaves at level 0; root deterministic for a fixed depth + Poseidon constants.
    expect(typeof root).toBe("string");
    expect(levels).toHaveLength(5); // depth+1 levels
    expect(levels[0]).toHaveLength(16);
  });

  it("two trees with the same leaves produce the same root (determinism)", () => {
    const leaves = [1n, 2n, 3n];
    const t1 = buildEpochTree(poseidon, F, 4, leaves);
    const t2 = buildEpochTree(poseidon, F, 4, leaves);
    expect(t1.root).toBe(t2.root);
  });

  it("trees with different leaves produce different roots", () => {
    const t1 = buildEpochTree(poseidon, F, 4, [1n, 2n, 3n]);
    const t2 = buildEpochTree(poseidon, F, 4, [1n, 2n, 4n]);
    expect(t1.root).not.toBe(t2.root);
  });

  it("rejects more leaves than 2^depth", () => {
    expect(() => buildEpochTree(poseidon, F, 2, new Array(5).fill(1n))).toThrow();
  });
});

describe("pathFor", () => {
  it("re-hashing along a returned path reconstructs the root", () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const depth = 4;
    const { root, levels } = buildEpochTree(poseidon, F, depth, leaves);

    for (let leafIndex = 0; leafIndex < leaves.length; leafIndex++) {
      const { elements, indices } = pathFor(levels, leafIndex, depth);
      // Reconstruct by re-hashing.
      let current = leaves[leafIndex];
      for (let d = 0; d < depth; d++) {
        const sibling = BigInt(elements[d]);
        const isRight = indices[d];
        const left = isRight ? sibling : current;
        const right = isRight ? current : sibling;
        current = F.toObject(poseidon([left, right])) as bigint;
      }
      expect(current.toString()).toBe(root);
    }
  });
});

describe("buildCircuitInput", () => {
  function baseInputs(extras: Partial<RepAggInputs> = {}): RepAggInputs {
    return {
      tuples: realisticTuples(),
      agentSecret: ALICE_SECRET,
      epoch: EPOCH,
      minAvgScore: 80,
      minDistinctCategories: 5,
      minJobs: 10,
      ...extras,
    };
  }

  it("pads to N=8 signals across every per-tuple array", () => {
    const { signals } = buildCircuitInput(poseidon, F, baseInputs());
    for (const k of ["providerId", "categoryId", "score", "jobCount", "validMask"] as const) {
      expect(signals[k]).toHaveLength(CIRCUIT_N);
    }
    expect(signals.pathElements).toHaveLength(CIRCUIT_N);
    expect(signals.pathIndices).toHaveLength(CIRCUIT_N);
    for (const p of signals.pathElements as string[][]) expect(p).toHaveLength(CIRCUIT_DEPTH);
  });

  it("places real tuples (validMask=1) at the prefix, padding (validMask=0) at the tail", () => {
    const { signals } = buildCircuitInput(poseidon, F, baseInputs());
    const mask = signals.validMask as string[];
    // 6 real tuples → first 6 are 1, last 2 are 0.
    expect(mask.slice(0, 6).every((m) => m === "1")).toBe(true);
    expect(mask.slice(6).every((m) => m === "0")).toBe(true);
  });

  it("sorts real tuples ascending by categoryId", () => {
    // Pass in reverse-sorted; wrapper must reorder.
    const reversed = [...realisticTuples()].reverse();
    const { signals } = buildCircuitInput(poseidon, F, baseInputs({ tuples: reversed }));
    const cats = (signals.categoryId as string[]).slice(0, 6).map((c) => Number(c));
    expect(cats).toEqual([...cats].sort((a, b) => a - b));
  });

  it("derives a deterministic nullifier from (agentSecret, epoch)", () => {
    const a = buildCircuitInput(poseidon, F, baseInputs()).nullifier;
    const b = buildCircuitInput(poseidon, F, baseInputs()).nullifier;
    expect(a).toBe(b);
  });

  it("different epochs ⇒ different nullifiers (replay across epochs blocked)", () => {
    const a = buildCircuitInput(poseidon, F, baseInputs({ epoch: 202606n })).nullifier;
    const b = buildCircuitInput(poseidon, F, baseInputs({ epoch: 202607n })).nullifier;
    expect(a).not.toBe(b);
  });

  it("different secrets ⇒ different nullifiers (per-agent domain)", () => {
    const a = buildCircuitInput(poseidon, F, baseInputs({ agentSecret: 1n })).nullifier;
    const b = buildCircuitInput(poseidon, F, baseInputs({ agentSecret: 2n })).nullifier;
    expect(a).not.toBe(b);
  });

  it("changing any real tuple field changes the epochRoot", () => {
    const baseline = buildCircuitInput(poseidon, F, baseInputs()).epochRoot;
    const flipped = [...realisticTuples()];
    flipped[0] = { ...flipped[0], score: 81 };
    const mutated = buildCircuitInput(poseidon, F, baseInputs({ tuples: flipped })).epochRoot;
    expect(mutated).not.toBe(baseline);
  });

  it("rejects empty tuples", () => {
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ tuples: [] }))).toThrow(/empty/);
  });

  it("rejects more tuples than CIRCUIT_N", () => {
    const tooMany = new Array(CIRCUIT_N + 1).fill(null).map((_, i) => ({
      providerId: i + 1,
      categoryId: i + 1,
      score: 80,
      jobCount: 1,
    }));
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ tuples: tooMany }))).toThrow(/too many tuples/);
  });

  it("rejects categoryId=0 in a real tuple (padding sentinel collision)", () => {
    const bad: RepAggTuple[] = [{ providerId: 1, categoryId: 0, score: 80, jobCount: 1 }];
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ tuples: bad }))).toThrow(/categoryId/);
  });

  it("rejects out-of-range score", () => {
    const bad: RepAggTuple[] = [{ providerId: 1, categoryId: 1, score: 101, jobCount: 1 }];
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ tuples: bad }))).toThrow(/score/);
  });

  it("rejects out-of-range jobCount", () => {
    const bad: RepAggTuple[] = [{ providerId: 1, categoryId: 1, score: 80, jobCount: 70000 }];
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ tuples: bad }))).toThrow(/jobCount/);
  });

  it("rejects out-of-range threshold gates", () => {
    expect(() =>
      buildCircuitInput(poseidon, F, baseInputs({ minAvgScore: 101 })),
    ).toThrow(/minAvgScore/);
    expect(() =>
      buildCircuitInput(poseidon, F, baseInputs({ minDistinctCategories: CIRCUIT_N + 1 })),
    ).toThrow(/minDistinctCategories/);
    expect(() => buildCircuitInput(poseidon, F, baseInputs({ minJobs: -1 }))).toThrow(/minJobs/);
  });
});
