import { describe, it, expect, beforeEach } from "vitest";
import {
  OdraRegistry,
  CompositionError,
  BASE_REPUTATION,
  REPUTATION_STEP,
  MAX_COMPOSITION_LEAVES,
  WEIGHT_DENOMINATOR,
} from "../lib/casper/odra_registry.js";
import { buildCompositionTools, type McpTool } from "../lib/casper/composition_tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// T2.1 (Option B) — in-process Odra model mirrors contracts-odra/src/agent_skill_registry.rs
// (45/45 Rust tests). These TS tests assert the same invariants at the JS/MCP layer so the
// Casper composition primitive is invocable + discoverable via the MCP-shaped tool surface.
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA = "alpha";
const BETA = "beta";
const GAMMA = "gamma";
const OMEGA = "omega"; // wrapper owner
const REQ = "requester";
const COMPOSITE_PRICE = 3_000_000n;

function leaf(reg: OdraRegistry, owner: string, label: string, price = 100_000n): number {
  return reg.register_skill(owner, { name: `leaf-${label}`, price });
}

describe("OdraRegistry — composition registration + views", () => {
  let reg: OdraRegistry;
  beforeEach(() => {
    reg = new OdraRegistry();
  });

  it("persists the manifest + underlying skill and distinguishes composite from primitive", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    const composite = reg.register_composition(
      OMEGA,
      { name: "compose-ab", price: COMPOSITE_PRICE },
      [a, b],
      [6_000, 4_000],
    );
    expect(reg.is_composite(composite)).toBe(true);
    expect(reg.is_composite(a)).toBe(false);
    expect(reg.get_composition(composite)).toEqual({ leafSkillIds: [a, b], weightsBps: [6_000, 4_000] });
    // get_composition is Option-like (null) for a primitive — mirrors branch-5's Option<Composition>.
    expect(reg.get_composition(a)).toBeNull();
    const wrapper = reg.get_skill(composite);
    expect(wrapper.owner).toBe(OMEGA);
    expect(wrapper.price).toBe(COMPOSITE_PRICE);
  });

  it("rejects empty leaves", () => {
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, [], []))
      .toThrow(new CompositionError("EmptyComposition"));
  });

  it("rejects more than MAX_COMPOSITION_LEAVES (count guard fires before sum check)", () => {
    const ids = Array.from({ length: MAX_COMPOSITION_LEAVES + 1 }, (_v, i) => leaf(reg, ALPHA, `m${i}`));
    const weights = ids.map(() => Math.floor(WEIGHT_DENOMINATOR / ids.length));
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, ids, weights))
      .toThrow(new CompositionError("TooManyLeaves"));
  });

  it("rejects weight-length mismatch", () => {
    const a = leaf(reg, ALPHA, "a");
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, [a], [5_000, 5_000]))
      .toThrow(new CompositionError("WeightsMismatch"));
  });

  it("rejects weights not summing to the denominator", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, [a, b], [3_000, 3_000]))
      .toThrow(new CompositionError("WeightsMismatch"));
  });

  it("rejects an unknown leaf", () => {
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, [4242], [10_000]))
      .toThrow(new CompositionError("LeafSkillNotFound"));
  });

  it("rejects an inactive leaf", () => {
    const a = leaf(reg, ALPHA, "a");
    reg.deactivate_skill(a, ALPHA);
    expect(() => reg.register_composition(OMEGA, { name: "c", price: 1n }, [a], [10_000]))
      .toThrow(new CompositionError("LeafSkillInactive"));
  });

  it("rejects a composite leaf (single-level only)", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    const composite = reg.register_composition(OMEGA, { name: "c", price: COMPOSITE_PRICE }, [a, b], [5_000, 5_000]);
    expect(() => reg.register_composition(GAMMA, { name: "c2", price: 1n }, [composite], [10_000]))
      .toThrow(new CompositionError("LeafIsComposite"));
  });
});

