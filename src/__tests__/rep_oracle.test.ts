import { describe, it, expect } from "vitest";
import {
  aggregateObservations,
  satisfiesThresholds,
  buildRepAggInputs,
  RepOracleError,
  type RepObservation,
  type RepSource,
} from "../lib/zk/rep_oracle.js";
import { CIRCUIT_N, type RepAggThresholds } from "../lib/zk/reputation_aggregation.js";

// T1.3 — the off-chain reputation oracle: turns an agent's indexed Pharos reputation observations
// into circuit-ready RepAggInputs. Pure (the on-chain/index read is an injected RepSource), so the
// aggregation + threshold pre-flight is fully verifiable here; proof generation stays in T1.1.

const THRESH: RepAggThresholds = { minAvgScore: 80, minDistinctCategories: 3, minJobs: 10 };

describe("aggregateObservations", () => {
  it("merges same-category rows (weighted-avg score, summed jobs) and keeps the dominant providerId", () => {
    const obs: RepObservation[] = [
      { providerId: 100, categoryId: 1, score: 90, jobCount: 2 },
      { providerId: 200, categoryId: 1, score: 60, jobCount: 8 }, // dominant in cat 1 (more jobs)
      { providerId: 300, categoryId: 2, score: 85, jobCount: 5 },
    ];
    const tuples = aggregateObservations(obs);
    expect(tuples).toHaveLength(2); // two distinct categories
    const cat1 = tuples.find((t) => t.categoryId === 1)!;
    expect(cat1.jobCount).toBe(10); // 2 + 8
    expect(cat1.score).toBe(66); // (90*2 + 60*8) / 10 = 660/10 = 66
    expect(cat1.providerId).toBe(200); // dominant by jobCount
    // distinct, ascending categoryIds.
    expect(tuples.map((t) => t.categoryId)).toEqual([1, 2]);
  });

  it("rejects malformed observations", () => {
    expect(() => aggregateObservations([{ providerId: 1, categoryId: 0, score: 50, jobCount: 1 }]))
      .toThrow(RepOracleError); // categoryId 0 is the padding sentinel
    expect(() => aggregateObservations([{ providerId: 1, categoryId: 1, score: 101, jobCount: 1 }]))
      .toThrow(/score/);
    expect(() => aggregateObservations([{ providerId: 1, categoryId: 1, score: 50, jobCount: 0 }]))
      .toThrow(/jobCount/);
  });

  it("caps to the top-N categories by job count when there are more than CIRCUIT_N", () => {
    const obs: RepObservation[] = Array.from({ length: CIRCUIT_N + 3 }, (_v, i) => ({
      providerId: i + 1,
      categoryId: i + 1,
      score: 80,
      jobCount: i + 1, // ascending evidence — the largest categoryIds have the most jobs
    }));
    const tuples = aggregateObservations(obs);
    expect(tuples).toHaveLength(CIRCUIT_N);
    // kept the highest-jobCount categories (the last N), still returned ascending by categoryId.
    expect(tuples[0].categoryId).toBeLessThan(tuples[tuples.length - 1].categoryId);
    expect(Math.min(...tuples.map((t) => t.jobCount))).toBe(4); // dropped the 3 smallest (1,2,3)
  });
});

describe("satisfiesThresholds", () => {
  const tuples = [
    { providerId: 1, categoryId: 1, score: 90, jobCount: 5 },
    { providerId: 2, categoryId: 2, score: 80, jobCount: 5 },
    { providerId: 3, categoryId: 3, score: 70, jobCount: 5 },
  ];

  it("passes a portfolio that clears every gate", () => {
    // weighted avg = (90+80+70)*5 / 15 = 80; 3 categories; 15 jobs.
    expect(satisfiesThresholds(tuples, THRESH).ok).toBe(true);
  });

  it("fails (with a reason) on too few distinct categories", () => {
    const r = satisfiesThresholds(tuples.slice(0, 2), THRESH);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/categor/i);
  });

  it("fails on insufficient weighted-average score", () => {
    const weak = tuples.map((t) => ({ ...t, score: 50 }));
    expect(satisfiesThresholds(weak, THRESH).ok).toBe(false);
  });

  it("fails on insufficient total jobs", () => {
    const few = tuples.map((t) => ({ ...t, jobCount: 1 })); // 3 jobs < minJobs 10
    expect(satisfiesThresholds(few, THRESH).ok).toBe(false);
  });
});

describe("buildRepAggInputs", () => {
  const identity = { agentSecret: 0xabcdn, epoch: 202606n };

  it("assembles circuit-ready inputs from an injected source", async () => {
    const source: RepSource = async () => [
      { providerId: 100, categoryId: 1, score: 90, jobCount: 5 },
      { providerId: 200, categoryId: 2, score: 80, jobCount: 5 },
      { providerId: 300, categoryId: 3, score: 70, jobCount: 5 },
    ];
    const inputs = await buildRepAggInputs("agent-alpha", source, { thresholds: THRESH, identity });
    expect(inputs.minAvgScore).toBe(80);
    expect(inputs.epoch).toBe(202606n);
    expect(inputs.tuples).toHaveLength(3);
    expect(inputs.tuples.map((t) => t.categoryId)).toEqual([1, 2, 3]);
  });

  it("fails fast (no proving) when the portfolio cannot meet the thresholds", async () => {
    const weak: RepSource = async () => [{ providerId: 1, categoryId: 1, score: 50, jobCount: 2 }];
    await expect(buildRepAggInputs("agent-weak", weak, { thresholds: THRESH, identity }))
      .rejects.toThrow(RepOracleError);
  });

  it("fails on an empty portfolio", async () => {
    const empty: RepSource = async () => [];
    await expect(buildRepAggInputs("agent-empty", empty, { thresholds: THRESH, identity }))
      .rejects.toThrow(/empty|no /i);
  });
});
