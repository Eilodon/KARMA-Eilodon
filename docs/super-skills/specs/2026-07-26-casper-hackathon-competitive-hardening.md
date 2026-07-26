---
title: Casper Buildathon competitive-hardening candidates (P0-P3)
stakeholder: Eilodon (KARMA maintainer)
SPEC_APPROVED: true
---

# Casper Hackathon Competitive Hardening — P0-P3

## Context

KARMA is competing in the Casper Agentic Buildathon 2026 Final Round against ~83
submissions, judged on 8 criteria (Technical Execution, Innovation, Use of Agentic
AI, Real-World Applicability, UX & Design, Working Smart Contracts, Long-Term Launch
Plans, Ecosystem Impact). A prior competitive gap analysis (this conversation)
identified 6 candidate improvements. Two (P4: README quality scorecard table, P5:
external demo script) are simple doc/script edits with no architectural or security
surface and were executed directly, no audit needed — both shipped, live-verified.
The four below are non-trivial (security, funds, or architecture) and were audited
here before any implementation.

**Note on file location:** this spec was originally (and incorrectly) written to
`docs/superskills/specs/` (no hyphen) — a gitignored, stale local directory left
over from an earlier session, distinct from this project's real, git-tracked KB at
`docs/super-skills/` (hyphenated; see `docs/super-skills/adrs/2026-07-25-casper-
custody-hardening-and-panel-activation.md` for the canonical recent example).
Relocated here on the second pass below; the original commit attempt correctly
failed against `.gitignore:31`.

## Candidate P0: Live interactive demo relayer

**Goal:** let a judge click a button on a hosted page to trigger a real Casper
testnet flow (open dispute → LLM arbiter reasons → verdict posts on-chain) with no
local clone/setup, closing the UX gap vs Conclave's "What-If Console".

**Design:** a hosted static page + a serverless function ("relayer") holding a
Casper testnet private key, rate-limited, that receives a judge-triggered HTTP
request and submits a small number of pre-scoped on-chain calls against the
already-deployed `AgentSkillRegistry` (e.g. `create_job` /
`dispute_result_via_panel` / `cast_panel_vote`). The front-end streams LLM arbiter
reasoning (SSE/polling) plus the resulting tx hash.

## Candidate P1: x402 official facilitator interop

**Goal:** prove KARMA's x402 Casper rail interoperates with the official
`make-software/casper-x402` reference, not only KARMA's own self-settlement path.

**Design (revised on second pass — see addendum):** self-host the official,
unmodified, open-source Go facilitator binary, pointed at KARMA's own already-live,
already wire-compatible `X402SettlementToken`.

## Candidate P2: One real Casper mainnet transaction

**Goal:** produce at least one small, real, verifiable Casper MAINNET transaction to
counter "testnet-only" as a scored weakness vs a rival with real mainnet activity —
while preserving KARMA's stated position of no mainnet product launch yet.

**Design:** use an existing keystore-derived signer to submit a minimal,
non-custodial mainnet action (e.g. a tiny x402 self-settlement payment), from a
codebase that today has explicit guards rejecting mainnet in several places
(`run_autonomous_loop.ts`, `run_autonomous_loop_casper.ts`, and a test literally
titled "rejects mainnet — the autonomous loop is testnet-only").

## Candidate P3: Toolkit-alignment wrappers (CSPR.cloud / CSPR.click)

**Goal:** flip 2 of the 3 "Not used" rows in the README's Casper-AI-Toolkit-
alignment table to "Used" by adding a thin CSPR.cloud read wrapper and/or a minimal
CSPR.click adapter, without breaking the existing agent-key (not human-wallet)
architecture.

**Design (revised on second pass — see addendum):** CSPR.click adapter scoped to a
new, optional **human-as-x402-payer** flow (a judge/end-user paying for a skill
invocation via browser wallet) — not governance signing, not agent-to-agent
payment. CSPR.cloud wrapper unchanged from first pass: a secondary, clearly-labeled
read path, never the status badge's source of truth.

## Risk Assessment (audit-design)
<!-- audit-design: DO NOT DUPLICATE — update this section, do not append a second one -->
<!-- last-run: 2026-07-26 | trigger: NORMAL -->

