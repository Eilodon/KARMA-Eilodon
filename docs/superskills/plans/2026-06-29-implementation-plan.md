# KARMA Implementation Plan — Remaining Work (2026-06-29)

> Cross-referenced against `2026-06-29-roadmap-revised.md` and the live codebase.
> Each item includes: current state evidence, concrete implementation steps,
> files to touch, dependencies, and estimated effort.

---

## P0 — Close the Partials

### P0.1 — T1.3: On-chain consumer for cross-chain reputation oracle

**Current state:**
- PROVER SIDE DONE: `src/lib/zk/rep_oracle.ts` builds circuit-ready inputs from
  `RepObservation[]` via an injected `RepSource`. `src/lib/zk/reputation_aggregation.ts`
  generates the Groth16 proof.
- VERIFIER CONTRACT DONE: `contracts-soroban/reputation_aggregation_verifier/src/lib.rs`
  verifies proofs and issues `CredentialRecord` (nullifier, agent, epoch, thresholds).
- GAP: No **consumer** reads `CredentialRecord` to produce a queryable
  `cross_chain_rep(agent) → u32` mapping. The verifier stores credentials but nothing
  downstream aggregates them into a usable reputation value.

**Implementation steps:**

1. **Soroban consumer entrypoint** — Add to `ReputationAggregationVerifier` (or sibling contract):
   - New storage: `DataKey::CrossChainRep(Address) → u32`
   - New fn `update_cross_chain_rep(agent, nullifier)`:
     - Reads the `CredentialRecord` for that nullifier
     - Validates `agent` matches the credential's agent
     - Computes rep value from `min_avg_score` (or a weighted formula)
     - Writes to `CrossChainRep` mapping
   - New view fn `cross_chain_rep(agent) → Option<u32>`
   - Emit `CrossChainRepUpdated { agent, score }` event

2. **Odra mirror** — Port the same consumer logic to `contracts-odra/src/agent_skill_registry.rs`:
   - Option A: Add a `cross_chain_rep` mapping directly to `AgentSkillRegistry`
   - Option B: Separate Odra module (cleaner separation)
   - Should accept a proof of the Soroban credential (or a signed attestation) since
     Casper can't natively read Soroban state

**Files to touch:**
- `contracts-soroban/reputation_aggregation_verifier/src/lib.rs` — add consumer fns
- `contracts-soroban/reputation_aggregation_verifier/src/test.rs` — test consumer
- `contracts-odra/src/` — new module or extend `agent_skill_registry.rs`
- `contracts-odra/src/agent_skill_registry/tests.rs` — test mirror

**Dependencies:** None (verifier already stores credentials)
**Effort:** 2 tasks · **Risk:** MED

---

### P0.2 — T5.2: Replace mocked steps with real ones

**Current state (`src/scripts/demo_cross_chain.ts`):**
- Step 1 (line 115-122): **Hardcoded** `observations[]` array instead of reading live
  `agentReputation()` + `flow_reputation` from Pharos v3 contract
- Step 2 (line 140-150): Falls back to `mockRepAggProof()` (line 62-81) when `make repagg`
  artefacts are absent — produces a deterministic SHA-256 hash labeled "OFFLINE STUB",
  NOT a valid Groth16 proof
- Step 3 (line 161-169): Only prints the wire format, does not actually submit to Soroban

**Implementation steps:**

1. **Step 1 — Live Pharos history**:
   - Wire `karmaService.streamJobCompletedEvents()` or equivalent indexer query as the
     `RepSource` callback instead of canned `observations[]`
   - Requires: Pharos v3 contract address + RPC endpoint in env
   - Fallback: keep the canned data but print a LOUD "[MOCK DATA]" banner

2. **ptau ceremony documentation / enforcement**:
   - Document the `cd circuits && make repagg` step in README or a SETUP.md
   - Make the mock-vs-real state **loudly visible**: when `mockRepAggProof` is used,
     print a prominent warning banner (already partially done at line 90-95,
     but should be more prominent in the output box)
   - OR: commit the ptau artefact as a CI fixture (large file, ~100MB — may need Git LFS)

