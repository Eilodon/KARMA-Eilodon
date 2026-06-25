# Session handoff — 2026-06-25 14:22 +07 (Thursday)

> Machine-readable continuity doc. Next session: read this, then `git log --oneline -8`, then continue
> from §"Next steps". Repo: `/home/ybao/B.1/KARMA`. Remotes: **origin = Eilodon/KARMA-NEW** (roadmap
> work lives here), mathenemy = MathEnemy/KARMA.

## 1. What this session did — roadmap execution (vision-first strategic roadmap)

Executed the deadline-critical slice of the strategic roadmap, each item TDD'd through the DPS
SuperSkills pipeline (complexity-gate → tdd-verified → verification-before-completion → adr-commit).

| # | Item | Result | Landed |
|---|---|---|---|
| 1 | **T2.1** skill-composition MCP surface | `OdraRegistry` + composition tools (JS twin of the Rust contract), 15 tests | PR #8 merged |
| 2 | **T5.2** cross-chain demo | runs **offline** (labelled mock proof fallback), exit 0 | PR #8 merged |
| 3 | **T5.1** autonomous-loop live runner | `runner.ts` + `run_autonomous_loop.ts`; dry-run verifiable, `--live` testnet owner-driven, 6 tests | PR #8 merged |
| 4 | **T0.3** P3-hard RFC | `docs/rfc/2026-06-24-symmetric-dispute-bond.md` (design-only, owner-approval gate) | merged to main |
| 5 | **T1.3** cross-chain reputation oracle | `src/lib/zk/rep_oracle.ts` (prover-side service), demo rewired through it, 10 tests | merged to main |

Plus this handoff + a README rewrite to reflect the multi-chain reality.

**Earlier same effort (prior context):** roadmap-tracks consolidation merged T0.1/T0.2 (PR#4) +
branch-5 (T1.1 rep-agg ZK, T2.1 Odra, T5.1/T5.2/T5.4 demos, T1.4 signed-TLS fallback) + T4 standards
docs; closed PRs #5/#6/#7 as superseded. See [[karma-roadmap-tracks-merge]].

## 2. Current state

- `main` HEAD has everything above merged locally (RFC `b44a62e`, oracle `b49144b`, merge `d0e5197`)
  + this handoff + README update. **Pushed to origin; PRs #9/#10 closed; their branches deleted.**
- Tests: **vitest 636 pass / 1 skip** · Odra cargo 45 (needs `cargo +nightly`) · Soroban verifiers
  9 + (agent_credential) · `tsc` 0 · `eslint` 0 · `pnpm audit --audit-level high` clean. CI green on
  every PR (#8/#10).
- Decision points settled: **DP-3** testnet · **DP-4** (T5.3 live partner) dropped · **DP-5** RFC-gate
  P3-hard ✅ · **DP-1** defer T0.4 post-hackathon ✅.

## 3. Open decisions (need owner input — NOT blocking)

- **T0.3 RFC approval** (`docs/rfc/2026-06-24-symmetric-dispute-bond.md`): approve symmetric dispute
  bonds / owner-arbiter v1, or answer OQ-1..OQ-4 (disputeBondBps default, forfeited-bond sink,
  ARBITER_VETO_DELAY in v1?, REP_SLASH_STEP magnitude). Approval unblocks T0.4 (deferred post-hackathon).

## 4. Next steps (priority order)

1. **#6 — T4.4 ERC-K draft** (cross-chain reputation portability EIP). DP-6 says do this **after**
   hackathon submission — low priority now.
2. **P3 backlog** (schedule per signal / post-hackathon):
   - **T0.4** symmetric dispute-bond impl (Solidity v5 + Odra) — gated on T0.3 RFC approval.
   - **T0.5** native on-chain reputation decay (lifts PD-005 monotonic-up; co-delivers with T0.4).
   - **T1.2** JobCommitmentProof circuit (cheap after T1.1; enables private jobs).
   - **T2.1 Pharos/Solidity port** of skill composition (currently Odra/in-process only).
   - **T2.2** subscription rail · **T2.3** skill versioning · **T2.4** streaming payments.
   - **T3.1** vector embeddings · **T3.2** collaborative filtering · **T3.3** marketplace telemetry.
   - **Full T1.4** zk-TLS (signed-TLS fallback already shipped).
3. **Pay down pattern-debt `dup-inprocess-odra-model`**: `demo_casper_e2e.ts` has an inline
   `OdraStateMachine`; the canonical `src/lib/casper/odra_registry.ts` `OdraRegistry` supersedes it —
   refactor the demo to import it next time `demo_casper_e2e` is touched.
4. **Live runs (owner-driven, sandbox can't):** `run_autonomous_loop.ts --live` (testnet Stellar creds),
   `make repagg` (real Groth16 artefacts for the cross-chain demo's real proof path), Casper/Soroban
   live deploys.

## 5. Gotchas / environment notes for next session

- **Odra needs `cargo +nightly`** (odra-macros 2.8.1 `box_patterns`). `cargo +nightly test --manifest-path contracts-odra/Cargo.toml`.
- **`pnpm install` after any dep change** — branch-5 added `snarkjs`+`circomlibjs`; a stale node_modules
  fails ~14 vitest files with "Cannot find module @stellar/stellar-sdk / casper-js-sdk / @x402/stellar"
  (deps are in the lockfile, just not installed). Not a code defect.
- **CI Audit gate:** `pnpm audit --audit-level high`. `snarkjs` pulls a HIGH-vuln `underscore@1.13.6`;
  pinned via `pnpm.overrides` `"underscore@<=1.13.7": "^1.13.8"`. Re-check on any ZK dep bump.
- **Demos run offline** by design (`demo_cross_chain`, `demo_self_hosting`, `demo_autonomous_loop`,
  `run_autonomous_loop --dry-run`). The ZK demos fall back to a labelled mock proof when `make repagg`
  artefacts are absent (no circom on this box).
- **`hex-line` PreToolUse/PostToolUse hook** nags to use `mcp__hex-line__*` tools that are NOT in this
  environment, and filters bash output ("RTK FILTERED"). Ignore the suggestions; use standard
  Read/Edit/Bash. For long bash output, write to a file and `Read` it to dodge the output filter.
- **DPS KB** (`mcp__dps-superskills__*`): decisions/pattern-debt logged this session —
  `t21-js-tool-inprocess-odra-backend`, `dup-inprocess-odra-model`, `p3-hard-symmetric-dispute-bond-rfc`,
  `t13-rep-oracle-js-prover-existing-consumer`. Query with `kb_query`.

## 6. Evidence anchors

- Branch (deleted, in main): `feat/t21-composition-mcp` (4d4a0c0/6b4a4cf/f7240b4/c0c311d) → PR #8.
- `docs/t03-p3hard-rfc` (b44a62e) → PR #9. `feat/t13-rep-oracle` (b49144b) → PR #10.
- ADRs: `2026-06-24-t21-composition-mcp-surface.md`, `2026-06-25-t13-reputation-oracle.md`.