describe("OdraRegistry — composite settlement", () => {
  let reg: OdraRegistry;
  beforeEach(() => {
    reg = new OdraRegistry();
  });

  it("splits escrow per weights (last leaf absorbs remainder) and propagates reputation", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    const c = leaf(reg, GAMMA, "c");
    const composite = reg.register_composition(
      OMEGA, { name: "abc", price: COMPOSITE_PRICE }, [a, b, c], [5_000, 3_000, 2_000],
    );
    const job = reg.create_job(composite, REQ, "task", COMPOSITE_PRICE);
    reg.deliver_result(job, OMEGA, "result");
    reg.confirm_completion(job, REQ);

    expect(reg.pending_withdrawals_of(ALPHA)).toBe((COMPOSITE_PRICE * 5_000n) / 10_000n);
    expect(reg.pending_withdrawals_of(BETA)).toBe((COMPOSITE_PRICE * 3_000n) / 10_000n);
    expect(reg.pending_withdrawals_of(GAMMA)).toBe((COMPOSITE_PRICE * 2_000n) / 10_000n);
    expect(reg.pending_withdrawals_of(OMEGA)).toBe(0n); // wrapper has no implicit slice
    // Σ payouts == escrow (no dust lost).
    const total = reg.pending_withdrawals_of(ALPHA) + reg.pending_withdrawals_of(BETA) + reg.pending_withdrawals_of(GAMMA);
    expect(total).toBe(COMPOSITE_PRICE);
    // Reputation: composite + each leaf bumped; each agent + requester bumped.
    expect(reg.get_skill(composite).rep).toBe(BASE_REPUTATION + REPUTATION_STEP);
    expect(reg.get_skill(a).rep).toBe(BASE_REPUTATION + REPUTATION_STEP);
    expect(reg.agent_reputation(ALPHA)).toBe(BASE_REPUTATION + REPUTATION_STEP);
    expect(reg.agent_reputation(REQ)).toBe(BASE_REPUTATION + REPUTATION_STEP);
  });

  it("last leaf absorbs the rounding remainder so no mote is lost", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    const c = leaf(reg, GAMMA, "c");
    const composite = reg.register_composition(OMEGA, { name: "dusty", price: 1_000n }, [a, b, c], [3_333, 3_333, 3_334]);
    const job = reg.create_job(composite, REQ, "t", 1_000n);
    reg.deliver_result(job, OMEGA, "r");
    reg.confirm_completion(job, REQ);
    expect(reg.pending_withdrawals_of(ALPHA)).toBe(333n);
    expect(reg.pending_withdrawals_of(BETA)).toBe(333n);
    expect(reg.pending_withdrawals_of(GAMMA)).toBe(334n); // remainder
    expect(reg.pending_withdrawals_of(ALPHA) + reg.pending_withdrawals_of(BETA) + reg.pending_withdrawals_of(GAMMA)).toBe(1_000n);
  });

  it("self-deal leaf owner is paid but earns no reputation; arm's-length leaf + composite do", () => {
    const a = leaf(reg, REQ, "self"); // requester owns leaf A
    const b = leaf(reg, BETA, "arms");
    const composite = reg.register_composition(OMEGA, { name: "sd", price: COMPOSITE_PRICE }, [a, b], [6_000, 4_000]);
    const job = reg.create_job(composite, REQ, "t", COMPOSITE_PRICE);
    reg.deliver_result(job, OMEGA, "r");
    reg.confirm_completion(job, REQ);

    expect(reg.pending_withdrawals_of(REQ)).toBe((COMPOSITE_PRICE * 6_000n) / 10_000n); // still paid
    expect(reg.pending_withdrawals_of(BETA)).toBe((COMPOSITE_PRICE * 4_000n) / 10_000n);
    expect(reg.get_skill(a).rep).toBe(BASE_REPUTATION); // self-deal: leaf A frozen
    expect(reg.get_skill(b).rep).toBe(BASE_REPUTATION + REPUTATION_STEP);
    expect(reg.get_skill(composite).rep).toBe(BASE_REPUTATION + REPUTATION_STEP);
    expect(reg.agent_reputation(REQ)).toBe(BASE_REPUTATION + REPUTATION_STEP); // one composite-layer bump
    expect(reg.agent_reputation(BETA)).toBe(BASE_REPUTATION + REPUTATION_STEP);
  });

  it("dispute refunds the full escrow to the requester with no splits and no reputation change", () => {
    const a = leaf(reg, ALPHA, "a");
    const b = leaf(reg, BETA, "b");
    const composite = reg.register_composition(OMEGA, { name: "d", price: COMPOSITE_PRICE }, [a, b], [5_000, 5_000]);
    const job = reg.create_job(composite, REQ, "t", COMPOSITE_PRICE);
    reg.deliver_result(job, OMEGA, "bad");
    reg.dispute_result(job, REQ);

    expect(reg.pending_withdrawals_of(REQ)).toBe(COMPOSITE_PRICE);
    expect(reg.pending_withdrawals_of(ALPHA)).toBe(0n);
    expect(reg.pending_withdrawals_of(BETA)).toBe(0n);
    expect(reg.get_skill(composite).rep).toBe(BASE_REPUTATION);
    expect(reg.get_skill(a).rep).toBe(BASE_REPUTATION);
  });
});

