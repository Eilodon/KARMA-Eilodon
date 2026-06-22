# P0 Identity-Control Implementation Plan

> **For agentic workers:** execute task-by-task with `executing-plans`. TDD each task.

**Goal:** Make the identity gate non-bypassable by folding it into the single `create_job` path,
backed by an on-chain `identityPolicy` flag and a shared, TTL'd DID session store.
**Architecture:** On-chain `uint8 identityPolicy` declares policy (composable, committed);
server-side `create_job` enforces it (chain can't verify DIDs) against a shared `IdentitySessionStore`
that `t3_verify_identity` populates. Exactly one job-creation enforcement path (INV-1).
**Tech Stack:** Solidity 0.8.24 (Foundry), TypeScript/ESM, viem, Vitest, zod/v4.
**Audit Gate:** PASS WITH FLAGS.
**Risk Flags:** see task-risk-score section at end.

Sequencing: Task 1 (session store, no deps) → Task 2 (contract, no client deps) → Task 3 (abi+service
plumb) → Task 4 (create_job enforcement) → Task 5 (t3 tool rewire + deprecation) → Task 6 (register
tool + indexer + script) → Task 7 (README trust-boundary fix). Each is independently committable.

---

### Task 1 — Shared `IdentitySessionStore` (P0-b, closes FM3 + PATTERN-DEBT-T3N-001)

**Files:**
- Create: `src/lib/identity_session.ts`
- Test: `src/__tests__/identity_session.test.ts`
- Modify: `src/config/env.ts` (add `T3N_SESSION_TTL_SECS`, `T3N_SESSION_FRESH_MAX_AGE_SECS`)

Interface + in-memory impl:
```ts
// src/lib/identity_session.ts
import type { Address } from "viem";

export interface IdentitySession {
  did: string;        // did:t3n:...
  address: Address;   // verified wallet (FM3: bind session to the address it was minted for)
  verifiedAt: number; // epoch ms
  expiresAt: number;  // epoch ms
}

export interface IdentitySessionStore {
  set(agentId: string, s: IdentitySession): void;
  /** Live (non-expired) session for agentId, else null. Expired entries are evicted on read. */
  get(agentId: string, now?: number): IdentitySession | null;
  delete(agentId: string): void;
  clear(): void; // tests
}

export class MemoryIdentitySessionStore implements IdentitySessionStore {
  private readonly m = new Map<string, IdentitySession>();
  set(agentId: string, s: IdentitySession): void { this.m.set(agentId, s); }
  get(agentId: string, now: number = Date.now()): IdentitySession | null {
    const s = this.m.get(agentId);
    if (!s) return null;
    if (now >= s.expiresAt) { this.m.delete(agentId); return null; }
    return s;
  }
  delete(agentId: string): void { this.m.delete(agentId); }
  clear(): void { this.m.clear(); }
}

// Single-process default. Multi-replica needs a redis-backed impl (gated with that deploy, audit L2).
export const identitySessions: IdentitySessionStore = new MemoryIdentitySessionStore();

export const SESSION_TTL_MS = /* from ENV */ 0; // set in Task 1 wiring (see below)
```
Wiring TTL from ENV (replace the placeholder constant):
```ts
import { ENV } from "../config/env.js";
export const SESSION_TTL_MS = ENV.T3N_SESSION_TTL_SECS * 1000;
export const SESSION_FRESH_MAX_AGE_MS = ENV.T3N_SESSION_FRESH_MAX_AGE_SECS * 1000;
```

env.ts additions (schema + rawEnv):
```ts
// schema (near T3N_NODE_URL):
T3N_SESSION_TTL_SECS: z.number().int().min(30).max(86400).default(600),
T3N_SESSION_FRESH_MAX_AGE_SECS: z.number().int().min(10).max(3600).default(120),
// rawEnv:
T3N_SESSION_TTL_SECS: parseIntEnv(process.env.T3N_SESSION_TTL_SECS),
T3N_SESSION_FRESH_MAX_AGE_SECS: parseIntEnv(process.env.T3N_SESSION_FRESH_MAX_AGE_SECS),
```

- [ ] Step 1: failing tests — set/get roundtrip; expired entry returns null + evicts; fresh-age boundary; delete/clear.
- [ ] Step 2: run `pnpm test src/__tests__/identity_session.test.ts` → FAIL (module missing).
- [ ] Step 3: implement module + env wiring.
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `feat(t3adk): add shared TTL'd IdentitySessionStore (P0-b)`.

---

### Task 2 — Contract `identityPolicy` (v4)

**Files:**
- Modify: `contracts/AgentSkillRegistry.sol`
- Test: `test/AgentSkillRegistry.t.sol`

Contract changes:
1. `struct Skill` — append `uint8 identityPolicy;` after `minReputationToInvoke`.
2. Constants: `uint8 public constant IDENTITY_POLICY_NONE = 0; uint8 public constant IDENTITY_POLICY_T3N = 1; uint8 public constant IDENTITY_POLICY_T3N_FRESH = 2;` (documentation only; no on-chain enforcement).
3. `registerSkill(... , uint256 minReputationToInvoke, uint8 identityPolicy)` — set field; emit unchanged `SkillRegistered`.
4. `function setIdentityPolicy(uint256 skillId, uint8 policy) external` — owner-only (mirror `setMinReputation`); `emit IdentityPolicySet(skillId, policy)`.
5. `event IdentityPolicySet(uint256 indexed skillId, uint8 policy);`

Test updates (CRITICAL — tuple grows 10→11): every `(, , , , , uint256 reputation, uint256 invocations, , , )` destructure of `reg.skills(...)` gains ONE trailing comma. Affected: `test_HappyPath…`, `test_SelfDeal_NoRepFarm`, `test_SelfDeal_NoDiscoveryRankPump`, `test_SetMinReputation_OwnerOnly`. Every `registerSkill(...)` call gains a trailing `, 0` (default NONE). Affected helpers: `_registerSkill`, `_registerSkillGated`, inline `reg.registerSkill` in self-deal tests + `ReentrantProvider.register` + `test_Constructor_ConfiguredWindowDrivesDisputeBoundary`.

New tests:
```solidity
function test_IdentityPolicy_DefaultsAndSet() public {
    uint256 skillId = _registerSkill(); // registers with policy 0
    (, , , , , , , , , , uint8 pol) = reg.skills(skillId);
    assertEq(pol, 0, "defaults to NONE");
    vm.prank(alpha);
    reg.setIdentityPolicy(skillId, 1);
    (, , , , , , , , , , uint8 pol2) = reg.skills(skillId);
    assertEq(pol2, 1, "owner set policy to T3N");
}
function test_SetIdentityPolicy_OwnerOnly() public {
    uint256 skillId = _registerSkill();
    vm.prank(beta);
    vm.expectRevert(bytes("not skill owner"));
    reg.setIdentityPolicy(skillId, 1);
}
function test_RegisterSkill_PersistsIdentityPolicy() public {
    vm.prank(alpha);
    uint256 skillId = reg.registerSkill("s","d","mcp://a", PRICE, 0, 2);
    (, , , , , , , , , , uint8 pol) = reg.skills(skillId);
    assertEq(pol, 2, "registered with FRESH policy");
}
```

- [ ] Step 1: write new tests + update existing tuples/calls.
- [ ] Step 2: `forge test` → FAIL (compile: signature/tuple mismatch then new asserts).
- [ ] Step 3: implement contract changes.
- [ ] Step 4: `forge build && forge test` → PASS.
- [ ] Step 5: commit `feat(contract): add identityPolicy to Skill (v4)`.

---

### Task 3 — Plumb `identityPolicy` through ABI + service + types

**Files:** `src/lib/abi.ts`, `src/lib/karma_service.ts`, `src/lib/types.ts`, `src/__tests__/karma_contract.test.ts` (drift guard auto-covers).

1. `abi.ts`: `skills` outputs += `{ name: "identityPolicy", type: "uint8" }`; `registerSkill` inputs += `{ name: "identityPolicy", type: "uint8" }`; add `setIdentityPolicy` fn + `IdentityPolicySet` event.
2. `karma_service.ts`: `OnchainSkill` += `identityPolicy: number;`; `readSkill` decode `identityPolicy: Number(t[10])`; `registerSkill` param += `identityPolicy: number` and pass to args; add `setIdentityPolicy(account, {skillId, policy})` method to interface + impl.
3. `types.ts`: `SkillDocument` += `identity_policy?: number;`.

- [ ] Step 1: run drift guard `pnpm test src/__tests__/karma_contract.test.ts` → FAIL (abi vs artifact mismatch) — requires Task 2 `forge build` done.
- [ ] Step 2: update abi.ts + service + types.
- [ ] Step 3: run drift guard + `pnpm typecheck` → PASS.
- [ ] Step 4: commit `feat: plumb identityPolicy through abi+service+types`.

---

### Task 4 — Enforce identity in `create_job` (INV-1, fixes L7 ordering, FM2 fail-closed)

**Files:** `src/plugins/karma.tool.ts` (create_job handler), `src/__tests__/karma_tools.test.ts`.

Enforcement logic, inserted in `create_job` **after** the existing-job idempotency short-circuit
(L7) and reusing the structured-rejection pattern. Reads `skill.identityPolicy` (now on the
`OnchainSkill` from `svc.readSkill`):
```ts
// after: const skill = await svc.readSkill(skillId); active check; BEFORE reputation gate.
// (existing-job idempotency short-circuit already returned above for retries — L7 safe.)
const policy = skill.identityPolicy ?? 0;
if (policy !== 0) {
  const session = identitySessions.get(a.agentId);           // null if absent OR expired (fail-closed)
  const addr = requester;                                     // resolved keystore address
  const bound = session != null && session.address.toLowerCase() === addr.toLowerCase(); // FM3
  if (!bound) {
    return reply(`[KARMA] create_job rejected: skill #${skillId} requires a verified Terminal3 identity (policy ${policy})`, {
      status: "rejected", reason: "identity_required", skillId, identityPolicy: policy,
    });
  }
  if (policy === 2) { // T3N_VERIFIED_FRESH
    const age = Date.now() - session!.verifiedAt;
    if (age > SESSION_FRESH_MAX_AGE_MS) {
      return reply(`[KARMA] create_job rejected: skill #${skillId} requires a FRESH identity (re-verify)`, {
        status: "rejected", reason: "identity_stale", skillId, identityPolicy: policy,
      });
    }
  }
  if (policy > 2) { // INV-3 fail-closed for unknown policy
    return reply(`[KARMA] create_job rejected: skill #${skillId} has an unknown identity policy ${policy}`, {
      status: "rejected", reason: "identity_policy_unknown", skillId, identityPolicy: policy,
    });
  }
}
```
Import: `import { identitySessions, SESSION_FRESH_MAX_AGE_MS } from "../lib/identity_session.js";`

Tests (against the fake KarmaService — extend it to return identityPolicy):
- policy 0 → unaffected (regression).
- policy 1, no session → rejected `identity_required`.
- policy 1, valid session bound to address → proceeds.
- policy 1, session address mismatch → rejected (FM3).
- policy 2, stale verifiedAt → rejected `identity_stale`.
- policy 3 → rejected `identity_policy_unknown` (INV-3).
- existing-job retry with expired session → still returns `exists` (L7 ordering preserved).

- [ ] Step 1: write failing tests. → FAIL.
- [ ] Step 2: implement enforcement block.
- [ ] Step 3: run `pnpm test src/__tests__/karma_tools.test.ts` → PASS.
- [ ] Step 4: commit `feat(karma): enforce identityPolicy in create_job (INV-1)`.

---

### Task 5 — Rewire `t3.tool.ts` to the shared store + deprecate `t3_create_verified_job` (D2)

**Files:** `src/plugins/t3.tool.ts`, `src/__tests__/t3_tool.test.ts`.

1. Replace module-level `verifiedDids` Map with `identitySessions`. `t3_verify_identity` writes:
   `identitySessions.set(agent_id, { did, address, verifiedAt: Date.now(), expiresAt: Date.now()+SESSION_TTL_MS })`.
2. `getVerifiedDid` reads `identitySessions.get(agentId)?.did ?? undefined`.
3. Other tools (`t3_get_usage`, etc.) read `identitySessions.get(agent_id)` instead of the Map.
4. `t3_create_verified_job` → thin deprecated delegator: its description gains a `[DEPRECATED — use create_job; identity is now enforced there]` prefix; the handler still works (calls the same gates) but the canonical path is `create_job`. `clearVerifiedDidsForTest` calls `identitySessions.clear()`.

- [ ] Step 1: update tests (session store instead of Map internals).
- [ ] Step 2: run `pnpm test src/__tests__/t3_tool.test.ts` → FAIL.
- [ ] Step 3: implement rewire + deprecation note.
- [ ] Step 4: run → PASS.
- [ ] Step 5: commit `refactor(t3adk): t3 tools use shared session store; deprecate t3_create_verified_job`.

---

### Task 6 — register_skill tool + indexer + payroll script

**Files:** `src/plugins/karma.tool.ts` (register_skill), `src/lib/skill_indexer_runtime.ts`
(`skillDocFromChain`), `src/plugins/karma.tool.ts` (discover_skills output), `src/scripts/register_payroll_skill.ts`.

1. `register_skill`: add optional `identityPolicy: z.number().int().min(0).max(255).default(0)`; pass to `svc.registerSkill`; include `identity_policy` in `indexUpsert`.
2. `skillDocFromChain`: add `identity_policy: Number(s.identityPolicy)`.
3. `discover_skills`: surface `identity_policy` in each hit (it rides on the SkillDocument already; confirm it is returned — if search strips it, add to STORE_FIELDS in bm25_index.ts).
4. `register_payroll_skill.ts`: pass `identityPolicy: 1` for `payroll_hr_transfer`.

- [ ] Step 1: failing tests (register_skill persists policy to index; discover surfaces it).
- [ ] Step 2: → FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: `pnpm test` (relevant suites) → PASS.
- [ ] Step 5: commit `feat: surface identityPolicy in register_skill + discovery + payroll script`.

---

### Task 7 — README trust-boundary correction (FM1 + Abductive-1)

**Files:** `README.md`.

Tighten the overclaim. The honest framing: identity is required **when transacting via KARMA**;
the on-chain reputation gate is contract-enforced, identity is server-enforced (chain cannot verify a
DID). Update the tagline + "Why KARMA" bullet to state this asymmetry. Note `identityPolicy` is on-chain
*policy* and enforcement is the KARMA-mediated path.

- [ ] Step 1: edit README tagline + dual-layer bullet.
- [ ] Step 2: commit `docs: correct identity trust-boundary claim (audit FM1)`.

---

## Verification (whole-plan)
- `pnpm typecheck` green.
- `pnpm test` green (≥ prior 457 passed + new tests).
- `forge build && forge test` green.
- Manual trace: a policy-1 skill rejects `create_job` without a session, accepts with one.

## Out of scope (gated)
- Live Pharos v4 redeploy + env/address cutover + v3 state migration.
- Redis-backed session parity (travels with multi-replica deploy).

---

## Task Risk Summary (task-risk-score)
<!-- task-risk-score: DO NOT DUPLICATE — update this section -->
<!-- last-run: 2026-06-23 | CONTEXT: BUSINESS_LOGIC -->

| Task | S×B/D | QBR | Risk | Boundary | Action |
|------|-------|-----|------|----------|--------|
| T1 IdentitySessionStore | 3×2/3 | 2 | LOW | SINGLE | monitor; fail-closed expiry is the safety property |
| T2 Contract identityPolicy | 3×3/3 | 3 | MEDIUM | SINGLE | additive-only; live redeploy GATED (prod-only risk deferred) |
| T3 ABI/service/types plumb | 3×2/3 | 2 | LOW | SINGLE | drift guard + typecheck cover |
| T4 create_job enforcement | 3×2/3 | 2 | LOW | SINGLE | **security-critical** — verify with end-to-end trace, not only unit |
| T5 t3 tool rewire + deprecate | 3×2/3 | 2 | LOW | SINGLE | session-write path must stay intact |
| T6 register/indexer/script | 2×2/3 | 1 | LOW | SINGLE | index drift can't weaken gate (create_job reads on-chain) |
| T7 README fix | — | — | SKIPPED | SINGLE | docs-only (no state/security/async signal) |

**Summary:**
- High-risk tasks: none (plan is single-concern per task; no decomposition needed).
- Cross-boundary tasks: none.
- Integration-test surface: T4 warrants an end-to-end trace (policy-1 skill rejects without session,
  accepts with one) beyond unit tests — the security-critical path. T2's only prod-only risk (deployed
  contract bug) is deferred with the gated redeploy.
