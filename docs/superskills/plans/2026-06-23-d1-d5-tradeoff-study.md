# D1–D5 Tradeoff Study — Optimal & Sustainable Trust Architecture

> Companion to [2026-06-23-post-demo-roadmap.md](./2026-06-23-post-demo-roadmap.md).
> Lenses applied: market design / economics, game theory, living-systems (antifragility,
> homeostasis, Ostrom's commons principles), and case studies. Status: ANALYSIS FOR REVIEW.
> Date: 2026-06-23

---

## 0. The unifying frame: KARMA is building an immune system, not 5 isolated knobs

The vision (README + SKILL.md): *"economic substrate for Pharos agent networks… all on-chain,
all composable, all trustless"*, where *"agents cannot act anonymously"* and *"trust is dual-layer,
not optional."* That is a **trust kernel** for a market. D1–D5 are not independent — they are the
organs of one system:

| Organ | Question | Primitive | Status |
|---|---|---|---|
| **Self/non-self recognition** | *who* is acting? | identity (`did:t3n`) | D1, D2, D3 |
| **Immune memory** | what's their track record (+ and −)? | reputation (flow / EigenTrust-lite) | D4-P3 |
| **Cost of entry** | skin in the game? | bond + dispute stake | Tier-2 live; P3 |
| **Authority limits** | *what* may they do? | bounded delegation credential | live |
| **Confidential compartment** | private execution? | TEE attestation | D4-P2 |

Two organs are currently weak: **identity is bypassable** (P0) and **reputation has no negative
feedback** (P3). An immune system that can't recognize non-self and has no memory of past harm is
not robust. Fixing those two is more foundational than adding the TEE compartment (P2).

**Sharpest finding:** the README already asserts identity is *"required… not optional."* The code
makes it optional (bypassable via plain `create_job`). D1+D2 are therefore not feature work — they
are **making the stated promise true.** A trust protocol whose headline claim is false on inspection
has negative antifragility: the first adversary who notices destroys the trust narrative.

---

## D1 — Where does the identity *requirement* live: on-chain flag vs off-chain registry?

### The asymmetry that frames everything
Enforcement is **necessarily off-chain**: the chain cannot verify a `did:t3n` (it is T3N state
proven via SIWE/WASM). So the only question is where the **policy** (the requirement that a skill
needs identity) lives, given the **enforcer** is the trusted in-process server regardless.

### Lens: game theory — rules of a trust game must be credibly committed
If the policy lives in server config (off-chain), the operator can silently change the rules of the
game (rug the requirement), and participants cannot verify the rules they're playing under. In a
*trust* protocol this is self-contradicting. An on-chain flag is a **credible commitment**: the
rule is public, immutable-by-default, and auditable. This is the same reason PoS slashing conditions
are in consensus code, not an operator's `.env`.

### Lens: economics — composability is a positive externality; gas is noise
SSTORE for one `uint8` is negligible. The value is that *any* indexer, client, or competing
front-end can read "this skill requires identity" and compose on it — exactly the SKILL.md promise
("all composable"). An off-chain registry makes the KARMA server the **sole oracle** of policy →
centralization + single point of failure, the opposite of the trustless claim.

### Lens: living systems — legibility enables adaptation
Rules hidden in server config drift, suffer bus-factor, and are illegible to stakeholders. On-chain
policy is visible "DNA": versioned, inspectable, survivable across operators.

### Case studies
- **ERC-8004** (agent identity/reputation registry) puts identity pointers on-chain *precisely* for
  cross-system composability — the direction the whole agent-identity space is moving.
- **Gitcoin Passport** began with off-chain/centralized scoring (criticized as opaque) and migrated
  toward on-chain EAS attestations for transparency.
- **Anti-pattern:** centralized off-chain allowlists — opaque, ruggable, non-composable.

### Refinement — don't add a naked bool; add a typed, extensible enum
A `bool requiresVerifiedIdentity` solves today (one identity provider: T3N) but forces a contract
redeploy the day a second issuer/credential-type appears. Avoid both under-design (bool) and
over-design (a `bytes32` policy-pointer + off-chain descriptor registry — YAGNI now). **Goldilocks:**

```solidity
uint8 identityPolicy;   // 0 = none (open), 1 = T3N-verified, 2..255 reserved (future issuers/tiers)
```

Cheap, future-proof, expressive enough to also encode a freshness tier (see D3) without a v4.

### Recommendation D1
**On-chain `uint8 identityPolicy` enum; enforcement stays server-side.** Makes the README's "not
optional" true, keeps it composable and credibly committed, and future-proofs against multi-issuer
identity without a redeploy.

---

## D2 — Deprecate `t3_create_verified_job` or keep it as an alias?

### Lens: game theory — two doors with different locks ⇒ everyone uses the weaker lock
The current bug *is* the dual path: an enforcing `t3_create_verified_job` next to a lax `create_job`.
A rational actor targeting a gated skill routes through the lax door. The only coherent invariant is
**exactly one job-creation enforcement path.** Fold the identity check into `create_job`; the
separate tool becomes pure redundancy.

### Lens: cognitive ergonomics of an LLM tool surface
KARMA's tools are selected by an LLM. Two tools that create jobs (one "verified", one not) degrade
tool-selection: the model must disambiguate, and ambiguity = wrong calls + the bypass. Fewer
orthogonal tools = better affordance. The "which skills need identity" signal belongs in **data**
(discover_skills surfaces `identityPolicy`; create_job returns a structured "verify first" rejection),
not in a tool *name*.

### Recommendation D2
**Unify enforcement into `create_job`; remove `t3_create_verified_job` as a distinct path.** If any
external client already binds to it, keep a one-release thin alias that delegates to `create_job`
(zero enforcement difference), then delete. **Enshrine as a standing invariant:** "there is exactly
one job-creation enforcement path; no future tool may create jobs on a separate path." This prevents
the bypass from being reintroduced.

---

## D3 — DID-session freshness: persist + TTL vs re-verify every call?

### Lens: living systems — avoid tight coupling to an external organ's heartbeat
Re-verify-every-call couples KARMA's *liveness* to T3N's *liveness per job*: if T3N is unreachable,
the gated market freezes. (The README already documents T3N testnet returning `OrganisationNotFound`
/ 404 for some surfaces — external availability is *not* guaranteed.) Persist+TTL is loose coupling
with graceful degradation: a cached session keeps the market moving across brief T3N outages.

### Lens: security / game theory — the staleness window
Persist+TTL's only risk: a *revoked/expired* identity honored within the TTL. Bounded by TTL length.
This is exactly the OAuth access-token-TTL vs token-introspection-per-request tradeoff; the industry
converged on **short-lived tokens + TTL**, not introspect-every-request, because the availability and
cost (T3N has metered/paid ops — `t3_get_usage` exists) costs of per-call verification outweigh a
short staleness window.

### Refinement — tiered freshness, keyed to D1's policy enum
Let `identityPolicy` also carry an assurance tier: default skills → TTL-cached session (~10 min);
high-assurance values (e.g. payroll, large escrow) → force fresh re-verification (or an explicit
revocation check) at job creation. Robust default, strict where the stakes justify the coupling.

### Recommendation D3
**Persist + TTL (~10 min) as default; high-assurance tier (encoded in `identityPolicy`) forces fresh
re-verification.** Loose coupling by default, strict where it matters. (Persistence also closes
PATTERN-DEBT-T3N-001 — the volatile process-scoped cache.)

---

## D4 — Strategic fork: P2 (TEE confidential execution) vs P3 (reputation integrity)?

### Restating honestly: different layers of the vision, not a clean either/or
- **P3** protects the *survival* of the market (trust-signal integrity).
- **P2** builds the *moat* (a capability nobody else has).

### Lens: market design — the market-for-lemons (Akerlof)
A marketplace dies when quality is unobservable and the trust signal is gameable: good providers get
out-competed by high-rep defectors, requesters lose trust, the market unravels. P3 addresses this.
**But** KARMA is *not* starting from zero on reputation — Tier-0 self-deal guard, Tier-1 EigenTrust-
lite *flow* reputation, and Tier-2 bond are already live. The specific hole is narrow: **negative
signals (dispute, non-delivery) don't feed back** — rep is monotonic-up, dispute is rep-neutral. At
the current nascent scale this is a *slow-burn*, not an acute failure.

### Lens: risk asymmetry + external-dependency gating
- **P2 is XL effort + High risk, and its full payoff is gated by infrastructure KARMA does not
  control.** The README states org-grant provisioning and `tee:payroll` invocation already return
  `OrganisationNotFound`/404 on the public testnet. Committing XL effort to P2 now is betting the
  farm on *someone else's* unfinished roadmap. The correct response to an external-gated bet is a
  **spike to validate the dependency**, not a full build.
- **P3-lite is L effort + Lower risk, fully within KARMA's control** — feed dispute/failure signals
  into the *existing* `flow_reputation` machinery + add decay. No external dependency, leverages
  shipped Tier-1 infra.

### Lens: living systems — robustness precedes specialization
An organism must self-regulate against parasites (homeostasis) before it specializes into a niche
(the confidential compartment). Evolutionarily and operationally, harden the core trust signal first;
take the moat bet once it's de-risked. Antifragility argues against an XL bet whose payoff depends on
an external party currently returning 404.

### The counter-argument (acknowledged)
A differentiator attracts the first serious users, and a nascent market has no acute lemons problem
yet — so "build the moat to get adoption" is legitimate. The reason it still loses: P2's moat is
*currently un-buildable end-to-end* (external 404), whereas P3-lite is cheap, in-control, and
compounds the already-strong reputation system. Do the cheap in-control thing first; spike the
expensive external-gated thing before committing.

### Recommendation D4
**Order: P0 → P1 → P3-lite → P2-spike → (P2-full only on spike PASS).**
If forced to name one priority between the two: **P3-lite first** (protect the core, low risk, no
external dependency, leverages existing flow reputation); **P2 as a de-risked bet** behind a
feasibility spike that confirms T3N TEE/org provisioning is actually reachable. This is the
antifragile ordering.

---

## D5 — RFC gate for P3: yes, but bifurcate soft vs hard

### The crux: dispute is *unilateral*, so naive slashing = a griefing weapon
If a requester can unilaterally dispute *and* that slashes the provider's escrow/bond/reputation, a
malicious requester griefs good providers. A bad slashing mechanism is **worse than none** — it adds
an attack the current design doesn't have.

### Bifurcation
- **P3-lite (SOFT) — proceed with light design, no heavy RFC.** Feed a *dispute-rate* signal
  (disputed ÷ completed, naturally bounded) and time-decay into the existing flow reputation. This
  adjusts a *ranking signal*, not funds. Downside is bounded and reversible; a frivolous dispute
  already only refunds the requester's *own* escrow, and normalizing by rate (not absolute count)
  blunts griefing. This is Ostrom's **graduated sanctions** applied softly.
- **P3-hard (SLASHING of escrow/bond) — RFC-GATED.** Must neutralize griefing before any code.

### What the RFC must evaluate (case studies)
- **UMA optimistic oracle** — symmetric proposer/disputer **bonds**; the party an arbiter rules
  against forfeits its bond. Makes frivolous disputes *costly*. Lightest viable fix.
- **Kleros** — staked jurors, Schelling-point voting, appeal escalation. Heavier; full decentralized
  arbitration.
- **Augur** — escalation/forking for extreme disputes. Reference for last-resort design.
- **EigenLayer** — operator-set slashing design; reference for bond-slashing safety rails.

**Likely RFC outcome:** symmetric **dispute bonds** (both sides stake; loser-pays) layered on the
existing optimistic review window — the minimal mechanism that makes the dispute path griefing-
resistant, reusing the already-audited pull-payment ledger and `REVIEW_WINDOW`.

### Recommendation D5
**Yes — bifurcated.** Soft reputation feedback (P3-lite) proceeds now with light design; hard
slashing is RFC-gated, and the RFC's explicit job is to neutralize griefing via symmetric dispute
bonds + a Schelling/arbitration escalation (evaluate UMA first, Kleros if decentralized arbitration
is desired).

---

## Synthesis — the recommended coherent path

1. **P0 + P1** — on-chain `identityPolicy` enum (D1), single enforcement path in `create_job` (D2),
   persisted DID sessions + TTL/high-assurance tier (D3), `identityPolicy` surfaced in discovery.
   *Effect: the README's core promise becomes true; the immune system can recognize non-self.*
2. **P3-lite** — dispute-rate + decay into existing flow reputation. *Effect: immune memory of harm,
   low risk, in-control, compounds Tier-1.*
3. **P2-spike** — validate T3N TEE/org provisioning is reachable (kill the 404 unknown) before any
   XL commitment.
4. **P2-full** *(on spike PASS)* + **P3-hard** *(on RFC PASS)* — the moat and the hard-sanction
   layer, both gated on de-risking.

Each step makes the next safe; nothing bets the farm on an unvalidated external dependency. This is
the optimal, comprehensive, sustainable ordering for the stated vision.
