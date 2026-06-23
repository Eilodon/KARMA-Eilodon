// Odra's `#[odra::module]` macro emits `#[cfg(odra_module)]` blocks (its WASM-vs-test gate).
// The cfg name isn't known to rustc, so the lint fires once per attribute — silenced here at
// the crate root rather than per-call site.
#![allow(unexpected_cfgs)]

//! KARMA Odra port — Casper Agentic Buildathon T9.
//!
//! Mirrors the Solidity `AgentSkillRegistry` (v4) 1-to-1 on its public surface:
//! skill lifecycle, escrow + pull-payment jobs, identity / reputation gates, and the
//! Tier-2 Sybil-resistance bond. See [`agent_skill_registry`] for the contract.
//!
//! The port preserves three invariants from the Solidity audit:
//!   * **CEI** in every fund-state mutator (effects before [`transfer_tokens`]).
//!   * **Pull-payment ledger** — providers/refundees credit a balance, then withdraw.
//!   * **Self-deal nullification** — escrow always settles, but trust signals (skill rep,
//!     totalInvocations, agent rep) do NOT count when `requester == provider`.
//!
//! Casper-specific deltas vs Solidity:
//!   * `U512` (CSPR) replaces `uint256 wei`.
//!   * Block time is in **milliseconds** (Casper convention), so every duration constant
//!     is expressed in ms — verified against the Solidity boundary tests (1h / 3d / 30d).
//!   * Reputation-bump arithmetic is saturating: `100` is a hard ceiling that matches
//!     `MAX_REPUTATION` on the Solidity side.

pub mod agent_skill_registry;
