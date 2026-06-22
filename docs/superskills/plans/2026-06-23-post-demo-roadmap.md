# KARMA Post-Demo Roadmap — Plan-on-Paper (P0→P3)

> Status: DRAFT FOR REVIEW (no code yet). Lens: durable real-world value of a trust-native
> agent economy, **not** hackathon scoring. Author handoff: re-evaluate after owner sign-off
> on the Decision Points (§6) before any implementation.
> Date: 2026-06-23

---

## 1. Context & the reframe

The T3ADK integration shipped 2026-06-22 as a *demo-safe* slice. The demo-era ADR
([adrs/2026-06-22-t3adk-terminal3-identity-gate.md](../adrs/2026-06-22-t3adk-terminal3-identity-gate.md), §6)
rejected three things. Re-reading each through the post-demo lens:

| Rejected (demo-era) | Why rejected then | Verdict now |
|---|---|---|
| **Alt A** — extract raw private key for T3N signing | Violates `KeystoreManager` invariant (timeless) | **Stays rejected.** Not time-bound. |
| **Alt B** — TEE confidential exec (`executeBusinessContract`, WIT→WASM) | 1–2 days of pipeline work vs same-day deadline | **Reconsider → P2 strategic bet.** Time was the only blocker. |
| **Alt C** — bind the gate into `create_job` / contract | Risk of breaking a working demo under time pressure | **Reconsider → P0 keystone.** Time/stability was the only blocker. |

Two of three deferrals were deferred *purely for time*. With time no longer the constraint
they flip from "don't" to "the agenda".

Plus one gap the source blueprint never saw: **reputation has no downside** (P3).

---

## 2. P0 — Make the identity gate a real control (KEYSTONE)

