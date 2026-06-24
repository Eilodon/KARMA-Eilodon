# ADR 2026-06-24 — T2.1 composition MCP surface targets the in-process Odra model

- **Status:** Accepted
- **Owner:** KARMA maintainer (gokuderafight@gmail.com)
- **Complexity:** C2 (complexity-gate: integration=2, data=0, irreversibility=1, blast=1, ambiguity=2)
- **Supersedes / relates:** roadmap Track T2.1; KB-DECISION-t21-js-tool-inprocess-odra-backend

## Context

The skill-composition primitive (T2.1) is implemented + tested only on the Casper/Odra Rust
contract (`contracts-odra/src/agent_skill_registry.rs`, 45/45 tests). The KARMA-MCP tool layer
(`src/plugins/karma.tool.ts`) is hard-bound to the Pharos/Solidity `KarmaService`, which has **no
composition** (the Solidity port is deliberately deferred — roadmap is "Casper-first, back-port
Pharos after the pattern is proven"). So composition could not be invoked/discovered through MCP.

Three options to expose it (complexity-gate flagged ambiguity=2 → resolve before code):
- **A** — port composition to Solidity + `KarmaService` + `karma.tool.ts`. Rejected: changes an
  audited contract + redeploy under a hackathon deadline; roadmap explicitly defers this.
- **B** — model the Odra registry in-process and expose an MCP-shaped tool surface. **Chosen.**
- **C** — live `casper-js-sdk` client against the deployed Odra contract. Rejected: needs live
  Casper RPC + funded testnet + WASM deploy (owner-driven; sandbox cannot run it).

## Decision

Build composition at the **in-process Odra model** layer:
- `src/lib/casper/odra_registry.ts` — `OdraRegistry`, a faithful JS twin of the Rust contract
  (same validation order, weighted escrow split with last-leaf-absorbs-remainder, self-deal
  reputation carve-out, full-refund dispute).
- `src/lib/casper/composition_tools.ts` — MCP-shaped `{ name, description, handler }` surface:
  `register_composition`, `discover_composites`, `get_composition` (matches the
  `demo_casper_composability` envelope; "drop-in swappable for a live StdioMcpClient").
- `src/__tests__/casper_composition.test.ts` — 15 vitest cases mirroring the Rust invariants.

## Consequences

- ✅ Composition is invocable + discoverable via MCP within the deadline, no audited-contract change.
- ✅ Mirrors the established Casper-demo pattern; the orchestrator code is transport-agnostic.
- ⚠️ **Pattern-debt:** two in-process Odra models now exist (`OdraStateMachine` inline in
  `demo_casper_e2e.ts` + canonical `OdraRegistry`). Consolidate `demo_casper_e2e` onto
  `OdraRegistry` post-hackathon. Logged as KB pattern-debt `dup-inprocess-odra-model`.
- ⬜ Pharos/Solidity composition port + real `karma.tool.ts` wiring remain P3 backlog.

## Measurable trigger to revisit

Revisit when **either** a live Casper RPC path lands (promote to Option C) **or** the Pharos
Solidity composition port is scheduled (promote `karma.tool.ts` to the real backend, Option A).