**Tier:** 3 (P0, P2 touch a live signing key / real funds and a public-facing
judge-triggered surface) | **Date:** 2026-07-26

### P0 — Live interactive demo relayer

**Failure Modes**
1. Public-facing endpoint holding a live signing key is an open invocation
   surface — without strict scoping to a fixed, parameterless trigger, it can be
   hammered to drain the relayer's CSPR gas balance or flood the registry with
   spam jobs/disputes, exactly during the highest-traffic period (the judging
   window). — **HIGH** — mitigation in plan: NO
2. The demo would mutate the *same* "Locked" registry whose state feeds the
   auto-refreshed public status badge/dashboard (`casper_status.json`, refreshed
   every 30 min, quoted live in the README). A judge-triggered demo dispute could
   show up as "current state" to the next judge loading the badge, undermining the
   "always reflects real state" trust mechanism that's central to the submission.
   — **MED-HIGH** — mitigation in plan: NO
3. Piping live LLM output to an unauthenticated public endpoint has no
   cost/quota control (LLM API spend can spike from repeated triggers) and, if any
   judge/attacker-supplied text reaches the arbiter prompt, a prompt-injection
   surface — a broken or gameable live-AI demo during judging scores worse on
   "Use of Agentic AI" than no live demo at all. — **MED** — mitigation in plan: NO

**Layer Signals**
- L1 Logic: concurrent-trigger race on sequential `job_id`/`dispute_id`
  allocation untested — two simultaneous judges could see tx-success but
  mismatched displayed state.
- L2 Concurrency: single relayer key/nonce shared across N simultaneous browser
  sessions — Casper deploy/nonce sequencing under concurrent submits from one
  signer is unverified against this design.
- L4 Integration: LLM API timeout/rate-limit/5xx mid-demo, in front of a judge,
  with no stated fallback.
- L5 Security: this is the first time a *funded, publicly-reachable* signing key
  would exist in the project — every existing script requires local keystore +
  explicit `--live` flag + env guard; no equivalent "public-untrusted-trigger"
  discipline exists yet.
- L6 Observability: no existing alerting path from a public relayer back to the
  builder during the short, high-stakes judging window.
- L7 Cross-cutting: "rate-limited" mechanism is unspecified (per-IP? per-session?
  global cap?); double-click/retry idempotency on job/dispute creation unspecified.

**Assumptions to Verify (ASSUMED)**
- Rate-limiting mechanism — ASSUMED, unspecified.
- Judge-supplied text does not reach the LLM prompt verbatim — ASSUMED, unspecified.
- Demo writes to an isolated contract/job-id namespace, not the same state the
  status badge depends on — ASSUMED, currently defaults to shared state.
- Relayer key is funded with a small, capped, single-purpose balance — ASSUMED,
  unspecified.

### P1 — x402 official facilitator interop (first-pass assessment — see addendum below, materially revised)

**Failure Modes**
1. The RFC (`docs/rfc/2026-07-21-x402-casper-eip712-interop.md` §7-9) already
   scoped this as an open, non-blocking item — attempting it without first
   re-reading *why* it was deferred risks discovering a hard external blocker
   (allowlisted API key, unsupported network/chain-id, incompatible
   fee/gas-sponsorship model) only after time is spent. — **HIGH** —
   mitigation in plan: NO
2. Interop proof quality depends on a third party's uptime/behavior during the
   judging window, which KARMA doesn't control — trading a fully controllable
   self-settlement proof for a non-reproducible one if the hosted facilitator is
   flaky exactly when a judge tries to verify it live. — **MED-HIGH** —
   mitigation in plan: NO
3. "Wire-compatible" is currently a claim, not a proven fact — a subtle EIP-712
   domain-separator/nonce/signature-recovery mismatch discovered against an
   opaque hosted service (no local repro) could burn disproportionate time for a
   single line-item gap vs one rival. — **MED** — mitigation in plan: NO

**Layer Signals**
- L4 Integration: external API error/timeout behavior is the crux of this item.
- L5 Security: routing settlement through a third-party facilitator introduces a
  new trust dependency — verify whether KARMA's non-custodial claim still holds.