describe("OdraRegistry — pull-payment + Tier-2 bond parity (agent_skill_registry.rs:589-624)", () => {
  let reg: OdraRegistry;
  beforeEach(() => {
    reg = new OdraRegistry();
  });

  it("withdraw drains the pending ledger and zeroes it (CEI)", () => {
    const a = leaf(reg, ALPHA, "a");
    const job = reg.create_job(a, REQ, "t", 100_000n);
    reg.deliver_result(job, ALPHA, "r");
    reg.confirm_completion(job, REQ);
    expect(reg.pending_withdrawals_of(ALPHA)).toBe(100_000n);
    expect(reg.withdraw(ALPHA)).toBe(100_000n);
    expect(reg.pending_withdrawals_of(ALPHA)).toBe(0n);
  });

  it("withdraw on an empty ledger throws NothingToWithdraw (matches Error::NothingToWithdraw)", () => {
    expect(() => reg.withdraw(ALPHA)).toThrow(new CompositionError("NothingToWithdraw"));
  });

  it("deposit_bond accumulates the bonded amount per agent", () => {
    reg.deposit_bond(ALPHA, 1_000_000_000n);
    reg.deposit_bond(ALPHA, 500_000_000n);
    reg.deposit_bond(BETA, 250_000_000n);
    expect(reg.bonded_of(ALPHA)).toBe(1_500_000_000n);
    expect(reg.bonded_of(BETA)).toBe(250_000_000n);
    expect(reg.bonded_of(GAMMA)).toBe(0n);
  });

  it("deposit_bond rejects zero / negative attached value (matches Error::NoBond)", () => {
    expect(() => reg.deposit_bond(ALPHA, 0n)).toThrow(new CompositionError("NoBond"));
    expect(() => reg.deposit_bond(ALPHA, -1n)).toThrow(new CompositionError("NoBond"));
  });
});

describe("composition MCP tool surface (discoverable + invocable)", () => {
  let reg: OdraRegistry;
  let tools: McpTool[];
  const byName = (n: string): McpTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} not registered`);
    return t;
  };

  beforeEach(() => {
    reg = new OdraRegistry();
    tools = buildCompositionTools(reg);
  });

  it("exposes register_composition / discover_composites / get_composition", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["discover_composites", "get_composition", "register_composition"],
    );
  });

  it("register_composition tool creates a composite that discover_composites then surfaces", async () => {
    const a = reg.register_skill(ALPHA, { name: "leaf-a", price: 100_000n });
    const b = reg.register_skill(BETA, { name: "leaf-b", price: 100_000n });
    const created = (await byName("register_composition").handler({
      wrapperOwner: OMEGA,
      name: "compose-ab",
      price: "3000000",
      leafSkillIds: [a, b],
      weightsBps: [6_000, 4_000],
    })) as { skillId: number; isComposite: boolean };
    expect(created.isComposite).toBe(true);

    const found = (await byName("discover_composites").handler({})) as Array<{ skillId: number; composition: unknown }>;
    expect(found).toHaveLength(1);
    expect(found[0].skillId).toBe(created.skillId);
    expect(found[0].composition).toEqual({ leafSkillIds: [a, b], weightsBps: [6_000, 4_000] });

    const manifest = (await byName("get_composition").handler({ skillId: created.skillId })) as {
      leafSkillIds: number[];
    };
    expect(manifest.leafSkillIds).toEqual([a, b]);
  });

  it("register_composition tool surfaces validation errors structurally", async () => {
    await expect(
      byName("register_composition").handler({
        wrapperOwner: OMEGA, name: "bad", price: "1", leafSkillIds: [], weightsBps: [],
      }),
    ).rejects.toThrow(/EmptyComposition/);
  });
});
