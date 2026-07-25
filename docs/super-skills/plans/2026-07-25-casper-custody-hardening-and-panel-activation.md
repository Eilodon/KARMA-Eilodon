# Casper Custody Hardening + Panel Activation — Implementation Plan

> **For agentic workers:** Executed directly in this session (no subagent dispatch — scope is
> small, sequential, and mostly config/build/doc work, not new application logic).

**Goal:** Close the upgrade-token custody gap on both live Odra contracts by redeploying Locked
(`is_upgradable: false`, verified platform-enforced — see spec §3a), bundle in the
already-implemented, already-tested panel-arbitration code, and hand the owner an exact,
ready-to-run redeploy recipe with a 30-minute timelock chosen specifically so the panel can be
proposed, timelock-waited, executed, and live-disputed today. This session cannot broadcast the
real transaction itself (no funded credentials — spec §5); the deliverable is everything up to
that point plus the exact handoff command.

**Spec:** [`docs/super-skills/specs/2026-07-25-casper-custody-hardening-and-panel-activation-design.md`](../specs/2026-07-25-casper-custody-hardening-and-panel-activation-design.md)
— **Gate Result: PASS WITH FLAGS** (Failure Mode 1: `X402SettlementToken` roadmap-conflict
assumption, LOW; macro-codegen middle-link assumption, LOW). Neither blocks this plan.

**Risk Flags:** Task 1 (toolchain install) is the only task with real failure probability in this
sandboxed session — time-boxed per the spec's Failure Mode 3 mitigation. All other tasks are
config/doc edits with a `git revert` rollback.

---

## Task-Risk-Score Self-Review

```
CONTEXT_TYPE: INFRASTRUCTURE (deploy config + toolchain + docs — not user-facing business logic)
```

