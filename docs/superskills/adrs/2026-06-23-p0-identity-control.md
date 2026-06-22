# ADR: P0 — Make the identity gate a non-bypassable, composable control

## 1. Title
Bind a skill's identity requirement to an on-chain `identityPolicy` flag and enforce it on the single
`create_job` path, backed by a shared TTL'd DID session store.

## 2. Context
KARMA's README promised agents *"cannot act anonymously… identity is required, not optional,"* but the
code contradicted it: only `t3_create_verified_job` checked the DID, while the universal `create_job`
checked reputation only. Any agent with sufficient reputation created a job for a "gated" skill via
`create_job`, skipping `t3_verify_identity` entirely — identity was **caller-opt-in, not skill-enforced**
(a demo prop, not a control). A `did:t3n` cannot be verified on-chain (it is proven off-chain via
SIWE/WASM), so the requirement had to be enforced server-side while remaining composable. Decided in
the D1–D5 tradeoff study ([plans/2026-06-23-d1-d5-tradeoff-study.md](../plans/2026-06-23-d1-d5-tradeoff-study.md)).

## 3. Decision
Added a declarative `uint8 identityPolicy` to the `Skill` struct (v4 contract) — `0` none, `1`
T3N-verified, `2` T3N-verified-fresh, `≥3` unknown — set at `registerSkill` and via owner-only
`setIdentityPolicy`. `create_job` now reads this on-chain (authoritative `readSkill`) and enforces it
**after** the existing-job idempotency short-circuit (audit L7): an absent/expired/address-mismatched
session → `identity_required`, a stale policy-2 session → `identity_stale`, an unknown policy →
`identity_policy_unknown` (fail-closed). Enforcement state lives in a new **shared**
`IdentitySessionStore` (`src/lib/identity_session.ts`) that both `t3_verify_identity` (writer) and
`create_job` (reader) import — avoiding a backwards Layer1→Layer3 dependency. `t3_create_verified_job`
is marked DEPRECATED (it still enforces, so it is not a lax path). README corrected to state the
enforcement asymmetry honestly (reputation contract-enforced; identity server-enforced on the
KARMA-mediated path).

## 4. Status
ACCEPTED (local implementation complete on `feat/p0-identity-control`; live Pharos v4 redeploy is a
gated follow-up — see §8b).

## 5. Consequences
**Improved:** the README's core promise is now true for the KARMA-mediated path; identity is a real,
unbypassable control with a single enforcement path (INV-1); the requirement is on-chain (composable,
credibly committed) and future-proof (uint8 leaves room for more issuers/tiers); the volatile
module-level DID cache is replaced by a shared, TTL'd, address-bound store.
**Worsened / debt:** a fresh v4 contract is required to go live (loses v3 on-chain state unless
migrated — gated); the session store is still in-memory (restart-volatile; multi-replica needs redis).
**Inherent limitation (documented, not a regression):** an actor calling the raw contract `createJob`
directly bypasses the identity gate (but not the on-chain reputation gate) — identity is a guarantee of
the KARMA-mediated path only, because a DID cannot be verified on-chain.

## 6. Alternatives Considered
- **Off-chain-only requirement registry** (no contract change): rejected — makes the KARMA server the
  sole, opaque oracle of policy; not composable; not credibly committed (server could rug the rule).
- **Naked `bool requiresVerifiedIdentity`**: rejected — forces a redeploy when a second issuer/tier
  appears; `uint8` enum is the same gas with headroom.
- **Enforce identity inside the contract**: impossible — the chain cannot verify a `did:t3n`.
- **Re-verify every `create_job` against T3N**: rejected (D3) — couples KARMA liveness to T3N per job;
  TTL'd sessions + a policy-2 fresh tier give loose coupling with a high-assurance escape hatch.

## 7. Evidence
- `forge test` → **37 passed** (3 new: defaults/owner-only/persisted-policy) `[verified 2026-06-23]`.
- `pnpm test` (full Vitest) → **470 passed, 1 skipped, 59 files** (was 457/58); +5 IdentitySessionStore,
  +7 create_job identity-gate matrix (incl. FM3 mismatch, policy-2 stale, unknown-policy fail-closed,
  L7 retry ordering), +1 register_skill index `[verified 2026-06-23]`.
- `pnpm typecheck` → exit 0 `[verified 2026-06-23]`.
- ABI drift guard → 4/4 (abi.ts matches recompiled v4 artifact) `[verified 2026-06-23]`.
- STRIDE review: no other `createJob` callers (grep) → INV-1 holds; `create_job` reads identityPolicy
  via on-chain `readSkill` (authoritative) `[verified 2026-06-23]`.
- Live T3N verify→session→create_job end-to-end `[assumed — requires KEYSTORE_PASSWORD + T3N testnet;
  not run this session; covered by unit matrix + existing t3_payroll_smoke]`.

## 8. Owner
bao.nt.1992@gmail.com (KARMA)

## 8b. Known Debts (PATTERN-DEBT)
- **PATTERN-DEBT-T3N-001** (volatile DID cache): **partially addressed** — centralized into a shared,
  TTL'd, address-bound store (no longer an ad-hoc module Map), but still in-memory ⇒ restart-volatile
  and single-process-only. Full closure travels with the redis-backed session parity needed for
  multi-replica (audit L2).
- **PATTERN-DEBT-P0-IDENTITY-OFFCHAIN** (NEW): identity enforcement is off-chain-only by necessity;
  direct-to-contract `createJob` bypasses it. Accepted; documented in README + spec FM1.
- **PATTERN-DEBT-P0-DUAL-PATH** (NEW, MEDIUM): two job-creation tools still exist (`create_job` +
  deprecated `t3_create_verified_job`); both enforce, so no bypass, but INV-1 is only literally "one
  path" once `t3_create_verified_job` is removed.
- Residual (audit Abductive-2): a briefly-compromised key can mint a session valid for the TTL even
  after control is lost; bounded by short TTL + policy-2 fresh tier; a revocation check closes it.

## 9. Next Cycle Trigger
When the live Pharos v4 redeploy is scheduled (owner-confirmed), OR when KARMA is deployed with more
than 1 replica (redis session parity becomes mandatory — fail-closed), OR when a second identity issuer
beyond T3N is required (define `identityPolicy` value ≥3 + its server enforcement).

## 10. Cycle Retrospective
- The README claim was the bug, not just the code: marketing outran enforcement. Future agents — treat
  headline trust claims as test assertions and grep for the bypass before believing them.
- Identity is structurally un-enforceable on-chain (no DID verification opcode); the honest design is
  on-chain *policy* + server *enforcement*. Don't promise contract-grade guarantees for identity.
- The Skill getter tuple grew 10→11: every Foundry destructure and the TS decoder must move together;
  the ABI drift guard caught it instantly — keep that guard.
- Adding `public constant`s silently adds ABI getters (3 here) — the drift guard counts them; expect
  +N entries per constant.
- Knowingly deferred: live v4 redeploy + redis session parity. Next cycle must decide v3→v4 state
  migration (re-register skills vs snapshot) before cutover.