3. **Step 3 — Real Soroban submission** (gated on P0.1):
   - After P0.1 lands, wire the actual `submit_proof` RPC call using `@stellar/stellar-sdk`
   - Then call the new `update_cross_chain_rep` consumer entrypoint

**Files to touch:**
- `src/scripts/demo_cross_chain.ts` — replace Step 1 + improve Step 2 banners + wire Step 3
- `src/lib/karma_service.ts` — may need a `getRepObservations(agent)` method
- `circuits/Makefile` or `circuits/README.md` — document ceremony

**Dependencies:** P0.1 (for Step 3 to be meaningful)
**Effort:** 2 tasks · **Risk:** LOW

---

### P0.3 — T5.1: Verify or retire the live autonomous-loop path

**Current state (`src/scripts/run_autonomous_loop.ts`):**
- Dry-run mode works: deterministic, network-free, uses `buildDryRunAdapter()`
- `--live` flag exists (line 69): calls `buildLiveAdapter()` + `makeLiveInvoke()` (line 121)
- `makeLiveInvoke()` creates a real `StellarX402Plugin` and calls `plugin.pay()`
- `requireTestnetEnv()` enforces `STELLAR_NETWORK=*testnet*` + `STELLAR_X402_FACILITATOR_URL`
- **UNVERIFIED**: Nobody has confirmed it actually runs end-to-end against testnet
- Discovery is NOT live — uses canned `CANDIDATES[]` (line 60-64) even in live mode
  (comment at line 59 says "live discover_skills wiring is a follow-on")

**Implementation steps:**

1. **End-to-end testnet verification**:
   - Set up testnet credentials (funded Stellar testnet account)
   - Run `pnpm exec tsx src/scripts/run_autonomous_loop.ts --ticks 3 --budget 1 --live`
   - Document the result: success, partial, or broken
   - If broken: fix the wiring or document what's missing

2. **If broken/incomplete** — add explicit docstring at the top of the file:
   ```
   * ⚠️ LIVE MODE STATUS: [VERIFIED|UNTESTED|BROKEN]
   * Last verified: [date] on [network]
   ```

3. **If working** — add a CI smoke test (1 tick, minimal budget, testnet)

**Files to touch:**
- `src/scripts/run_autonomous_loop.ts` — status docstring
- `src/lib/autonomous_loop/runner.ts` — potential fixes
- Possibly a test file

**Dependencies:** None
**Effort:** 1 task · **Risk:** MED (real testnet money)

---

### P0.4 — T2.1: Wire TS composition client to real Odra contract

**Current state (`src/lib/casper/odra_registry.ts`):**
- **JS twin** of the Rust `AgentSkillRegistry` — full re-implementation in TypeScript
- Mirrors all 45 Rust tests' logic: composition, weighted escrow split, self-deal carve-out
- NOT an RPC client — no `casper-js-sdk` calls, pure in-process simulation
- Comment at line 9: "exists so the Casper composition primitive is invocable + discoverable
  through an MCP-shaped tool surface without a live Casper RPC / WASM deploy"
- Risk: drift between JS and Rust implementations grows over time

**Implementation steps:**

1. **Add RPC client mode** (gated behind env flag `CASPER_RPC_URL`):
   - When `CASPER_RPC_URL` is set → use `casper-js-sdk` to call deployed contract
   - When absent → fall back to current in-process simulation (existing behavior)
   - Key methods to wire: `register_skill`, `register_composition`, `create_job`,
     `deliver_result`, `confirm_completion`, `get_skill`, `get_composition`

2. **Interface extraction**:
   - Extract an `IAgentSkillRegistry` interface from the current class
   - Implement `InProcessRegistry` (current code) and `RpcRegistry` (new)
   - `odra_registry.ts` exports a factory that picks based on env