### Problem (evidence)
The identity gate is currently **bypassable**. Two parallel job-creation paths exist:
- `t3_create_verified_job` checks DID then reputation
  ([t3.tool.ts:291-312](../../../src/plugins/t3.tool.ts#L291-L312)).
- `create_job` checks **reputation only**, never DID
  ([karma.tool.ts:362-378](../../../src/plugins/karma.tool.ts#L362-L378)).

The `Skill` struct carries no identity field
([AgentSkillRegistry.sol:11-22](../../../contracts/AgentSkillRegistry.sol#L11-L22)) — only
`minReputationToInvoke`. So any agent with rep ≥ threshold calls plain `create_job` and skips
`t3_verify_identity` entirely. **Identity is caller-opt-in, not skill-enforced → it is a demo
prop, not a control.**

### Architectural truth
Reputation is enforceable on-chain (rep lives on-chain). **Identity is NOT** — a `did:t3n` is
off-chain T3N state proven via SIWE/WASM. The chain cannot verify a DID. Therefore the only
honest enforcement point is the **trusted in-process KARMA server** (consistent with the
"plugin must be trusted built-in" invariant). The contract can *flag* the requirement; only the
server can *enforce* it.

### Proposed change
1. **On-chain flag** `requiresVerifiedIdentity` (bool) on `Skill`, set at `registerSkill` /
   adjustable like `setMinReputation`. Lives on-chain so it is discoverable + composable
   (the indexer mirrors chain state — `skillDocFromChain`
   [skill_indexer_runtime.ts:32-41](../../../src/lib/skill_indexer_runtime.ts#L32-L41) — so an
   off-chain-only flag would have no source to read).
2. **Unify the path**: fold the identity check into `create_job`. If the target skill has
   `requiresVerifiedIdentity` and the caller has no live verified DID → reject with a structured
   reason (same shape as the existing reputation rejection). Deprecate the separate
   `t3_create_verified_job` (or keep it as a thin alias that delegates to `create_job`).
3. **Persist DID sessions** (prerequisite, see P0-b).

### Key design decisions / open questions
- **Q-P0-1:** On-chain flag vs off-chain registry for the requirement? On-chain = discoverable +
  censorship-resistant + composable, but is a contract change (redeploy + migration). Off-chain
  registry = no contract change but invisible to other consumers and a new trusted source of
  truth. **Recommendation: on-chain bool** — cheap to add, and the whole point is that the
  requirement is a public, verifiable property of the skill.
- **Q-P0-2:** What counts as a "live" verified DID at `create_job` time? Re-verify every call
  (latency, but always fresh) vs trust a cached/persisted session with a TTL (fast, but a
  revoked/expired T3N identity could slip through the TTL window). **Recommendation: persisted
  session with a short TTL + re-verify on miss.**

### P0-b — Persist DID + credential sessions (prerequisite)
`verifiedDids` / `issuedCredentials` are process-scoped Maps
([t3.tool.ts:36-43](../../../src/plugins/t3.tool.ts#L36-L43)) — wiped on restart, broken under
multi-replica (PATTERN-DEBT-T3N-001). `IStateStore`
([storage/interface.ts](../../../src/storage/interface.ts)) is per-tenant `BaseState`, not a
generic KV — so either (a) model DID sessions as tenant state, or (b) add a small dedicated
`IdentitySessionStore` behind the storage factory (memory/redis/fs parity). **Recommendation:
(b)** — DID sessions are not tenant workflow state; a focused interface keeps the volatility fix
clean and testable.

### Scoring
| Field | Value |
|---|---|
| Real value | **Very high** — converts the entire T3 layer from optional demo tool into an unbypassable control |
| Effort | **M** (contract bool + redeploy; unify create_job; new session store) |
| Risk | **Med** — touches the audited contract + the stable `create_job`; mitigated by full test suite (439 tests) + the contract's existing invariants |
| Blast radius | create_job path, registerSkill, indexer doc, t3 tools |
| Reversibility | Med (contract redeploy is the sticky part) |
| Depends on | P0-b (session persistence) must land first |

---

## 3. P1 — Verified identity as a discovery signal (CHEAP WIN)

### Problem
`discover_skills` ranks by text + reputation only
([karma.tool.ts:297-323](../../../src/plugins/karma.tool.ts#L297-L323)). The "DID = passport"
value is invisible to discovering agents.

### Proposed change
Surface `requiresVerifiedIdentity` (and, once P0 lands, whether the *owner* is DID-verified) as a
badge in `discover_skills` results; allow an optional filter/boost. Reads the same on-chain flag
P0 adds — no new source of truth.

### Scoring
| Field | Value |
|---|---|
| Real value | **High** (trust UX of the marketplace) |
| Effort | **S** |
| Risk | **Low** — read-only, no contract change beyond P0's flag |
| Depends on | P0 (the flag) — essentially free once P0 exists |

---

## 4. P2 — TEE confidential execution (STRATEGIC BET)

### Problem / opportunity
The genuine differentiation potential the blueprint correctly identified: private skill execution
+ hardware attestation. SDK surfaces exist (`executeAndDecode`, `tee:payroll`,
[t3.tool.ts:684-705](../../../src/plugins/t3.tool.ts#L684-L705)); the only blocker is the WIT→WASM
compilation pipeline that the ADR Retrospective flagged ("marketing undersells the prerequisite").

### Proposed change (scoped spike, NOT a big-bang)
1. Build the WIT→WASM pipeline for **exactly one** confidential skill (payroll), prove the
   `{{placeholder}}` PII pattern end-to-end against testnet.
2. Then concrete-change #3 of the blueprint: `complete_job` / settlement verifies a TEE
   attestation before releasing escrow — upgrading `resultHash` from *proof-of-submitted* to
   *proof-of-computed*.

### Key design decisions
- **Q-P2-1:** Attestation verification is again off-chain (server-side), same as identity — the
  contract can store an attestation hash but cannot verify Intel TDX. Decide where the trust
  anchor sits.
- **Q-P2-2:** Confidential skills need a transport distinct from plain MCP (`mcpEndpoint`). The
  blueprint's `t3n://` scheme is one option; decide the routing contract.

### Scoring
| Field | Value |
|---|---|
| Real value | **Very high** (unique, nothing else in the space combines this with the economy) |
| Effort | **XL** (compilation pipeline + new execution path + attestation verification) |
| Risk | **High** — new infra, off-chain trust anchor, depends on T3N TEE availability |
| Depends on | P0 (identity) should land first so confidential skills are gated coherently |
| Recommendation | Do as a time-boxed feasibility spike first; commit to full build only on a PASS |

---

## 5. P3 — Reputation has no downside (DEEPEST ECONOMIC GAP)

### Problem (evidence)
- Reputation is **monotonic-up** ([AgentSkillRegistry.sol:156-166](../../../contracts/AgentSkillRegistry.sol#L156-L166));
  a comment forbids adding decay without reworking the unset-sentinel logic.
- Dispute does **not** penalise the provider's reputation
  ([AgentSkillRegistry.sol:244](../../../contracts/AgentSkillRegistry.sol#L244) — "no agent-rep
  change on dispute").

A provider can build reputation, then deliver garbage repeatedly, losing only the individual
escrow (via dispute) and **zero reputation**. Long-term this makes reputation gameable — the core
trust signal of the whole economy.

### Why this is research, not a quick win
Dispute is currently a **unilateral** requester action. Wiring slashing/decay directly onto
dispute opens **requester griefing** (a malicious requester disputes good work to tank a
provider). Fixing this needs an economic design pass: e.g. dispute bonds, a challenge/response
window, an arbitration path, or staking that makes false disputes costly. The mechanism is the
hard part, not the code.

### Scoring
| Field | Value |
|---|---|
| Real value | **High** (integrity of the central trust signal) |
| Effort | **L–XL** (design-first, then contract change) |
| Risk | **High** — economic mechanism design; a naive version is worse than nothing |
| Depends on | A design phase (brainstorming/audit) BEFORE any contract change |
| Recommendation | Open a design RFC; do not code until the griefing vector is resolved on paper |

---

## 6. Sequencing & decision points

```
P0-b (persist DID sessions)
   └─> P0 (unify gate + on-chain flag)  ──> P1 (discovery signal)   [cheap follow-on]
                                         └─> P2 (TEE confidential exec)  [strategic bet, spike first]

P3 (reputation downside)  — independent track, design-RFC-gated, can run in parallel
```

**Recommended order:** P0-b → P0 → P1 (fast), then choose between P2 (technical differentiation)
and P3 (economic integrity) as the next major investment. P1 rides free on P0.

### Decision points needing owner sign-off before coding
- **D-1:** On-chain `requiresVerifiedIdentity` flag (contract change + redeploy) — yes/no? (Q-P0-1)
- **D-2:** Deprecate `t3_create_verified_job` vs keep as alias after unifying into `create_job`?
- **D-3:** DID-session freshness model: persisted+TTL vs re-verify-every-call (Q-P0-2)?
- **D-4:** Is P2 (TEE) or P3 (reputation economics) the priority strategic investment?
- **D-5:** P3 cannot start coding until the dispute-griefing mechanism is designed — agree to a
  design RFC gate?

---

## 7. Explicitly out of scope / kept-rejected
- **Raw private key extraction for T3N** (ADR Alt A) — permanent security invariant, never revisit.
- **Replacing PHRS escrow with T3N tokens** (blueprint Option B) — fights both systems' design;
  stays rejected.
- **`ownerDid` baked into the `Skill` struct as the blueprint drew it** — superseded; identity is
  enforced server-side (see P0 architectural truth), the on-chain artifact is the *requirement
  flag*, not the DID itself.
