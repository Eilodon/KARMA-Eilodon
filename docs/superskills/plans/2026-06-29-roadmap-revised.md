# KARMA Roadmap — Revised (2026-06-29)

> Supersedes `KARMA Strategic Roadmap.txt`. That document is now stale: several
> items it lists as open are done, one item it lists as done ("T1.3 cross-chain
> reputation oracle... merged") is only half-done, and several "MISSING" items
> it predicted are confirmed still missing. This doc is the corrected state +
> a priority-ordered punch list. No deadlines — priority order only.

## Audit baseline (2026-06-29, evidence-checked against code, not memory)

| Status | Count | Items |
|---|---|---|
| DONE | 10 | T0.1, T0.2, T0.3, T1.1, T1.4(fallback), T2.1, T4.1, T4.2, T4.3, T5.4 |
| PARTIAL | 4 | T1.3 (prover-only, no on-chain consumer), T3.1 (BM25 only, no vector half), T5.1 (real decision logic, simulated env), T5.2 (real 6-step flow, mocked Pharos history + mock ZK proof) |
| MISSING | 10 | T0.4, T0.5, T1.2, T2.2, T2.3, T2.4, T3.2, T3.3, T4.4, T5.3 |

Full evidence (file:line) for each item is in the conversation that produced this
doc — not duplicated here to avoid drift; re-audit before trusting old citations.

## Why this order

Fix-partials-first: don't let half-built "wow" claims (T1.3, T5.2) sit broken
while building new features on top of them. Then close real economic risk in
the trust kernel (T0.4/T0.5, now unblocked since T0.3's RFC is done). Then
extend what already shipped (T2.1's composition) before starting net-new
features. Net-new feature tracks (T2.2-T2.4, T3.2-T3.3, T4.4) are
lowest-priority — schedule per actual signal, not aspiration.

---

## P0 — Close the partials (correctness debt on claimed-done work)

### P0.1 — T1.3: on-chain consumer for cross-chain reputation oracle
**Gap:** `src/lib/zk/rep_oracle.ts` only builds proofs (prover-side). No
`crossChainRepCache[addr]`-equivalent consumer exists on Soroban or Odra — the
verifier contract issues/stores credentials but nothing reads them into a
cross-chain-recognized reputation value.
**Scope:** add a consumer entrypoint on the Soroban `reputation_aggregation_verifier`
(or a sibling contract) that, given a verified proof, updates a queryable
`cross_chain_rep` mapping keyed by agent identity; mirror on Odra.
**Why first:** T5.2's demo currently fakes this exact step (mock proof, hardcoded
Pharos history) — fixing T1.3 properly is the prerequisite for T5.2 to become
real instead of narrated.
**Effort:** 2 tasks (Soroban consumer + Odra consumer). **Risk:** MED.

### P0.2 — T5.2: replace mocked steps with real ones
**Gap:** Pharos reputation history is hardcoded (`demo_cross_chain.ts` Step 1);
Groth16 proof degrades to a labeled mock stub unless `make repagg` (ptau
ceremony) was run.
**Scope:** (a) Step 1 reads live `agentReputation()` + flow_reputation off the
real Pharos v3 contract instead of a hardcoded array. (b) run/document the
ptau ceremony so the demo always produces a real proof, not a stub — or make
the mock-vs-real state loudly visible in demo output (no silent degrade).
**Gate:** depends on P0.1 for the verify step to mean anything.
**Effort:** 2 tasks. **Risk:** LOW (no contract changes, wiring only).

### P0.3 — T5.1: verify or retire the live autonomous-loop path
**Gap:** `run_autonomous_loop.ts` (gated on `KARMA_AUTONOMOUS_LIVE=1`) is
referenced but unverified — unknown if it actually runs against live
Stellar/Casper x402 rails.
**Scope:** either run it end-to-end on testnet once and document the result,
or if it's unfinished/broken, say so explicitly in the script's docstring
instead of implying a working live mode.
**Why:** an unverified "live mode" flag is worse than no flag — it invites
someone to trust a path nobody has confirmed works.
**Effort:** 1 task (mostly verification, possibly a fix). **Risk:** MED
(real testnet money path, even if small).

### P0.4 — T2.1: wire the TS composition client to the real Odra contract
**Gap:** `src/lib/casper/odra_registry.ts` is a parallel JS re-implementation
of the Rust settlement math, not an RPC client against the deployed contract.
Correct today only because both implementations were hand-kept in sync.
**Scope:** replace (or gate behind a flag) the JS simulation with a real
casper-js-sdk RPC call path once the Odra contract is deployed live.
**Effort:** 1-2 tasks. **Risk:** LOW-MED (drift risk between the two
implementations grows the longer this is deferred).

---

## P1 — Trust kernel: close real economic risk (now unblocked)

### P1.1 — T0.4: symmetric dispute bond contract
**Gate cleared:** T0.3's RFC (`docs/rfc/2026-06-24-symmetric-dispute-bond.md`)
is done and meets its own acceptance bar (chosen design + griefing EV +
safety argument) — this was the explicit blocker, so it's now unlocked.
**Scope:** per the RFC's chosen design — `disputeResult(jobId)` requires a
requester bond = X% of escrow, loser-pays, `arbitrate(jobId, verdict)`
owner-arbiter v1. Port to both Solidity and Odra + tests.
**Effort:** 3 tasks. **Risk:** HIGH (contract change, real money path).

### P1.2 — T0.5: native on-chain reputation decay
**Scope:** `reputationScore` storage moves from raw `uint256` counter to
`(score, lastUpdated)`, decay computed at read time. Companion to P1.1 —
do together since both touch the same storage layout.
**Effort:** 2 tasks (contract + indexer reconciliation). **Risk:** MED.

---

## P2 — Extend what's already shipped

### P2.1 — T2.2: subscription rail
**Why now, not later:** explicitly reuses T2.1's bond mechanics (already
built and tested) — cheapest net-new feature on the list because the hard
part (escrow/bond lifecycle) already exists.
**Scope:** `subscribe_skill(skillId, durationSecs)` escrows the subscription
fee for the duration; `create_job(subscribed:true)` skips per-call payment;
unsubscribe/expire releases the bond.
**Effort:** 3 tasks. **Risk:** LOW.

### P2.2 — T1.2: JobCommitmentProof
**Why now:** same ZK toolchain as T1.1 (already built and proven out) — cheap
to add while the circuit/prover machinery is warm, vs. re-spinning it up
later from cold.
**Scope:** prove `taskHash = Poseidon(skillId, requesterAddrCommit,
inputCommit)` without revealing input; enables private job creation.
**Effort:** 2 tasks. **Risk:** LOW.

---

## P3 — Standards completion + discovery polish

### P3.1 — T4.4: ERC-K draft (cross-chain reputation proof format)
**Gate:** should follow P0.1, not precede it — drafting a public standard for
a cross-chain reputation format before the on-chain consumer exists risks
specifying the wrong interface.
**Scope:** draft ERC proposing the reputation-proof format T1.1/T1.3
actually produce once P0.1 lands; submit to ethereum-magicians + adjacent
Stellar/Casper forums.
**Effort:** 2 tasks. **Risk:** NONE (doc only).

### P3.2 — T3.1: finish the vector half of hybrid discovery
**Gap:** only BM25 exists today; the roadmap's "hybrid BM25 + cosine
similarity" is half-built.
**Scope:** embed `(name, description)` via a local model (e.g.
all-MiniLM-L6-v2), blend cosine similarity into the existing MiniSearch
ranking.
**Effort:** 2 tasks. **Risk:** LOW.

---

## P4 — Backlog (do per actual signal, not on a schedule)

These are confirmed MISSING and not blocking anything else. No evidence any
of them are currently load-bearing for a demo or a user request — build when
something concrete needs them, not preemptively:

- **T2.3** — skill versioning + reputation carryover
- **T2.4** — streaming payments (x402 chunked, heartbeat protocol)
- **T3.2** — collaborative filtering / co-invocation recommendations
- **T3.3** — marketplace telemetry dashboard
- **T5.3** — live two-publisher composability (needs an external partner —
  or build the backup the original roadmap itself suggested: a second
  KARMA-MCP instance acting as the other publisher, removing the external
  dependency entirely)

---

## Carried-over anti-roadmap (still valid, unchanged from original)

1. No full TEE pipeline before T3N testnet 404 resolves.
2. No reputation slashing via dispute before P1.1 (T0.4) ships — would be a
   griefing weapon, which is exactly what P1.1 exists to prevent.
3. No chain-specific rewrites (e.g. Soroban-only escrow) — chain-agnostic
   positioning is the moat.
4. No `IPaymentPlugin` surface expansion beyond quote/pay/verify.
5. No KARMA token.
6. No agent-governance-DAO demo.
7. No UI beyond the marketplace telemetry dashboard (P4) — devs are the user.
