# ADR 2026-06-25 — T1.3 cross-chain reputation oracle (prover-side service)

- **Status:** Accepted
- **Owner:** KARMA maintainer (gokuderafight@gmail.com)
- **Complexity:** C2 · **Relates:** T1.1 (ReputationAggregationProof), T5.2 (cross-chain demo)

## Context

T1.3 wants a portable behavioural credential: "my Pharos history is provable on Stellar/Casper
without trusting a bridge". The roadmap names three pieces — off-chain prover service, Soroban
consumer cache, Odra consumer. Investigation of the shipped surface:

- The off-chain **prover service was missing**: `demo_cross_chain.ts` fabricated canned `repHistory`
  rows; `reputation_aggregation.ts` (T1.1) only generates the proof, it does not turn indexed
  reputation into circuit tuples.
- The **consumer cache largely exists**: `reputation_aggregation_verifier` already stores an
  **agent-bound** `CredentialRecord` (keyed by per-epoch nullifier) that any skill can gate on by
  `(epochRoot, threshold)` — that *is* the cross-chain rep cache, privacy-preserving by design.

## Decision

Ship the missing prover-side service as a pure, injectable JS module; treat the on-chain consumer as
already satisfied by the existing verifier for v1.

- `src/lib/zk/rep_oracle.ts` — `aggregateObservations` (fold raw observations into ≤ `CIRCUIT_N`
  distinct-category tuples: weighted-avg score, summed jobs, dominant providerId, top-N by evidence,
  ascending categoryId), `satisfiesThresholds` (pre-flight the exact gate relations the circuit
  asserts — fail fast before proving), `buildRepAggInputs` (compose from an injected `RepSource`).
- `demo_cross_chain.ts` rewired to flow through the oracle instead of canned rows (productized path).
- 10 vitest cases.

## Consequences

- ✅ The off-chain prover is real + tested; the demo's Step 1→2 now runs the genuine aggregation.
- ✅ Consumer cache needs no new contract for v1 — the existing nullifier+agent `CredentialRecord`
  serves the gate-by-(epochRoot, threshold) use case.
- ⬜ **Follow-ons (P3):** a live `RepSource` over `karmaService.streamJobCompletedEvents()` +
  flow_reputation (the injected seam is ready); the **Odra** consumer for parity with Soroban;
  optional address-keyed cache if a non-private lookup is ever required.

## Trigger to revisit

When a skill needs a **non-private, address-keyed** cross-chain rep lookup (today's nullifier-keyed
credential is privacy-preserving), or when the live Pharos indexer source is wired for a real run.