**Files to touch:**
- `src/lib/casper/odra_registry.ts` — extract interface + add RPC path
- `package.json` — add `casper-js-sdk` dependency (if not already present)
- Test files for the RPC path

**Dependencies:** Deployed Odra contract on testnet
**Effort:** 1-2 tasks · **Risk:** LOW-MED

---

## P1 — Trust Kernel: Close Real Economic Risk

### P1.1 — T0.4: Symmetric dispute bond contract

**Current state:**
- RFC DONE: `docs/rfc/2026-06-24-symmetric-dispute-bond.md` — full design with game theory
  analysis, state machine, griefing EV proof
- Solidity `disputeResult()` (line 261 of `AgentSkillRegistry.sol`): **unilateral + free** —
  requester reclaims escrow with zero cost, zero bond, no arbitration
- Odra `dispute_result()` (line 544 of `agent_skill_registry.rs`): same — unilateral refund
- Open questions from RFC §8: `disputeBondBps` default, protocol sink, veto delay, slash step

**Implementation steps (per RFC §7 scope lock):**

1. **Solidity changes** (`contracts/AgentSkillRegistry.sol`):
   - Add to `Job` struct: `disputeBond`, `providerBond`, `disputedAt`
   - New constants: `disputeBondBps` (storage, owner-settable), `MIN_DISPUTE_BOND`,
     `RESPONSE_WINDOW`, `REP_SLASH_STEP`, `REP_FLOOR`
   - New role: `arbiter` (initially = owner)
   - Modify `disputeResult()` → payable, requires bond `B_d = disputeBondBps * escrow / 10_000`
   - New functions: `respondToDispute(jobId)`, `concedeDispute(jobId)`,
     `arbitrate(jobId, verdict)`
   - Verdicts: `ProviderAtFault` (slash rep + return requester bond + forfeit provider bond),
     `RequesterAtFault` (settle as completed + return provider bond + forfeit requester bond)
   - Lift PD-005 monotonic-up invariant (co-deliver with T0.5)

2. **Odra port** (`contracts-odra/src/agent_skill_registry.rs`):
   - Mirror all Solidity changes: same structs, constants, functions
   - New `Error` variants: `InsufficientDisputeBond`, `ResponseWindowOpen`,
     `ResponseWindowClosed`, `NotArbiter`, `AlreadyResponded`, `NotDisputed`

3. **Tests** (both chains):
   - Happy path: unchanged (confirm_completion / claim_after_review)
   - Bonded dispute → provider responds → arbitrate(ProviderAtFault) → rep slashed
   - Bonded dispute → provider responds → arbitrate(RequesterAtFault) → frivolous penalty
   - Bonded dispute → provider concedes → auto-refund + rep slash
   - Unresponsive provider → default concede
   - Optional veto delay test

**Files to touch:**
- `contracts/AgentSkillRegistry.sol` — major changes
- `test/AgentSkillRegistry.t.sol` — new test cases
- `contracts-odra/src/agent_skill_registry.rs` — mirror
- `contracts-odra/src/agent_skill_registry/tests.rs` — mirror tests
- `src/lib/casper/odra_registry.ts` — update JS twin
- `src/lib/contract.ts` — update ABI/interface if applicable

**Dependencies:** Owner sign-off on RFC open questions (OQ-1 through OQ-4)
**Effort:** 3 tasks · **Risk:** HIGH (contract change, real money path)

---

### P1.2 — T0.5: Native on-chain reputation decay

**Current state:**
- `reputationScore` is a raw `uint256` (Solidity line 17) / `u32` (Odra line 98) — monotonic-up
- `agent_rep` is a simple mapping with no timestamp
- Solidity line 180 explicitly warns: "do NOT add a decay feature without changing this"
- No `lastUpdated` field exists anywhere

**Implementation steps:**

1. **Storage migration** (both chains):
   - `reputationScore: u32` → `(score: u32, lastUpdated: u64)` tuple
   - `agent_rep` mapping: same treatment
   - Decay computed at **read time**: `effective_rep = max(FLOOR, stored - decay_rate * elapsed)`
   - Constants: `REP_DECAY_RATE_PER_DAY`, `REP_FLOOR` (shared with T0.4)

