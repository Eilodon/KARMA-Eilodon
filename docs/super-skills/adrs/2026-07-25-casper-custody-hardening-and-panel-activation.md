# ADR: Casper Custody Hardening (Locked Redeploy) + Panel-Activation Prep

## 1. Title
Close the `_access_token` upgrade-custody gap on both live Odra contracts by locking them
(`is_upgradable: false`) on their next redeploy, and prepare (not yet broadcast) the panel-N-of-M
activation that redeploy unlocks.

## 2. Context
Direct continuation of `docs/super-skills/adrs/2026-07-22-panel-arbitration-n-of-m.md`'s own
declared Next Cycle Trigger. A competitive-analysis pass against other Casper Agentic Buildathon
Final Round submissions (this session), followed by a CALM-based code audit of this repo, surfaced:
a previously-disclosed-but-unfixed upgrade-token custody gap on `AgentSkillRegistry`; the
identical, previously **undisclosed** gap on `X402SettlementToken`; and confirmation that the
already-implemented, already-tested (155/155) panel-arbitration feature was still absent from the
live contract's bytecode. Full reasoning:
[spec](../specs/2026-07-25-casper-custody-hardening-and-panel-activation-design.md) (Gate Result:
PASS WITH FLAGS) · [plan](../plans/2026-07-25-casper-custody-hardening-and-panel-activation.md).

## 3. Decision
Chose `odra_cfg_is_upgradable: false` over "move `_access_token` custody to a dedicated multisig
account" (the two options `README.md` had left unresolved), **after reading the real platform
source rather than trusting either the README's phrasing or Odra's own doc comments**:
`casper-execution-engine-8.1.1/src/runtime/mod.rs`'s `add_contract_version_by_contract_package`
and `add_contract_version_by_package` both unconditionally `Err(ExecError::LockedEntity(...))`
when the contract package is Locked, checked *before* any access-key/URef validation runs later in
the same function [verified 2026-07-25 — read directly from the vendored crate source in this
session's Cargo registry cache, `~/.cargo/registry/src/.../casper-execution-engine-8.1.1/`, not
from any doc]. A Locked package can never have a new version added by anyone, including whoever
holds `_access_token` — strictly stronger than raising the bar on a single key, and it needs no
new tooling.

Applied to **both** contracts (`src/scripts/deploy_casper_governance_hardened.ts:74`,
`src/scripts/deploy_x402_settlement_token.ts:60`), each with an inline comment citing the two
source locations rather than a bare assertion. `X402SettlementToken`'s scope was previously absent
from `README.md`/`DEMO_CASPER.md`'s custody discussion entirely — corrected as doc drift found
along the way, per the owner's explicit instruction to fix stale docs immediately rather than only
flag them.

Separately, `timelock_delay_ms` for the `AgentSkillRegistry` redeploy was set to 30 minutes
(`"1800000"`), down from the currently-live contract's 48h, specifically because
`execute_proposal` (`contracts-odra/src/agent_skill_registry.rs:1628-1693`) applies the same
timelock uniformly to every `ProposalAction` including `SetArbiterPanel` — verified by reading the
function directly [verified 2026-07-25], not assumed exempt. At 48h, activating the panel could
not complete before the Buildathon deadline. 30 minutes keeps `TimelockNotElapsed` genuinely
observable on an early-execute attempt (real proof the guard is enforced) while leaving same-day
margin. This changes only the *new* deployment's parameter; the currently-live contract's own
history (48h, at the time) is untouched and described unchanged.

Both wasm artifacts were rebuilt from current `HEAD` via `contracts-odra/build-wasm.sh`
(`wasm/karma_odra.wasm`, 592110 bytes; `wasm/x402_settlement_token.wasm`, 448906 bytes) and
independently verified via `WebAssembly.Module.exports()` (the same method
`DEMO_CASPER.md` already used for the prior governance-hardening redeploy's verification, not a
new ad hoc check) [verified 2026-07-25 — all of `dispute_result_via_panel`, `cast_panel_vote`,
`resolve_panel_default`, `propose_set_arbiter_panel`, `propose_set_panel_arbiter_fee`,
`get_arbiter_panel`, `get_panel_threshold`, `attest_rationale`, `get_rationale_hash` present in
the compiled export list, 68 exports total].

