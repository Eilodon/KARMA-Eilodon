/**
 * Off-chain reputation oracle (T1.3) — turns an agent's indexed Pharos reputation into the
 * circuit-ready inputs for a ReputationAggregationProof (T1.1).
 *
 * "My Pharos history is provable on Stellar/Casper without trusting a bridge": this module is the
 * prover-side service. It is PURE — the actual on-chain / indexer read is an injected `RepSource`,
 * so aggregation + threshold pre-flight are deterministic + fully testable. Proof generation +
 * on-chain verification stay in `reputation_aggregation.ts` (T1.1) and the Soroban/Odra verifiers.
 *
 * Aggregation contract (mirrors the circuit): the proof carries up to `CIRCUIT_N` tuples, each a
 * DISTINCT category (the circuit asserts strictly-ascending categoryIds). Raw observations are
 * therefore folded per category (weighted-average score, summed jobs), and if an agent spans more
 * than `CIRCUIT_N` categories the most-evidenced (highest job count) ones are kept.
 */

import {
  CIRCUIT_N,
  type RepAggTuple,
  type RepAggThresholds,
  type RepAggIdentity,
  type RepAggInputs,
} from "./reputation_aggregation.js";

export class RepOracleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepOracleError";
  }
}

/** One observed reputation cell for an agent, as the Pharos indexer / flow_reputation would emit. */
export interface RepObservation {
  /** Counterparty / provider id for the cell. */
  providerId: number;
  /** Skill category id — MUST be >= 1 (0 is the circuit's padding sentinel). */
  categoryId: number;
  /** Outcome score in [0, 100]. */
  score: number;
  /** Jobs aggregated into this observation — MUST be >= 1. */
  jobCount: number;
}

/** Source of an agent's reputation observations — injected so the oracle stays network-free. */
export type RepSource = (agent: string) => Promise<RepObservation[]>;

export interface OracleOptions {
  thresholds: RepAggThresholds;
  identity: RepAggIdentity;
}

interface Cell {
  weightedScore: number; // Σ score*jobCount
  jobs: number; // Σ jobCount
  dominantProvider: number;
  dominantJobs: number;
}

/** Fold raw observations into ≤ CIRCUIT_N distinct-category tuples, ascending by categoryId. */
export function aggregateObservations(obs: RepObservation[]): RepAggTuple[] {
  const cells = new Map<number, Cell>();
  for (const o of obs) {
    if (!Number.isInteger(o.categoryId) || o.categoryId < 1) {
      throw new RepOracleError(`categoryId must be an integer >= 1 (0 is the padding sentinel); got ${o.categoryId}`);
    }
    if (!Number.isInteger(o.score) || o.score < 0 || o.score > 100) {
      throw new RepOracleError(`score must be an integer in [0,100]; got ${o.score}`);
    }
    if (!Number.isInteger(o.jobCount) || o.jobCount < 1) {
      throw new RepOracleError(`jobCount must be an integer >= 1; got ${o.jobCount}`);
    }
    const cell = cells.get(o.categoryId) ?? { weightedScore: 0, jobs: 0, dominantProvider: o.providerId, dominantJobs: 0 };
    cell.weightedScore += o.score * o.jobCount;
    cell.jobs += o.jobCount;
    if (o.jobCount > cell.dominantJobs) {
      cell.dominantJobs = o.jobCount;
      cell.dominantProvider = o.providerId;
    }
    cells.set(o.categoryId, cell);
  }

  let tuples: RepAggTuple[] = [...cells.entries()].map(([categoryId, c]) => ({
    providerId: c.dominantProvider,
    categoryId,
    score: Math.round(c.weightedScore / c.jobs),
    jobCount: c.jobs,
  }));

  // Keep the most-evidenced categories if the agent spans more than the circuit allows.
  if (tuples.length > CIRCUIT_N) {
    tuples = [...tuples].sort((a, b) => b.jobCount - a.jobCount).slice(0, CIRCUIT_N);
  }
  // Ascending by categoryId — the circuit's distinctness order (the wrapper also sorts, but a
  // deterministic order here keeps the oracle's output stable + testable).
  return tuples.sort((a, b) => a.categoryId - b.categoryId);
}

export interface ThresholdCheck {
  ok: boolean;
  reason?: string;
}

/** Pre-flight the aggregated portfolio against the gates — same relations the circuit asserts. */
export function satisfiesThresholds(tuples: RepAggTuple[], t: RepAggThresholds): ThresholdCheck {
  const distinct = tuples.length; // each tuple is a distinct category by construction
  if (distinct < t.minDistinctCategories) {
    return { ok: false, reason: `distinct categories ${distinct} < required ${t.minDistinctCategories}` };
  }
  const totalJobs = tuples.reduce((acc, x) => acc + x.jobCount, 0);
  if (totalJobs < t.minJobs) {
    return { ok: false, reason: `total jobs ${totalJobs} < required ${t.minJobs}` };
  }
  // Avoid division: Σ(score*jobCount) >= minAvgScore * totalJobs.
  const weighted = tuples.reduce((acc, x) => acc + x.score * x.jobCount, 0);
  if (weighted < t.minAvgScore * totalJobs) {
    return { ok: false, reason: `weighted avg score below required ${t.minAvgScore}` };
  }
  return { ok: true };
}

/** Build circuit-ready RepAggInputs from an agent's indexed reputation; throws fail-fast if the
 *  portfolio is empty or cannot satisfy the thresholds (cheaper than discovering it mid-proving). */
export async function buildRepAggInputs(
  agent: string,
  source: RepSource,
  opts: OracleOptions,
): Promise<RepAggInputs> {
  const obs = await source(agent);
  if (obs.length === 0) {
    throw new RepOracleError(`empty reputation portfolio for ${agent}: no observations to prove`);
  }
  const tuples = aggregateObservations(obs);
  const check = satisfiesThresholds(tuples, opts.thresholds);
  if (!check.ok) {
    throw new RepOracleError(`portfolio cannot meet thresholds: ${check.reason}`);
  }
  return { ...opts.thresholds, ...opts.identity, tuples };
}