2. **Read-time decay function**:
   - `agent_reputation(agent)` now computes: `stored_score - (now - lastUpdated) / DAY * DECAY_RATE`
   - Clamped to `[REP_FLOOR, MAX_REPUTATION]`
   - Write-time: any rep change (completion, slash) resets `lastUpdated = now`

3. **Indexer reconciliation**:
   - BM25 index `reputation_score` field must use the decayed value
   - `src/lib/karma_service.ts` indexer needs to compute decay when hydrating skills

**Files to touch:**
- `contracts/AgentSkillRegistry.sol` — storage + read/write changes
- `contracts-odra/src/agent_skill_registry.rs` — mirror
- Both test suites
- `src/lib/karma_service.ts` — indexer decay computation
- `src/lib/bm25_index.ts` — ensure decayed rep used in boost

**Dependencies:** Co-deliver with P1.1 (T0.4) — same storage layout change
**Effort:** 2 tasks · **Risk:** MED

---

## P2 — Extend What's Already Shipped

### P2.1 — T2.2: Subscription rail

**Current state:**
- T2.1 bond mechanics exist in both Solidity and Odra (deposit_bond, request_bond_unlock,
  withdraw_bond with cooldown)
- No subscription concept exists anywhere in the codebase
- `IPaymentPlugin` interface (`docs/standards/IPaymentPlugin-v1.md`) has `pay()` but no
  `subscribe()` / recurring payment surface

**Implementation steps:**

1. **Contract surface** (both chains):
   - New `Subscription` struct: `{ subscriber, skillId, startedAt, expiresAt, feeEscrowed }`
   - `subscribe_skill(skillId, durationSecs)` — payable, escrows subscription fee
   - `create_job(subscribed: true)` — skips per-call payment if active subscription exists
   - `unsubscribe(skillId)` — pro-rata refund of remaining duration
   - Subscription expiry: checked at `create_job` time

2. **TS surface**:
   - `src/lib/casper/odra_registry.ts` — add subscription methods to JS twin
   - `src/lib/payment/plugin.ts` — consider `IPaymentPlugin.subscribe()` extension

**Files to touch:**
- Both contract files + test suites
- `src/lib/casper/odra_registry.ts`
- `src/lib/payment/plugin.ts` — interface extension
- `docs/standards/IPaymentPlugin-v1.md` — document subscription rail

**Dependencies:** T2.1 bond mechanics (DONE)
**Effort:** 3 tasks · **Risk:** LOW

---

### P2.2 — T1.2: JobCommitmentProof

**Current state:**
- ZK toolchain (Circom + snarkjs + Arkworks BN254) is fully operational
- T1.1 `ReputationAggregationProof` circuit exists at `circuits/reputation_aggregation/`
- T5 `AgentCredentialProof` circuit exists
- No `JobCommitmentProof` circuit exists

**Implementation steps:**

1. **Circuit** (`circuits/job_commitment/`):
   - Public output: `taskHash = Poseidon(skillId, requesterAddrCommit, inputCommit)`
   - Private inputs: `skillId`, `requesterAddrCommit`, `inputCommit`
   - Enables private job creation — requester proves commitment without revealing input

2. **TS prover** (`src/lib/zk/job_commitment.ts`):
   - `generateJobCommitmentProof(skillId, requesterAddr, input) → { proof, taskHash }`
   - Reuse snarkjs Groth16 prover pattern from `reputation_aggregation.ts`

3. **Contract verifier** (optional — could reuse existing verifier with different vkey):
   - Verify the proof on-chain before accepting `create_job(taskHash)`

**Files to touch:**
- `circuits/job_commitment/` — new circuit (Circom)
- `src/lib/zk/job_commitment.ts` — new TS prover
- `circuits/Makefile` — build target
- Tests

**Dependencies:** ZK toolchain (DONE)
**Effort:** 2 tasks · **Risk:** LOW

