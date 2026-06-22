---
title: "P0 — Make the identity gate a non-bypassable, composable control"
status: draft
SPEC_APPROVED: true
SPEC_APPROVED_BY: owner (gokuderafight@gmail.com) — "dùng quy trình superskills vừa viết spec vừa thực thi P0"
date: 2026-06-23
depends_on:
  - docs/superskills/plans/2026-06-23-post-demo-roadmap.md
  - docs/superskills/plans/2026-06-23-d1-d5-tradeoff-study.md
---

# P0 — Identity as a real control

## Problem
KARMA's README asserts agents *"cannot act anonymously: a Terminal3 verifiable identity is
required before any high-value job"* and *"trust is dual-layer, not optional."* The code
contradicts this: the identity check lives only in `t3_create_verified_job`, while the universal
`create_job` path checks reputation only. Any agent with sufficient reputation creates a job for a
"gated" skill via `create_job`, skipping `t3_verify_identity` entirely. **Identity is caller-opt-in,
not skill-enforced — a demo prop, not a control.** This spec makes the promise true.

## Architectural truth (constraint, not a choice)
A `did:t3n` cannot be verified on-chain (it is T3N state proven via SIWE/WASM). Therefore:
- **Policy** (does a skill require identity, and at what assurance) lives **on-chain** — for
  composability (SKILL.md: "all composable") and credible commitment (the rules of the trust game
  are public + immutable, not server-mutable).
- **Enforcement** happens **server-side** in the trusted in-process plugin — the only place that can
  check a DID. This adds no new trust assumption beyond KARMA's existing in-process-trusted model.

## Design decisions (from D1–D5 tradeoff study)
- **D1:** On-chain `uint8 identityPolicy` enum on `Skill` (not a bool). Future-proof against
  multi-issuer identity without a redeploy.
- **D2:** Exactly **one** job-creation enforcement path. Fold the identity check into `create_job`;
  retire `t3_create_verified_job` (thin deprecated alias for one release, zero enforcement
  difference).
- **D3:** DID sessions persisted with a TTL (loose coupling to T3N liveness). A high-assurance
  policy value forces fresh re-verification.

### `identityPolicy` value semantics (server interpretation)
| Value | Name | create_job requires |
|---|---|---|
| 0 | `NONE` | nothing (open skill) |
| 1 | `T3N_VERIFIED` | a non-expired verified DID session for the caller |
| 2 | `T3N_VERIFIED_FRESH` | a freshly verified DID (session age below a tight high-assurance bound) |
| ≥3 | unknown | **fail closed** — reject (server cannot satisfy an unknown policy) |

## Scope

### In scope (this cycle — local implementation + tests only)
1. **Contract (AgentSkillRegistry v4):**
   - Add `uint8 identityPolicy` to `Skill` (after `minReputationToInvoke`).
   - `registerSkill` gains a trailing `uint8 identityPolicy` param.
   - New `setIdentityPolicy(uint256 skillId, uint8 policy)` — owner-only, mirrors `setMinReputation`.
   - New event `IdentityPolicySet(uint256 indexed skillId, uint8 policy)`; emit `identityPolicy` in
     `SkillRegistered` (append, non-indexed) is **not** required — keep `SkillRegistered` stable and
     let the indexer hydrate via `readSkill` (existing pattern). *(Decision: avoid churning the
     indexed event; indexer already re-reads full skill state on `SkillRegistered`.)*
   - No on-chain enforcement of identity (cannot verify a DID on-chain). Reputation gate unchanged.
2. **`IdentitySessionStore` (P0-b):** a **shared** module both `karma.tool.ts` (Layer 1) and
   `t3.tool.ts` (Layer 3) import — so `create_job` can enforce identity without a backwards
   Layer1→Layer3 dependency. Stores `agentId → { did, address, verifiedAt, expiresAt }`. Replaces the
   volatile module-level `verifiedDids` Map (closes PATTERN-DEBT-T3N-001). Config:
   `T3N_SESSION_TTL_SECS` (default 600), `T3N_SESSION_FRESH_MAX_AGE_SECS` (default 120, for policy=2).
   **This cycle:** interface + in-memory TTL impl, fully tested (sufficient for the current
   single-process deployment). **Redis-backed parity** is required only for multi-replica and
   therefore travels with the gated multi-replica deploy (audit L2) — not this cycle.