| Task | Severity | Blast-Radius | Detectability | QBR | Decompose? |
|---|---|---|---|---|---|
| 1. Toolchain install | 1 (session-local, no code risk) | 1 (this session only) | 1 (immediate: command fails or succeeds) | 1 | No |
| 2. Custody fix (deploy scripts) | 2 (wrong arg = redeploy with the bug unfixed) | 2 (both contracts' redeploy) | 1 (grep confirms the literal arg value pre-deploy) | 4 | No |
| 3. Rust test baseline | 1 | 1 | 1 (test output is unambiguous) | 1 | No |
| 4. wasm build | 2 (bad build = unusable artifact) | 1 (local file only, not yet deployed) | 1 (build either succeeds or errors) | 2 | No |
| 5. Deploy-command prep | 2 (wrong gas/args = a failed real deploy if owner copy-pastes it) | 3 (real CSPR spent on a failed attempt) | 2 (only caught if owner reads output carefully) | 3 | No |
| 6. Doc drift fix | 1 (docs only) | 1 | 1 (diff review) | 1 | No |

No task reaches HIGH (≥6) — no decomposition needed. Task 5 is the one to read back most
carefully before handoff (real money, lower detectability than the others).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/scripts/deploy_casper_governance_hardened.ts` | Registry deploy args — flip `is_upgradable`, note new timelock |
| `src/scripts/deploy_x402_settlement_token.ts` | Token deploy args — flip `is_upgradable` |
| `contracts-odra/build-wasm.sh` | Unchanged — just run it |
| `README.md` | Security notes §3 correction + scope fix |
| `DEMO_CASPER.md` | Security notes correction + new "prepared redeploy" section with exact commands |
| `docs/super-skills/adrs/2026-07-25-casper-custody-hardening-and-panel-activation.md` | ADR, written after execution (per `adr-commit`) |

---

## Task 1: Toolchain setup (time-boxed)

- [ ] **Step 1:** `rustup target add wasm32-unknown-unknown --toolchain nightly`
- [ ] **Step 2:** `cargo install cargo-odra` (or confirm already resolvable from the vendored
      registry cache if offline install works)
- [ ] **Step 3:** On failure of either step after one retry: **stop**, do not retry a third time
      (Cognitive Load Circuit Breaker) — proceed to Task 2 anyway (code/doc edits do not need the
      toolchain), and note in the handoff that wasm build+verify must happen on the owner's own
      machine instead.

## Task 2: Custody fix — both deploy scripts

**Files:**
- Modify: `src/scripts/deploy_casper_governance_hardened.ts:55`
- Modify: `src/scripts/deploy_x402_settlement_token.ts:52`

- [ ] **Step 1:** In `deploy_casper_governance_hardened.ts`, change
      `odra_cfg_is_upgradable: CLValue.newCLValueBool(true)` →
      `CLValue.newCLValueBool(false)`, with a comment citing spec §3a's two verified source
      locations (odra-core `host.rs`/`consts.rs`, casper-execution-engine `runtime/mod.rs`
      `is_locked()` checks) — not a bare "for security" comment.
- [ ] **Step 2:** Same edit in `deploy_x402_settlement_token.ts:52`.
- [ ] **Step 3:** In `deploy_casper_governance_hardened.ts`, change the `timelock_delay_ms`
      session arg from whatever the current recipe example uses to `"1800000"` (30 min in ms),
      with a comment citing spec §3b (execute_proposal applies the same delay to every proposal
      type, including panel setup — no fast path).
- [ ] **Step 4:** Grep-verify both files no longer contain `is_upgradable.*true`:
      `grep -n "is_upgradable" src/scripts/deploy_casper_governance_hardened.ts
      src/scripts/deploy_x402_settlement_token.ts` → expected: both show `false`.
- [ ] **Step 5:** Commit: `git commit -m "fix(casper): lock both Odra contracts on redeploy —
      is_upgradable:false closes the _access_token custody gap (verified against EE source, not
      assumed)"`

## Task 3: Rust test baseline (confirm no regression from a deploy-arg-only change)

- [ ] **Step 1:** `cargo +nightly test --manifest-path contracts-odra/Cargo.toml` → expected:
      `155 passed; 0 failed` (deploy scripts are TypeScript, outside the Rust crate — this is a
      sanity check, not expected to move).
- [ ] **Step 2:** If not 155/155, **stop** — this means the working tree already had a
      pre-existing regression unrelated to this change; do not proceed to Task 4 until root-caused
      (`systematic-debugging`).

## Task 4: Build the wasm artifact

- [ ] **Step 1:** `cd contracts-odra && ./build-wasm.sh`
- [ ] **Step 2:** Verify: `ls -la wasm/karma_odra.wasm` exists, non-trivial size (README cites
      ~535KB for the prior build as a sanity reference, not a hard requirement — sizes shift
      release to release).
- [ ] **Step 3:** `python3 -c "import sys; d=open('wasm/karma_odra.wasm','rb').read(); print(d[:4])"`
      → expected: `b'\x00asm'` (valid wasm magic bytes — cheap smoke test that the artifact isn't
      truncated/corrupt).
- [ ] **Step 4 (only if Task 1 failed):** Skip this task; note in handoff that the owner must run
      Steps 1-3 locally before deploying.

## Task 5: Prepare exact deploy commands (both contracts)

**No code changes** — this task produces the copy-paste block for the handoff message and for
`DEMO_CASPER.md`.

- [ ] **Step 1:** Registry deploy command — same shape as `DEMO_CASPER.md`'s existing verified
      recipe (Step 0/Step 1), with `odra_cfg_is_upgradable: false` and `timelock_delay_ms:
      "1800000"` substituted in, gas kept at `800000000000` motes (the value the project's own
      prior attempts already proved necessary — do not silently "optimize" this down).
- [ ] **Step 2:** `X402SettlementToken` deploy command — same substitution for
      `odra_cfg_is_upgradable`.
- [ ] **Step 3:** Post-deploy verification commands (decode `governance_signers` /
      `governance_threshold` / `timelock_delay` / contract-package lock status directly from
      on-chain state) — reuse the pattern `DEMO_CASPER.md` already documents for the two prior
      hardening redeploys, not a new ad hoc check.
- [ ] **Step 4:** Panel-activation sequence: `propose_set_arbiter_panel` → (optional, for
      evidence) attempt `execute_proposal` immediately and confirm `TimelockNotElapsed` reverts →
      wait 30 min → `execute_proposal` succeeds → seed a job → `dispute_result_via_panel` →
      2-of-3 `cast_panel_vote` → confirm settlement, mirroring the existing single-arbiter
      courtroom flow's evidence format in `DEMO_CASPER.md`.

## Task 6: Fix doc drift (README.md, DEMO_CASPER.md)

**Files:**
- Modify: `README.md` (Security notes section, currently lines ~728-754)
- Modify: `DEMO_CASPER.md` (Security notes section, currently lines ~240-260)

- [ ] **Step 1:** `README.md` Security notes item 3 ("Upgrade-token custody — still open,
      disclosed, not fixed") → rewrite to: scope now correctly names **both**
      `AgentSkillRegistry` and `X402SettlementToken`; status changed from "not resolved" to "fix
      prepared this session (`is_upgradable: false`, verified against Casper execution-engine
      source — see spec), **redeploy pending owner execution**" — never claim "resolved" or
      "live" without a real transaction hash to point to.
- [ ] **Step 2:** Same correction in `DEMO_CASPER.md`'s parallel section, plus a new subsection
      with the exact deploy commands from Task 5, clearly headed "prepared, not yet broadcast."
- [ ] **Step 3:** Grep the rest of both files for any other place that describes the custody gap
      or the panel feature as unresolved/pending, to catch any other stale reference this specific
      change makes outdated (per owner instruction — fix drift found along the way, not just the
      one spot originally flagged): `grep -n "not fixed\|still open\|pending redeploy\|N-of-M
      panel arbitration.*tested" README.md DEMO_CASPER.md`.
- [ ] **Step 4:** Commit: `git commit -m "docs: correct custody-gap scope (X402SettlementToken)
      and record the prepared-not-yet-broadcast redeploy"`

## Task 7: Handoff

- [ ] Produce a short, explicit chat message (not buried in a doc): exactly which command(s) the
      owner needs to run, in what order, and why this session could not run them itself
      (spec §5). Update Task tool statuses to reflect what's actually done vs. handed off.

---

## Rollback Plan

- Tasks 1, 3, 4: no repo state changes — nothing to roll back (toolchain/build artifacts are
  session-local or gitignored).
- Task 2, 6: `git revert <commit-sha>` for each commit; verify with
  `grep -n "is_upgradable" src/scripts/deploy_*.ts` returning to `true` after revert, and
  `git diff README.md DEMO_CASPER.md` showing no residual changes.
- No on-chain action is taken by this plan (see spec §5) — there is nothing to roll back
  on-chain; the currently-live `hash-42f6945f…` contract is untouched throughout.