## 4. Status
**ACCEPTED — broadcast and verified live, 2026-07-25.**

Credentials arrived later the same day (owner-provided `.env`, gitignored) via a public RPC node
(`node.testnet.casper.network`, no Authorization header needed — unlike the earlier `cspr.cloud`
endpoint that returned `401`). Both redeploys broadcast with explicit owner confirmation, captured
live via `demo-video/record_casper.sh redeploy-registry redeploy-token` (real pty sessions, not
re-runnable-for-a-recording). Both verified against real on-chain state afterward, not the tool's
exit code: `query_global_state` → `lock_status: Locked` on both new package hashes;
`CasperLiveClient` reads → `governance_threshold: 2`, `timelock_delay_ms: 1800000`,
`arbiter_panel: []` on the new registry. See `DEMO_CASPER.md`'s "Custody-hardening redeploy"
section for the transaction table. All code, doc, and this ADR's own changes committed and pushed
to `claude/hackathon-karma-comparison-ku59mx` (`da4cf22`, `105acc1`, `ca36dac`, plus the commit
landing this update).

## 5. Consequences

**Improved:**
- The custody gap closes for good, platform-verified, once the owner runs the two redeploy
  commands — not just "raises the bar," genuinely eliminates the single-key-upgrade class of risk.
- Scope correction (X402SettlementToken) means the project's own security disclosure is now
  accurate, not just the registry's half of the real exposure.
- Panel arbitration becomes activatable same-day once broadcast, closing the gap between "155/155
  tests pass" and "live, verified on-chain" that the project holds every other feature to.

**Worsened / new surface:**
- `AgentSkillRegistry` becomes permanently un-upgradable after this redeploy — accepted knowingly
  (spec §3a); a future v2 interface is a fresh deployment, not a silent upgrade of this address.
- The 30-minute timelock (vs. 48h) is a genuine, real, enforced delay, but a smaller number than
  the flagship's current headline figure — documented plainly with rationale (spec §3b) rather
  than obscured, specifically to preempt the "governance theater" reading a skeptical judge might
  otherwise reach for.

## 6. Alternatives Considered
- **Dedicated multisig-controlled deploying account** — rejected: strictly weaker than Locked
  (still a single-key-class risk, just harder to compromise), and unverifiable live in this
  session anyway (no network credentials to test Casper account key-weight tooling).
- **Two contract instances** (flagship keeps 48h untouched; a separate short-timelock instance
  proves the panel mechanism) — rejected in favor of touching only the flagship's timelock
  parameter for this new deployment: simpler single-address story, no second contract to explain
  to judges, and the flagship's *historical* 48h figure remains truthfully described regardless.
- **`timelock_delay_ms: 0`** — rejected: would make `TimelockNotElapsed` unobservable in practice
  (any elapsed time satisfies a zero requirement), undermining the "the guard is real, not just
  present" evidentiary goal this repo holds everywhere else.

## 7. Evidence
- `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` → **155 passed; 0 failed**
  [verified 2026-07-25] — unaffected by the deploy-arg-only change, as expected; confirms no
  pre-existing regression in the working tree before proceeding.
- `contracts-odra/build-wasm.sh` (default module, `AgentSkillRegistry`) →
  `wasm/karma_odra.wasm`, 592110 bytes, magic bytes `\x00asm` confirmed
  [verified 2026-07-25].
- `contracts-odra/build-wasm.sh X402SettlementToken wasm/x402_settlement_token.wasm` →
  448906 bytes [verified 2026-07-25].
- `WebAssembly.Module.exports()` on the freshly built `karma_odra.wasm` → all 9 targeted panel /
  rationale-attestation entry points present, 68 exports total [verified 2026-07-25].
- `pnpm exec tsc -p tsconfig.json --noEmit` → 12 pre-existing errors, all in `src/plugins/t3.tool.ts`
  (a `@terminal3/t3n-sdk` version-mismatch class of error, e.g. missing `AgentAuthScriptGrant`
  export) — **zero errors in either file this change touched**
  [verified 2026-07-25], consistent with the 2026-07-22 ADR's own baseline-noise pattern (pre-existing,
  environment-dependency errors unrelated to the change under review).