3. **`create_job` unification:** read `skill.identityPolicy`; enforce per the table above against the
   session store before the reputation gate. Structured rejection (`reason: "identity_required"` /
   `"identity_stale"` / `"identity_policy_unknown"`) — same shape as the existing reputation
   rejection. This is the single enforcement path.
4. **Plumbing:** `abi.ts` (struct +field, registerSkill sig, setIdentityPolicy fn, event),
   `Skill`/`SkillDocument` types (+`identity_policy`), `skillDocFromChain`, `discover_skills` output
   (surface `identity_policy`), `register_skill` tool (+optional param), `register_payroll_skill.ts`
   (set policy=1).
5. **`t3.tool.ts`:** `t3_verify_identity` writes the session store; `t3_create_verified_job` becomes
   a thin deprecated delegator to the unified `create_job` logic.
6. **Tests:** Foundry (identityPolicy register/set/owner-only + tuple updates), Vitest
   (IdentitySessionStore TTL/expiry + memory/fs/redis, create_job enforcement matrix, t3 tool
   session write/read, deprecation alias).

### Out of scope (gated follow-ups — require explicit owner confirmation)
- **Live Pharos v4 redeploy + env/address cutover.** Outward, hard-to-reverse, funded; v3 holds
  seeded reputation/bonds. Work lands on a feature branch; the running main/live config keeps v3
  until a deliberate, confirmed migration. State migration strategy (re-register skills vs snapshot)
  is its own decision.
- P1 discovery boost/filter by identity (this cycle only *surfaces* the field).
- P3 reputation downside.

## Invariants (must hold after)
- **INV-1:** Exactly one job-creation enforcement path. No tool creates jobs bypassing the
  identity+reputation gates.
- **INV-2:** Raw private keys never leave `KeystoreManager` (unchanged — sessions store only the DID).
- **INV-3:** Unknown `identityPolicy` fails closed (never opens a skill it cannot gate).
- **INV-4:** `identityPolicy = 0` skills behave exactly as today (full backward compat for open skills).
- **INV-5:** ABI drift guard green — `abi.ts` matches the recompiled artifact.

## Risks
- **R-1 (tuple ripple):** the `skills` getter grows 10→11 fields; every Solidity test destructuring
  `reg.skills(...)` and every TS decoder must update together. Mitigation: drift guard + full
  Foundry/Vitest suites.
- **R-2 (live/main inconsistency):** updating `abi.ts` to v4 while live contract is v3 would break a
  server pointed at v3. Mitigation: feature branch; no redeploy this cycle; cutover gated.
- **R-3 (fail-open regression):** a bug that treats unknown/expired sessions as valid reopens the
  bypass. Mitigation: INV-3 explicit fail-closed tests.

## Acceptance
- Foundry: new identityPolicy tests pass; all existing tests pass with updated tuples.
- Vitest: full suite green (currently 457 passed, 1 skipped) + new P0 tests.
- `pnpm typecheck` + `pnpm test:contract` green.
- A gated skill (policy ≥1) cannot be invoked via `create_job` without a valid session — proven by test.

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-06-23 | trigger: NORMAL -->

**Tier:** 3 (on-chain escrow payments + identity + payroll context) | **Date:** 2026-06-23

