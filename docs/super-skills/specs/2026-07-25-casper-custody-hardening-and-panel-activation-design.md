---
SPEC_APPROVED: true
---

# Spec: Casper Governance-Custody Hardening + Panel Activation Redeploy

## 1. Context
- 2026-07-25, Casper Agentic Buildathon Final Round deadline 2026-07-26 23:59 (~24h remaining at
  time of writing).
- Direct continuation of `docs/super-skills/adrs/2026-07-22-panel-arbitration-n-of-m.md`'s own
  declared **Next Cycle Trigger**: "When a panel-mode dispute is actually posted against a live
  deployed contract."
- A competitive-analysis pass (this session, via Tavily research against the other Buildathon
  Final Round submissions) plus a CALM-based code audit of this repo surfaced two real gaps in
  the **currently live** contract (`hash-42f6945f…`, deployed 2026-07-21):
  1. **Upgrade-token custody** — `README.md:747-751`, `DEMO_CASPER.md:247-254`: Odra's install
     deploy grants an `_access_token` named key to the deploying account; whoever holds that
     key's private material can push a new contract version bypassing the on-chain
     multisig+timelock governance entirely. Currently held by governance signer 1's key.
     Disclosed by the project itself as "still open, disclosed, not fixed."
  2. **Undisclosed scope** — the identical exposure exists on `X402SettlementToken`
     (`contracts-odra/src/x402_settlement_token.rs`), confirmed via
     `src/scripts/deploy_x402_settlement_token.ts:52` (`odra_cfg_is_upgradable: true`). Neither
     `README.md` nor `DEMO_CASPER.md` mentions this contract in the custody discussion — doc
     drift, corrected as part of this change (per explicit owner instruction: fix stale
     docs/spec/comments found along the way, don't just flag them).
  3. **Panel N-of-M arbitration** (`dispute_result_via_panel` / `cast_panel_vote` /
     `resolve_panel_default`) is fully implemented and tested (155/155,
     see 2026-07-22 ADR) but is not present in the currently-live contract's bytecode — the last
     redeploy (2026-07-21) predates the panel commit.

## 2. Goal
Redeploy `AgentSkillRegistry` (and, separately, `X402SettlementToken`) once each, bundling:
- A verified, permanent fix for the custody exposure on **both** contracts.
- Panel-arbitration code in the registry redeploy (already in source — no new Rust to write).
- A live, on-chain proof of `execute_proposal`'s panel setup on Casper Testnet before the
  Buildathon deadline, without weakening the "real enforced timelock" evidentiary story this
  project has built everywhere else.

## 3. Design decisions — verified against real code, not docs

### 3a. Custody fix: `odra_cfg_is_upgradable: false` (not "dedicated multisig custody")

`README.md:749-750` floats two options without resolving between them. Resolved here by reading
the actual vendored framework/platform source in this environment's Cargo registry cache, not by
trusting either the README's phrasing or Odra's own doc comments at face value:

- `odra-core-2.9.0/src/host.rs:149-186` — `InstallConfig.is_upgradable` is forwarded to the
  session arg named by `odra-core-2.9.0/src/consts.rs:49`
  (`IS_UPGRADABLE_ARG = "odra_cfg_is_upgradable"`).
- `casper-execution-engine-8.1.1/src/runtime/mod.rs:2607-2641`
  (`add_contract_version_by_contract_package`) and `:2725-2753`
  (`add_contract_version_by_package`) — **both** unconditionally
  `return Err(ExecError::LockedEntity(...))` when `contract_package.is_locked()` /
  `package.is_locked()`, checked and rejected *before* any access-key/URef validation runs later
  in the same function.

**Conclusion, verified not assumed:** a Locked contract package (`is_upgradable: false`) can
never have a new version added by anyone — including whoever holds `_access_token` — because the
Casper execution engine itself refuses the call at the platform level. This is a *stronger*
guarantee than "move custody to a dedicated multisig account" (which only raises the bar to
compromise the single key, it doesn't eliminate the single-key upgrade path as a concept), it is
platform-verified rather than assumed, and it needs zero new tooling this session has no way to
test live anyway (see §5).

**Trade-off, accepted knowingly:** this KARMA v1 Casper registry instance becomes permanently
frozen at its current entry-point set (now including panel) after this redeploy — no more
`add_contract_version`, ever, on this package hash. This is consistent with, not opposed to, the
project's own CEP-0000 standardization framing: a locked, audited v1 is a *stronger*
trust-infrastructure claim ("this contract's rules cannot be silently changed under you") than
"upgradable, trust us." A future v2 interface change becomes a fresh deployment with its own
address, not a silent upgrade of this one. Locking does **not** block governance actions
(`propose_*`/`approve_proposal`/`execute_proposal`, arbiter, panel, cross-chain-rep) — those are
plain public entry points on the already-installed contract, an entirely different code path from
`add_contract_version`, unaffected by `is_locked()`.

### 3b. Timelock for this redeploy: 30 minutes (`1_800_000` ms) — not 48h, not 0

- Verified: `execute_proposal` (`contracts-odra/src/agent_skill_registry.rs:1628-1693`) applies
  `self.timelock_delay.get_or_default()` uniformly to **every** `ProposalAction` variant,
  including `SetArbiterPanel` — there is no fast path in the real code for governance-object
  setup, contradicting an implicit hope that panel setup might be exempt.
- At the currently-live 48h value, `propose_set_arbiter_panel` → `execute_proposal` cannot
  complete before the 2026-07-26 23:59 deadline — this is a protocol-level wait, not something
  more working hours can shorten.
- 30 minutes is: long enough that a `TimelockNotElapsed` revert is genuinely observable on a real
  wall clock (proof the guard is real, mirroring the existing 48h cross-chain-rep evidence
  pattern already published in `DEMO_CASPER.md`); short enough to leave hours of same-day margin
  for the live panel-dispute demo afterward.
- Direction chosen (per owner instruction, "hướng A"): touch only this new deployment's
  `timelock_delay_ms`. The **old** `hash-42f6945f…` contract's history (48h, at the time) is
  untouched and remains truthfully described as historical fact in the docs — nothing is
  retroactively reframed.

## 4. Non-goals
- Casper native multisig-account custody experimentation — unverifiable without live network
  credentials this session, and strictly weaker than §3a's conclusion regardless.
- Pharos or Stellar contracts.
- A mainnet deploy.
- `dead_code_pct` triage (separate, low-priority, unrelated to this spec's security scope).

## 5. Constraints (binding on the plan)
- This session has **no funded Casper Testnet credentials**: `env | grep -i casper` → empty, no
  `.env`, no `keystore.json*` present. The RPC endpoint requires an Authorization header this
  session cannot supply (`curl https://node.testnet.cspr.cloud/status` → `401`). **This session
  cannot itself broadcast the redeploy transaction.** Everything through "wasm builds, tests
  pass, exact deploy command ready to paste" is this session's deliverable; the actual
  `casper-client put-deploy` execution is the repo owner's action, per `DEMO_CASPER.md:392-394`'s
  own stated policy that funded keys should reach an AI session "deliberately... never
  incidentally."
- `wasm32-unknown-unknown` rustup target and `cargo-odra` are not installed in this session yet —
  the plan attempts this early and time-boxes it (see Failure Mode 3 below).

## Acceptance Criteria
- [ ] Both deploy scripts changed to `odra_cfg_is_upgradable: false`, with an inline comment
      citing the verified execution-engine source lines (no bare unverified claim in the comment).
- [ ] `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` — 155/155 (a deploy-arg-only
      change should not affect this; run anyway as the baseline-preserved check).
- [ ] `contracts-odra/build-wasm.sh` succeeds, produces `wasm/karma_odra.wasm` — compiled from
      current `HEAD`, which already contains the panel entry points.
- [ ] `README.md` / `DEMO_CASPER.md` security notes corrected: scope now correctly includes
      `X402SettlementToken`; custody item marked "fix prepared, redeploy pending owner execution"
      — never silently marked resolved without real transaction evidence.
- [ ] Exact, copy-paste-ready `casper-client put-deploy` commands hand ready for both contracts,
      parameterized with the 30-minute timelock and `is_upgradable: false`.
- [ ] Explicit handoff note to the owner: what's left to run, and why this session cannot run it.

---

## Risk Assessment (audit-design)

```
CONTEXT_MODE:      DESIGN
STAKEHOLDER:       hackathon judges (Final Round: Technical Execution + Working Smart Contracts
                   criteria) + KARMA's own long-term security posture
GOAL:              pre-mortem before redeploy — a real on-chain, one-way action (new contract
                   address becomes "current"; Locked status is permanent by design)
AUDIT_TARGET_TIER: 2 (production-adjacent: real testnet funds and real governance keys involved
                   in the handoff, but not PII / mainnet / multi-tenant)
```

### Pre-mortem — 3 Failure Modes

**Failure Mode 1:** Locking `X402SettlementToken` before confirming no test or planned roadmap
feature depends on upgrading this specific token contract → would be HIGH if true (silently
forecloses a stated roadmap item).
→ Checked this session via `file_overview` on `contracts-odra/src/x402_settlement_token.rs`: only
`init`/`deposit`/`withdraw` + tests, 10 symbols total, no governance surface of its own. The
roadmap's "v2 settlement rail extensions" (`docs/standards/IPaymentPlugin-v1.md`) read as new
rail *implementations* (new files), not a stated upgrade path for this specific CEP-18 token.
**ASSUMED** — not exhaustively re-read against `IPaymentPlugin-v1.md`'s full text this session
(time-boxed). Risk: LOW even if wrong — the fix in that case is a fresh
`X402SettlementTokenV2` deploy, not a blocked path.

**Failure Mode 2:** A 30-minute timelock chosen for expedience could read to a skeptical judge as
governance theater (weakened specifically to make a same-day demo possible), not a genuine
security parameter → MED reputational risk to the "real tx, not a diagram" evidentiary standard
this project has otherwise earned everywhere else.
→ Mitigated in the plan: demonstrate `TimelockNotElapsed` reverting on a deliberate early-execute
attempt (same evidentiary pattern already used for the 48h cross-chain-rep proposal in
`DEMO_CASPER.md`) — proves the guard is real and enforced, not merely present in name. Docs state
the 30-minute value and this rationale plainly.

**Failure Mode 3:** Installing `wasm32-unknown-unknown` + `cargo-odra` in this sandboxed session
(neither present, network access unverified for large toolchain downloads) could fail partway,
burning time without a usable wasm artifact → MED time-cost risk against a hard deadline.
→ Mitigated: attempted early (first task after code edits, not last), hard-time-boxed; on
persistent failure, hand the user the exact local build command rather than repeatedly retrying
(Cognitive Load Circuit Breaker: 3 failed attempts at the same install step → stop, hand off).

### L1-L7 Quick Scan
- **L1 Logic:** no signal — deploy-arg-only change, no new branching logic.
- **L2 Concurrency:** no signal — single deployer, sequential steps, no shared mutable state
  across concurrent actors introduced.
- **L3 Data:** contract package status transitions Unlocked→Locked at install time, one-way by
  design (§3a) — this *is* the intended change, not a residual risk.
- **L4 Integration:** Casper Testnet RPC — this session cannot reach it with auth; the real risk
  is the handoff step failing silently if the owner doesn't actually run the handed-off command.
  Mitigated by an explicit, unambiguous acceptance-criteria item ("pending owner execution").
- **L5 Security:** this change *is* the security hardening; the core claim (Locked blocks upgrade
  regardless of key custody) was chased to primary source (execution-engine code, §3a), not
  assumed from the README's own framing of the two options.
- **L6 Observability:** post-redeploy verification reuses the repo's own established pattern —
  decode `governance_signers`/`governance_threshold`/`timelock_delay` directly from on-chain
  state (not the deploy tool's exit code), plus a new check for contract package lock status.
- **L7 Cross-cutting:** real secret-key handling is involved in the handoff step — flag **L7.11**.
  Mitigated by never soliciting key material in-session; commands are handed over, broadcast is
  the owner's action.

### Auditor Defense
- **ASSUMED:** "`X402SettlementToken` has no future upgrade dependency" — see Failure Mode 1.
- **ASSUMED:** Odra's macro-generated install bootstrap actually forwards
  `odra_cfg_is_upgradable` byte-for-byte into the native `create_contract_package_at_hash` host
  call the way `odra-core`'s `host.rs` doc comment states. Both *ends* of this chain were
  independently verified against real source this session (the session-arg name on one end, the
  execution-engine's unconditional lock enforcement on the other) — the middle link
  (`odra-macros`' generated code, a proc-macro output, not statically greppable in this
  environment) was not stepped through directly. Treated as sufficiently corroborated by both
  endpoints agreeing, flagged as one notch below the rigor applied to the EE check itself.
- No "TBD"/"later" language in the Acceptance Criteria — every item is a concrete pass/fail.

### Gate Result: **PASS WITH FLAGS**
Both flags (Failure Mode 1's roadmap-conflict assumption; the macro-codegen middle-link
assumption) are LOW severity given the chain of evidence already gathered — not blocking.
Proceed to `writing-plans`; carry both flags into the plan's own risk notes.