- `grep -n "not fixed\|still open\|two options on the table\|not resolved here" README.md
  DEMO_CASPER.md` → zero matches after the doc edits [verified 2026-07-25] — confirms no other
  stale "still open" framing was left behind for this specific gap.

## 8. Owner
**Eilodon (repository owner) — implemented with Claude Code agent assistance, session dated
2026-07-25.**

## 8b. Known Debts (PATTERN-DEBT)
- **PATTERN-DEBT-x402-settlement-token-roadmap-conflict** — Failure Mode 1 in the spec's Risk
  Assessment flagged, as ASSUMED not fully chased down, that no planned roadmap feature depends on
  upgrading `X402SettlementToken` specifically. If a future `docs/standards/IPaymentPlugin-v1.md`
  v2 rail turns out to need an in-place upgrade of *this* token contract rather than a fresh
  deploy, that plan will need to route around the lock this ADR just applied. [status: OPEN,
  introduced by this change]
- **PATTERN-DEBT-odra-macro-codegen-unverified-middle-link** — the mapping from
  `odra_cfg_is_upgradable` (session arg) to the native `create_contract_package_at_hash` host
  call's lock argument was verified at both endpoints (Odra's `host.rs`/`consts.rs`, and the
  execution engine's `is_locked()` enforcement) but not by stepping through `odra-macros`'
  proc-macro-generated bootstrap code itself. If a future Odra version changes this wiring, this
  ADR's Locked-status claim should be re-verified against the new version before being relied on
  again. [status: OPEN, introduced by this change]

## 9. Next Cycle Trigger
When the owner actually broadcasts both redeploys (`DEMO_CASPER.md`'s "Prepared redeploy" section)
and either (a) the panel-activation sequence completes live — replace that section's placeholder
framing with the real transaction table, mirroring every other flow in `DEMO_CASPER.md` — or
(b) the redeploy reveals the macro-codegen assumption (Known Debt above) was wrong, in which case
re-open this ADR's decision before trying again.

## 10. Cycle Retrospective
- `build-wasm.sh` needed both `wasm32-unknown-unknown` (rustup target) and the `rust-src`
  component before it would build with `-Z build-std=core,alloc` — the target alone silently
  isn't sufficient; `rustup component add rust-src --toolchain nightly` was the actual missing
  step, caught on the first real attempt (not guessed from docs alone; `DEMO_CASPER.md` Step 0
  already listed it, but it's easy to under-read as optional when skimming — treat both installs
  as one atomic prerequisite, not two independent optional ones, in any future write-up).
- `cargo-odra` installed cleanly from source in the background while other tasks proceeded in
  parallel — a useful pattern for time-boxed tool setup on a hard deadline: kick off the slow
  step, do independent work while it runs, don't block on it synchronously.
- The deepest and most time-costly part of this cycle was *not* writing code — it was chasing the
  `is_upgradable: false` claim to primary source (execution-engine crate) instead of accepting
  either the README's own framing or Odra's doc comment at face value. This is exactly the kind of
  check that's easy to skip under deadline pressure and would have been wrong to skip: it changed
  the actual recommendation (Locked, not multisig-custody) from what the README had left as an
  open toss-up.

**Same-day addendum, once credentials arrived:** §4's "no funded credentials" blocker was lifted
mid-cycle (owner-provided `.env`, gitignored). Before broadcasting anything, re-verified against
real chain state rather than trusting this ADR's own prior "prepared" framing: both signer
accounts confirmed real and funded via `query_balance` against `https://node.testnet.
casper.network/rpc` (a different, public node than the `401`-gated one — no auth header needed).
That same discipline — read the actual Odra bootstrap source
(`odra-casper-wasm-env-2.9.0/src/host_functions.rs:106-110`) instead of assuming the prepared
recipe was correct — caught a **second** real bug: signer 1 already deployed both contracts once
before, so `odra_cfg_allow_key_override: false` (unchanged until this point) would have hit
`ExecutionError::CannotOverrideKeys` and reverted, burning real gas for nothing. Fixed to `true`
in both scripts. Lesson: "the design was audited" does not mean "the exact bytes about to be
submitted were re-checked against the account they're actually being submitted from" — those are
different checks, and the second one only became possible (and necessary) once real credentials
and real RPC access existed. `DEMO_CASPER.md`'s Prepared-redeploy section updated to match.