### Failure Modes
1. **Off-chain enforcement boundary** — identity is enforced ONLY on the KARMA-server-mediated path;
   the chain cannot verify a DID, so an actor calling `AgentSkillRegistry.createJob` **directly**
   bypasses identity entirely (the on-chain reputation gate still holds; identity does not). The
   `identityPolicy` flag is on-chain *policy*, not on-chain *enforcement*. — **HIGH** — mitigation in
   plan: YES (document the trust boundary explicitly; tighten the README claim to "when transacting
   via KARMA"; identity is a property of the mediated path, reputation is the contract-enforced gate).
2. **Fail-open on session-store unavailability** — if the `IdentitySessionStore` (e.g. redis) errors
   or is unreachable, a naive `create_job` could treat "no session found" the same as "store down"
   and either reject legitimately or, if coded wrong, skip the check. — **HIGH** — mitigation in plan:
   YES (INV-3 fail-closed: any store error → reject; explicit test for store-error path).
3. **Session borrowing across agents** — sessions key by `agentId`; if the DID session is not bound
   to the same resolved address that `create_job` transacts as, agent A could ride agent B's verified
   DID. — **MED** — mitigation in plan: YES (session stores the verified address; create_job asserts
   `session.address === keystore.getAddress(agentId)` before honoring it).

### Layer Signals
- **L1 Logic:** policy=2 ("fresh") needs a defined freshness bound distinct from the TTL — otherwise
  it collapses into policy=1. Plan must specify `T3N_FRESH_MAX_AGE_SECS` (≪ TTL).
- **L2 Concurrency / multi-replica:** memory/fs session stores do NOT work across replicas — a session
  written on replica A is invisible to B. Only redis gives multi-replica correctness. Plan: document
  that policy≥1 in a multi-replica deployment REQUIRES `STORAGE_DRIVER=redis` (or a shared session store).
- **L4 Integration:** initial verification still depends on T3N reachability; if T3N is down, no new
  sessions can be minted, so policy≥1 skills are un-invokable by un-verified agents (TTL only helps the
  already-verified). Acceptable; note in plan.
- **L6 Observability:** identity rejections must be logged/metered (structured reason) so a bypass
  attempt or a fail-closed storm during a store outage is detectable in prod. Plan: emit telemetry.
- **L7 Cross-cutting (idempotency ordering):** `create_job` is idempotent by `taskHash`. If the
  identity check runs BEFORE the existing-job short-circuit, a retry of an already-created job whose
  session has since expired would be wrongly rejected — breaking exactly-once semantics. Plan must fix
  ordering: existing-job idempotency check short-circuits FIRST; identity is enforced only for genuinely
  new jobs.

### Assumptions to Verify
- **ASSUMED:** "enforcement happens server-side in the trusted in-process plugin adds no new trust
  assumption" — true only while ALL job creation is KARMA-mediated (see FM1). Must be stated, not assumed.
- **ASSUMED:** fresh v4 deploy means storage-layout migration is moot — true (no proxy/upgrade; new
  contract). But existing v3 on-chain state (skills, reputation, bonds) is NOT carried over — the
  gated migration step owns that decision.
- **ASSUMED:** `T3N_SESSION_TTL_SECS` default 600 is "short enough" — revisit against revocation
  sensitivity for the highest-value skills (covered by policy=2 fresh tier).

### Abductive Hypotheses
- **Abductive 1 (component interaction):** identity enforced off-chain + reputation enforced on-chain
  gives the two gates **asymmetric strength**. A consumer reasoning "both gates are equally strong"
  will mis-model risk. The asymmetry is correct by necessity but must be documented so no downstream
  feature (or audit, or marketing) treats identity as contract-guaranteed.
- **Abductive 2 (scale/adversarial):** a key briefly compromised can mint a verified session that then
  survives for the full TTL even after control is lost / the T3N identity is revoked. Short TTL +
  policy=2 (fresh) bound the window; a future revocation-check closes it. Flag as residual debt.

### Gate Result
PASS WITH FLAGS — proceed to writing-plans. The HIGH findings are inherent-but-acceptable given the
architectural constraint (chain cannot verify DIDs); writing-plans MUST include: (a) explicit
trust-boundary documentation + README wording fix for FM1, (b) fail-closed handling + test for FM2,
(c) session-address binding for FM3, and (d) idempotency-ordering fix for L7.