---

## P3 — Standards Completion + Discovery Polish

### P3.1 — T4.4: ERC-K draft

**Current state:** No draft exists. Should follow P0.1.

**Steps:** Write ERC draft based on the actual proof format T1.1/T1.3 produce once P0.1
lands. Document the `CredentialRecord` structure, `cross_chain_rep` query interface,
and proof verification flow.

**Effort:** 2 tasks · **Risk:** NONE (doc only)

---

### P3.2 — T3.1: Finish vector half of hybrid discovery

**Current state (`src/lib/bm25_index.ts`):**
- BM25 via `MiniSearch` over `(name, description)` — fully operational
- Reputation boost via `boostDocument` callback
- NO vector/embedding/cosine similarity anywhere in the codebase

**Implementation steps:**

1. **Embedding generation**:
   - Add `all-MiniLM-L6-v2` (or similar) via `@xenova/transformers` (runs in Node.js)
   - Embed `(name + " " + description)` for each skill at index time
   - Store embeddings alongside the MiniSearch documents

2. **Hybrid ranking**:
   - On query: embed the query string, compute cosine similarity against all skill embeddings
   - Blend: `finalScore = α * bm25Score + (1-α) * cosineSimilarity` (α tunable, default 0.7)
   - Return blended results

**Files to touch:**
- `src/lib/bm25_index.ts` → rename to `src/lib/discovery_index.ts` or extend
- `package.json` — add `@xenova/transformers` or similar
- Tests

**Dependencies:** None
**Effort:** 2 tasks · **Risk:** LOW

---

## P4 — Backlog (build when needed)

| Item | What | Status | Notes |
|------|------|--------|-------|
| T2.3 | Skill versioning + reputation carryover | NOT STARTED | No version field on `Skill` struct |
| T2.4 | Streaming payments (x402 chunked) | NOT STARTED | x402 plugins exist but only single-shot |
| T3.2 | Collaborative filtering / co-invocation recs | NOT STARTED | No recommendation engine code |
| T3.3 | Marketplace telemetry dashboard | NOT STARTED | `dashboard/` dir used by autonomous loop only |
| T5.3 | Live two-publisher composability | NOT STARTED | Could use second KARMA-MCP instance as backup |

---

## Recommended Execution Order

```
Phase 1 (Foundation — 1-2 weeks):
  P0.1 (T1.3 consumer)     ←── unblocks P0.2, P3.1
  P0.3 (T5.1 verify)       ←── independent, quick
  P0.4 (T2.1 RPC wiring)   ←── independent

Phase 2 (Trust kernel — 2-3 weeks):
  P1.1 (T0.4 dispute bond)  ←── needs owner sign-off on RFC OQs first
  P1.2 (T0.5 rep decay)     ←── co-deliver with P1.1

Phase 3 (Demo completeness — 1 week):
  P0.2 (T5.2 real demo)     ←── depends on P0.1

Phase 4 (Extensions — 2-3 weeks):
  P2.1 (T2.2 subscription)  ←── reuses T2.1 bond mechanics
  P2.2 (T1.2 job commitment)←── reuses ZK toolchain
  P3.2 (T3.1 vector search) ←── independent

Phase 5 (Standards — 1 week):
  P3.1 (T4.4 ERC-K draft)   ←── depends on P0.1

Phase 6 (Backlog — as needed):
  T2.3, T2.4, T3.2, T3.3, T5.3
```

---

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RFC open questions (OQ-1..4) unanswered | Blocks P1.1 entirely | Get owner decision before starting contract work |
| JS/Rust drift in odra_registry | Silent correctness bugs | P0.4 (RPC wiring) eliminates the twin |
| ptau ceremony not run | Demo always uses mock proofs | Document + CI fixture or Git LFS |
| Testnet funding for T5.1 live verify | Can't verify live path | Use Stellar friendbot for testnet XLM |
| `all-MiniLM-L6-v2` binary size | Bloats the runtime | Lazy-load, only when vector search enabled |