**Assumptions to Verify (ASSUMED)**
- RFC §7-9 doesn't already document a hard blocker — MUST re-read before
  committing further effort. **RESOLVED in addendum: no hard blocker; §5.0-5.5
  (the hard part) already done and live.**
- The external facilitator has a public/free testnet mode reachable without a
  bespoke partnership agreement — ASSUMED. **RESOLVED in addendum: FALSE
  premise — it's not a hosted SaaS at all, it's a self-hostable open-source
  server; no partnership needed.**

### P2 — One real mainnet transaction

**Failure Modes**
1. Direct contradiction of KARMA's own documented security posture: README states
   "no mainnet date, on purpose" and "the keystore is testnet-only"; multiple
   scripts have explicit mainnet-rejection guards, including a test literally
   titled "rejects mainnet — the autonomous loop is testnet-only". Doing a mainnet
   tx now means bypassing/weakening a deliberate safety invariant with its own
   test coverage, or acting fully outside tooling that test suite covers. This
   undermines the exact security-discipline narrative ("Locked and
   governance-hardened, three real gaps found and fixed") that is currently one of
   KARMA's strongest differentiators. — **HIGH** — mitigation in plan: NO
2. Real capital/gas custody risk — a mainnet key, even minimally funded, is a real
   bearer secret; introducing it under time pressure (new keystore, new funding
   step) for a one-off symbolic tx raises the exact operational-security bar the
   project has deliberately avoided so far, for an asymmetric payoff (trivial
   amount → easily dismissed by judges; meaningful amount → real custody risk).
   — **MED-HIGH** — mitigation in plan: NO
3. Scope creep / narrative risk — a single mainnet self-settlement tx proves only
   that KARMA's code *can* sign a mainnet deploy; it doesn't extend to governance,
   dispute, or panel arbitration (which would remain testnet-only), inviting "why
   is only ONE thing on mainnet" scrutiny rather than deflecting it. — **MED** —
   mitigation in plan: NO

**Layer Signals**
- L5 Security: dominant signal for this item — see Failure Modes 1-2.
- L7 Cross-cutting: the existing mainnet-rejection guard is a documented safety
  invariant with its own regression test — treat it as a decision to explicitly
  revisit in writing, not an obstacle to route around.

**Assumptions to Verify (ASSUMED)**
- That a single mainnet tx meaningfully moves a judge's score, vs. reading as an
  inconsistent afterthought next to an otherwise-consistent "testnet, on purpose"
  position — this is a judgment call, not a technical fact, and is UNVERIFIED.
- That mainnet key funding/custody can be done safely in the remaining time
  without becoming its own incident — UNVERIFIED.

### P3 — Toolkit-alignment wrappers (first-pass assessment — see addendum below, scoping refined)

**Failure Modes**
1. CSPR.click is designed for human-wallet-connect UX; KARMA's signers are
   unattended agent/governance keys by design. If a CSPR.click adapter touches the
   governance multisig signer path at all, it's exactly the kind of change that
   caused the already-documented "governance inconsistency" bug found during the
   last hardening pass — re-touching governance-adjacent signing under time
   pressure risks reintroducing a bug class KARMA just spent effort fixing.
   — **HIGH if it touches governance signing, LOW if scoped to a genuinely
   separate non-governance flow** — mitigation in plan: NO. **Addendum: confirmed
   scoping exists that never touches governance signing at all — see below.**
2. KARMA's "talks to a public RPC node directly" is a stated architectural choice
   (fewer dependencies, no vendor lock). Adding CSPR.cloud as a second parallel
   read path risks the two paths silently disagreeing (indexer lag vs direct RPC
   finality) on the same live-status dashboard central to the trust story — a
   self-inflicted credibility gap that doesn't exist today. — **MED** —
   mitigation in plan: NO
3. This is fundamentally an optics/scoring-table change, not a capability gap —
   a wrapper added specifically to flip a README cell rather than because the
   product needs it reads as decorative to a careful reviewer, which can score
   worse than the current honestly-argued "Not used — different problem, by
   design" framing. — **LOW-MED** — mitigation in plan: NO. **Addendum: the
   CSPR.click flow found below is a genuine new capability (human-as-payer), not
   a decorative wrapper — this specific concern no longer applies to it.**

**Layer Signals**
- L5 Security: only relevant if CSPR.click touches the governance-signer/
  multisig path — must be explicitly scoped to avoid that.
- L4 Integration: CSPR.cloud API failure mode is stale/wrong *display* data
  (read-only), lower severity than P1's payment-path integration risk.

**Assumptions to Verify (ASSUMED)**
- Whether a CSPR.click adapter would touch the governance multisig signers
  (highest-risk) or a genuinely separate judge-only flow — the recommendation
  states a goal ("without breaking the agent-key architecture") but doesn't yet
  specify which. **RESOLVED in addendum.**

### Abductive Hypotheses

1. **P0 × P2 compounding:** if the same time-pressured push both stands up a
   public-facing signing relayer (P0) and introduces a mainnet-funded key (P2),
   the operational-discipline gap in P0 (new, rushed, public-facing key-handling
   code) becomes the delivery vehicle for P2's risk (a real-value key). These must
   stay fully separate in time and code path — a public relayer must never be able
   to reach a mainnet-funded key, even via shared config/env-var naming.
2. **P0 × existing status-badge mechanism at scale:** the auto-refreshed public
   dashboard/badge was built and tested against KARMA's own controlled,
   sequential, low-frequency demo runs. A public button reachable by anyone turns
   that mechanism into a shared, contended resource for the first time — bursty
   concurrent access from multiple judges/reviewers during the 1-2 day judging
   window is a load pattern nothing in the current 155/899-test suite (all
   presumably sequential/controlled) has exercised.

### Gate Result (first pass)
<!-- PASS | PASS WITH FLAGS | HOLD -->

- **P0 — HOLD.** Requires explicit design revision before implementation.
- **P1 — PASS WITH FLAGS.** (superseded — see addendum, now closer to clean PASS)
- **P2 — HOLD.** Recommend *against* doing it as scoped.
- **P3 — PASS WITH FLAGS.** (superseded — see addendum, scoping now concrete)

---

## Deep-Research Addendum (2026-07-26, second pass — P1 & P3 only)

Requested explicitly: re-research P1 and P3 in depth using CALM (codebase) +
the super-skills KB, before deciding whether to implement. P0 and P2 are
unchanged from the first pass (still HOLD).

### P1 — new evidence

**1. Full RFC re-read (`docs/rfc/2026-07-21-x402-casper-eip712-interop.md`), all
9 sections, not just §7-9 as the first pass planned.** Status header: "§5.0-§5.5
all done and proven for real, end-to-end." `X402SettlementToken` is live on Casper
Testnet (`hash-b3387d595fa53045f42b350907a68f3a0b95cc983c056fd9d71d26f776c1d310`),
composed from the *same* upstream Odra modules (`odra-modules`' `CEP3009`,
following `odradev/wcspr`'s pattern) the official reference itself is built from —
not a hand-rolled approximation. The EIP-712 typehash was cross-checked byte-for-
byte against the real `casper-eip-712` reference in `x402_casper.test.ts`, and the
full sign→settle path was proven against the live deployed contract
(`demo_casper_x402_settlement_live.ts`, `errorMessage: null`, `Transfer` event).
**The only remaining open item, per the RFC's own §9, is §7's last row: proof
against the facilitator's own *hosted* instance — explicitly called "not blocking"
by the RFC's own author.**

**2. KB cross-reference (`docs/super-skills/adrs/2026-07-25-casper-custody-
hardening-and-panel-activation.md`) surfaced a new constraint the RFC (dated
2026-07-21) couldn't have known about:** `X402SettlementToken` was **Locked
(non-upgradable)** on 2026-07-25, with an explicit open PATTERN-DEBT
(`PATTERN-DEBT-x402-settlement-token-roadmap-conflict`) flagging that any future
need to upgrade this specific contract in place is now blocked — a fresh deploy
would be required instead. Assessed risk to P1: **LOW**, not the item's dominant
risk — the RFC's own field-by-field divergence table (§3) and the byte-for-byte
typehash cross-check make it unlikely the *contract* needs any change for
external-facilitator interop (it already speaks the exact `CEP3009`/ERC-3009-
equivalent wire format the reference facilitator expects); the residual risk is
a smaller "the external facilitator's specific calling convention has some
undocumented extra assumption" tail case, not the primary blocker.

**3. External research (`gh api repos/make-software/casper-x402`, read directly,
not assumed) overturns the first pass's central ASSUMED premise.** The
"facilitator" is **not a centrally-hosted SaaS requiring a partnership/API key** —
it is a self-hostable, open-source (Apache 2.0), Go reference server
(`go/examples/facilitator`), configured via plain env vars including
`ASSET_PACKAGE` (an arbitrary 64-hex CEP-18 package hash — genuinely generic, no
token allowlist). The repo even ships `.env.testnet` specifically for "testnet
... with WCSPR contract" and an `infra/local/deployer` providing `Cep18X402.wasm`
for local/testnet use — the exact shape of asset KARMA already has. Running this
*unmodified, official* binary yourself, pointed at KARMA's own already-live
`X402SettlementToken`, is a legitimate, judge-verifiable "interop with the
official reference" claim — the RFC's framing of this as depending on an
external party's uptime was based on an incorrect assumption about how the
facilitator is deployed.

**4. Same research surfaced a public, no-API-key RPC node the facilitator's own
default config uses:** `https://node.testnet.casper.network/rpc` — corroborated
independently by `docs/super-skills/adrs/2026-07-25-...md:61-62,194-195` (used for
the real custody-hardening redeploy specifically *because* `cspr.cloud` 401'd
without a key). **Side finding, not P1/P3 but worth acting on separately:**
`DEMO_CASPER.md`, `.env.example`, and `run_autonomous_loop_casper.ts`'s examples
all point at `cspr.cloud` (now key-gated) as the primary example; this
no-key alternative is not mentioned anywhere as a fallback. Low-effort doc fix,
not evaluated further here (out of P1/P3 scope).

**Revised Gate Result — P1: PASS.** No design-level blocker remains. Recommended
scope for implementation, if pursued: run the official Go facilitator locally/
self-hosted, `ASSET_PACKAGE` = KARMA's live `X402SettlementToken` package hash,
prove one real settlement through it end-to-end (client → facilitator → on-chain
`transfer_with_authorization`), and update the RFC's status header + README/
DEMO_CASPER.md's x402 section accordingly. Effort: small-medium (mostly Go
toolchain setup + env wiring, zero new Rust/TS code required). One framing risk
to carry into the plan, not a technical one: a skeptical judge could ask whether
"self-hosting their reference binary" counts as "interop" vs. them running it —
mitigate by being explicit in the writeup that the binary and its settlement logic
are unmodified upstream code, only the deployment location differs.

### P3 — new evidence

**1. Governance-signer boundary is exhaustively enumerated, not estimated.**
Grepped `require_governance_signer()` call sites directly in
`contracts-odra/src/agent_skill_registry.rs`: exactly 7 methods gate on it —
`propose_set_dispute_bond_bps`, `propose_set_arbiter`, `propose_set_arbiter_panel`,
`propose_set_panel_arbiter_fee`, `propose_set_cross_chain_rep`, `approve_proposal`,
`cancel_proposal`. Nothing else in the contract touches it. This is a closed,
easily-avoidable set — a CSPR.click adapter simply needs to never call these 7
entry points to have zero governance-signing risk, mechanically verifiable (grep
the adapter's own call sites against this list before merge).

**2. The official `make-software/casper-x402` repo (same external research as
P1) ships a fourth component that answers P3's exact open question — what would a
non-decorative CSPR.click integration in KARMA actually *do*:**
`go/examples/csprclick-x402` — "a Vite + React demo for using CSPR.click to sign
an x402 payment authorization with EIP-712 typed data." It connects a browser
wallet, receives a `402`/`Payment-Required` challenge from a resource server,
signs the EIP-712 payment authorization via CSPR.click, and replays the request.
**This is a human acting as the x402 *payer*** — structurally unrelated to
governance signing or to KARMA's existing agent-keystore payer path. It directly
validates the scoping the first pass flagged as unresolved: CSPR.click's natural,
reference-precedented role in this exact ecosystem is "let a human pay for an
x402-gated call from a browser," not "sign governance proposals."

**3. Concrete, low-risk scope for KARMA specifically:** a new, additive,
optional flow — a human (e.g. a judge) connects a Casper wallet via CSPR.click and
pays for one `AgentSkillRegistry` skill invocation themselves (e.g. the
`rwa_price_oracle` or `casper_panel_dispute_demo` skill already registered),
producing an x402 payment authorization the existing `create_job`/x402 settlement
path already knows how to consume. This coexists with, does not replace, the
existing in-process `KeystoreManager` agent-key path — genuinely two payer
identities (agent, and now optionally human-via-browser), zero shared code with
`approve_proposal`/`propose_*`/governance. Failure Mode 1 (governance-adjacent
regression risk) and Failure Mode 3 (decorative wrapper) from the first pass both
no longer apply to this specific scope — it is real new capability, not a
README-table cosmetic change, and it structurally cannot regress governance
because it never calls into it.

**4. CSPR.cloud wrapper (the other half of P3) is unaffected by this new
evidence — first-pass conclusion stands:** keep it a secondary, explicitly-labeled
read path if built, never the source of truth for `casper_status.json`.

**Revised Gate Result — P3: PASS**, scoped specifically to a human-as-x402-payer
CSPR.click flow (not governance, not a generic "wallet connect" bolt-on) — the
scope ambiguity the first pass flagged as the item's central risk is now closed
by evidence, not by assumption. The CSPR.cloud half remains PASS WITH FLAGS
(unchanged) if pursued at all — it was always the lower-value, lower-risk half of
P3, and closing the CSPR.click "Not used" row on real new capability matters more
for the "Use of Agentic AI"/toolkit-alignment criteria than the CSPR.cloud row
does.

### Gate routing
PASS / PASS WITH FLAGS on both re-researched items → both are implementable
without returning to `brainstorming`. Neither has been implemented yet — this
addendum is research only, per the request ("nghiên cứu chuyên sâu tối đa," not
"implement"). Next step if the user wants to proceed: `writing-plans` for P1
and/or P3, using this addendum's scoping directly.

## Implementation status (2026-07-26, third pass — P3 shipped)

**P3: IMPLEMENTED**, scoped exactly as the addendum above specified (CSPR.click
human-as-x402-payer only, CSPR.cloud half not pursued — lower value, deferred).

Files:
- `src/plugins/x402_casper_shared.ts` (new) — pure, Node-free EIP-712
  constants/types (`SETTLEMENT_TOKEN_NAME`, `DOMAIN_VERSION`,
  `DEFAULT_DOMAIN_CHAIN_NAME`, `TRANSFER_WITH_AUTHORIZATION_TYPE_STRING`,
  `TRANSFER_WITH_AUTHORIZATION_TYPES`, `CasperExactAuthorization`,
  `CasperX402SignedPayload`), split out of `x402_casper.ts` specifically so the
  browser bundle doesn't drag in `node:buffer`/`node:crypto`/keystore imports —
  confirmed the hard way, esbuild failed on exactly those before the split.
  `x402_casper.ts` now imports + re-exports from here; zero behavior change
  (37 pre-existing tests in `x402_casper.test.ts` still pass unmodified).
- `src/web/casper_human_payer_entry.ts` (new) — browser entry point, imports
  the shared constants directly (no re-typed literals), builds the EIP-712
  typed-data object, calls `window.csprclick.signTypedData`.
- `docs/media/casper_human_payer.html` + `docs/media/casper_human_payer.bundle.js`
  (new, built via `pnpm run build:human-payer-page`, esbuild browser target) —
  the actual page a human opens.
- `src/scripts/relay_casper_x402_envelope.ts` (new) — takes the signed
  envelope, runs `verifyCasperExactPayload` (real signature check, not a shape
  check), then relays on-chain via `settleTransferWithAuthorization` using
  KARMA's own funded key (`--live`) or verify-only (default).
- `src/__tests__/x402_casper_human_payer.test.ts` (new) — the load-bearing
  verification. Cross-checks that the generic, schema-driven `hashTypedData`
  (the code path CSPR.click's `signTypedData` uses) produces a digest KARMA's
  own manually-signed envelope's signature verifies against; asserts none of
  the 7 governance-gated method names appear in any of the three new
  human-payer surfaces; asserts the committed bundle isn't stale relative to
  its source.

**Real bug caught before implementation, not after**: the cross-check test's
first run failed with `invalid signature`. Root cause, found by reading
`@casper-ecosystem/casper-eip-712`'s actual source
(`node_modules/.../dist/index.js`, not just its `.d.ts`) rather than guessing:
`casper_human_payer_entry.ts`'s first draft set the EIP-712 domain's
`chain_name` field to `CASPER_TESTNET_CAIP2` (`"casper:casper-test"`) — the
x402 wire `network` field's CAIP-2 id, a different value from a different
namespace than the domain's actual `chain_name` (`"casper-test"`, matching
`X402SettlementToken::init`, exported as `DEFAULT_DOMAIN_CHAIN_NAME`). Fixed
in both the entry file and the test; all 42 x402-Casper tests (37 pre-existing
+ 5 new) and the full suite (903 passed, 1 pre-existing skip) are green after
the fix. This is exactly the audit's L4/L5 risk category playing out for real —
and exactly why the addendum scoped P3 to something with a real verification
path instead of an aspirational one.

**What's verified vs. what isn't** (stated plainly, not implied): the crypto
equivalence (schema-driven vs. manual-concat digest), the browser bundle build,
and the relay script's verify step are all real and tested. A live
click-through with an actual CSPR.click wallet in a real browser is NOT
verified — this sandbox has neither a browser nor a funded wallet — and is
documented as an open gap in README's Known limitations, not claimed as done.

Next: resume P1 (the `casper-go-sdk` `VerifySignature` signature-mismatch
investigation, paused mid-debug). The P3 cross-check test's passing result is
new evidence for P1 too: it proves schema-driven and manual-concat EIP-712
encoding are cryptographically equivalent on the TS/JS side, narrowing P1's
unresolved root cause further toward the Go side (`casper-go-sdk`), not a
KARMA-side encoding divergence.

## P1 root cause (2026-07-26, fourth pass) — closed, not just narrowed

Followed the P3 evidence straight to a conclusive answer. Read
`casper-go-sdk`'s pinned source (commit `8416e84e4256`,
`types/keypair/secp256k1/public_key.go`): its `VerifySignature(msg, sig)`
does `hash := sha256.Sum256(msg)` before checking the ECDSA signature — a
convention that fits Casper's native deploy-signing flow, but is wrong for an
EIP-712 digest (already a final 32-byte hash; must be verified as-is, no
re-hash). The facilitator's `VerifyEIP712Signature`
(`go/x402/signers/casper/facilitator.go`) passes the raw digest straight into
this function, so it always verifies against `sha256(digest)` instead of
`digest`.

Confirmed empirically (not just by reading code): a throwaway Node script
using `@noble/curves`'s secp256k1 — the same primitive both SDKs ultimately
wrap — signed a fixed digest with `casper-js-sdk`'s
`PrivateKey.signAndAddAlgorithmBytes()`, then checked the result against both
hypotheses. Verifies `true` against the raw digest, `false` against
`sha256(digest)`. KARMA signs the raw digest — correct per EIP-712, and
consistent with the on-chain Rust `CEP3009` verifier that already accepts
this exact signing path live (`demo_casper_x402_settlement_live.ts`).

**Verdict: real bug in `make-software/casper-x402` (via `casper-go-sdk`),
not in KARMA.** Not fixable from this repo — see
[RFC §10](../../rfc/2026-07-21-x402-casper-eip712-interop.md#10-external-facilitator-interop-attempt-2026-07-26--root-cause-found)
for the full write-up. README's Known limitations and the RFC's status
header are both updated. The self-hosted facilitator
(Docker, `casper-x402-facilitator:local`) is still running for anyone who
wants to reproduce this independently; the diagnostic scripts used to reach
this conclusion were scratch-only and have been cleaned up (not part of the
repo — the finding is captured here and in the RFC instead).

P1 is now closed as "root-caused, external, not actionable from this repo,"
not left open or abandoned. Funding the facilitator's gas key and driving a
real `/settle` call would not change this outcome (`/verify` already fails
upstream of that step) and is no longer useful additional work.
