import { describe, it, expect } from "vitest";
import {
  decide,
  applyInvocation,
  applyNoop,
  rollingSpend,
  tick,
  totalEarnings,
  totalSpend,
  netPnl,
  type LoopAdapter,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
} from "../lib/autonomous_loop/loop.js";

const ONE_USDC = 10_000_000n; // 7-decimal stroops
const START_BUDGET = 10n * ONE_USDC; // $10

function freshState(now: number = 1_700_000_000_000): LoopState {
  return {
    startedAt: now,
    now,
    budgetUsdc: START_BUDGET,
    spends: [],
    earnings: [],
    iterations: 0,
  };
}

function freshBudget(): LoopBudget {
  return {
    maxPerTxUsdc: ONE_USDC, // $1 per tx hard cap
    maxHourlyUsdc: 2n * ONE_USDC, // $2/hour hard cap
    circuitBreakerPaused: false,
  };
}

function cand(
  id: string,
  price: bigint,
  expected: bigint,
  rep: number = 75,
): SkillCandidate {
  return {
    skillId: id,
    name: `skill-${id}`,
    pricePerCallUsdc: price,
    expectedReturnUsdc: expected,
    reputation: rep,
    payee: "G".repeat(56),
    network: "stellar:testnet",
  };
}

describe("decide", () => {
  it("returns noop when circuit breaker is paused", () => {
    const a = decide(freshState(), { ...freshBudget(), circuitBreakerPaused: true }, [
      cand("a", 10n, 100n),
    ]);
    expect(a.kind).toBe("noop");
    expect(a.reason).toBe("circuit_breaker_paused");
  });

  it("returns noop when hourly cap is exhausted", () => {
    const state = freshState();
    state.spends.push({ at: state.now - 1_000, amountUsdc: 2n * ONE_USDC, skillId: "x" });
    const a = decide(state, freshBudget(), [cand("a", ONE_USDC / 10n, ONE_USDC)]);
    expect(a.kind).toBe("noop");
    expect(a.reason).toBe("hourly_cap_exhausted");
  });

  it("rejects candidates priced above maxPerTxUsdc", () => {
    const a = decide(freshState(), freshBudget(), [
      cand("expensive", 2n * ONE_USDC, 10n * ONE_USDC),
    ]);
    expect(a.kind).toBe("noop");
    expect(a.reason).toBe("no_profitable_skill_within_caps");
  });

  it("rejects candidates priced above remaining-hourly cap", () => {
    const state = freshState();
    state.spends.push({ at: state.now - 1_000, amountUsdc: ONE_USDC + ONE_USDC / 2n, skillId: "x" });
    // Only $0.50 of hourly cap remains; a $0.60 skill must be rejected.
    const a = decide(state, freshBudget(), [
      cand("a", (6n * ONE_USDC) / 10n, 5n * ONE_USDC),
    ]);
    expect(a.kind).toBe("noop");
  });

  it("rejects candidates whose expectedReturn does not exceed price", () => {
    const a = decide(freshState(), freshBudget(), [
      cand("flat", ONE_USDC / 10n, ONE_USDC / 10n),
    ]);
    expect(a.kind).toBe("noop");
  });

  it("rejects candidates whose price exceeds budget", () => {
    const state = freshState();
    const budget = freshBudget();
    const a = decide(
      { ...state, budgetUsdc: ONE_USDC / 100n }, // 1 cent
      budget,
      [cand("a", ONE_USDC / 10n, ONE_USDC)],
    );
    expect(a.kind).toBe("noop");
  });

  it("picks the highest expected-profit candidate", () => {
    const a = decide(freshState(), freshBudget(), [
      cand("low_profit", ONE_USDC / 10n, ONE_USDC / 5n), // profit $0.10
      cand("high_profit", ONE_USDC / 10n, 5n * ONE_USDC / 10n), // profit $0.40
      cand("mid_profit", ONE_USDC / 10n, ONE_USDC / 4n), // profit $0.15
    ]);
    expect(a.kind).toBe("invoke");
    expect(a.skill?.skillId).toBe("high_profit");
  });

  it("breaks ties on higher reputation", () => {
    const a = decide(freshState(), freshBudget(), [
      cand("a", ONE_USDC / 10n, ONE_USDC / 5n, 60),
      cand("b", ONE_USDC / 10n, ONE_USDC / 5n, 90),
    ]);
    expect(a.skill?.skillId).toBe("b");
  });

  it("breaks rep ties on lower price (cheaper means more iterations per budget)", () => {
    const a = decide(freshState(), freshBudget(), [
      cand("expensive", 3n * ONE_USDC / 10n, 4n * ONE_USDC / 10n, 75),
      cand("cheaper", 1n * ONE_USDC / 10n, 2n * ONE_USDC / 10n, 75),
    ]);
    // Both have profit $0.10; cheaper wins.
    expect(a.skill?.skillId).toBe("cheaper");
  });
});

describe("rollingSpend", () => {
  it("counts only spends within the window", () => {
    const state = freshState();
    const hour = 3_600_000;
    state.spends.push({ at: state.now - 30 * 60 * 1000, amountUsdc: ONE_USDC, skillId: "a" });
    state.spends.push({ at: state.now - 2 * hour, amountUsdc: ONE_USDC, skillId: "b" });
    expect(rollingSpend(state, hour)).toBe(ONE_USDC); // only the 30-min-old spend
  });
});

describe("applyInvocation / applyNoop / aggregates", () => {
  it("applyInvocation updates budget, ledgers, and iteration count", () => {
    const state = freshState();
    const skill = cand("a", ONE_USDC / 10n, ONE_USDC / 5n);
    const earning = { at: state.now, amountUsdc: ONE_USDC / 5n, source: "a" };
    const next = applyInvocation(state, skill, earning);
    expect(next.budgetUsdc).toBe(state.budgetUsdc - skill.pricePerCallUsdc + earning.amountUsdc);
    expect(next.iterations).toBe(1);
    expect(next.spends).toHaveLength(1);
    expect(next.earnings).toHaveLength(1);
  });

  it("applyNoop only bumps now + iteration count", () => {
    const state = freshState();
    const next = applyNoop(state, state.now + 1000);
    expect(next.now).toBe(state.now + 1000);
    expect(next.iterations).toBe(1);
    expect(next.budgetUsdc).toBe(state.budgetUsdc);
  });

  it("totalEarnings / totalSpend / netPnl reflect ledger sums", () => {
    let state = freshState();
    const startBudget = state.budgetUsdc;
    state = applyInvocation(
      state,
      cand("a", ONE_USDC / 10n, ONE_USDC),
      { at: state.now, amountUsdc: ONE_USDC, source: "a" },
    );
    expect(totalSpend(state)).toBe(ONE_USDC / 10n);
    expect(totalEarnings(state)).toBe(ONE_USDC);
    expect(netPnl(state, startBudget)).toBe(ONE_USDC - ONE_USDC / 10n);
  });
});

describe("tick", () => {
  function makeAdapter(
    candidates: SkillCandidate[],
    invoke: (s: SkillCandidate) => bigint,
    paused: boolean = false,
  ): { adapter: LoopAdapter; published: LoopState[] } {
    const published: LoopState[] = [];
    return {
      published,
      adapter: {
        discoverCandidates: async () => candidates,
        invokeSkill: async (s) => ({ at: Date.now(), amountUsdc: invoke(s), source: s.skillId }),
        publish: async (s) => {
          published.push(s);
        },
        isCircuitBreakerPaused: async () => paused,
      },
    };
  }

  it("happy iteration: discover → decide → invoke → publish", async () => {
    const { adapter, published } = makeAdapter(
      [cand("a", ONE_USDC / 10n, ONE_USDC / 5n)],
      (_s) => ONE_USDC / 5n,
    );
    const state = freshState();
    const { action, state: next } = await tick(state, freshBudget(), adapter, state.now);
    expect(action.kind).toBe("invoke");
    expect(action.skill?.skillId).toBe("a");
    expect(next.iterations).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toBe(next);
  });

  it("paused adapter forces noop even with good candidates", async () => {
    const { adapter } = makeAdapter(
      [cand("a", ONE_USDC / 10n, 10n * ONE_USDC)],
      () => 0n,
      true,
    );
    const state = freshState();
    const { action } = await tick(state, freshBudget(), adapter, state.now);
    expect(action.kind).toBe("noop");
    expect(action.reason).toBe("circuit_breaker_paused");
  });

  it("budget depletion halts the loop after enough losing trades", async () => {
    // Adapter returns earnings of 0 — every invocation loses the price.
    const { adapter } = makeAdapter(
      [cand("loss", ONE_USDC / 10n, ONE_USDC / 2n)], // claims profit but adapter returns nothing
      () => 0n,
    );
    let state = freshState();
    const budget = freshBudget();
    // Cap iterations at 200 — far more than budget would allow ($10 budget / $0.10 = 100 trades).
    for (let i = 0; i < 200; i++) {
      const now = state.now + (i + 1) * 60_000;
      const { state: next } = await tick(state, budget, adapter, now);
      state = next;
      if (state.budgetUsdc < ONE_USDC / 10n) break;
    }
    expect(state.budgetUsdc < ONE_USDC / 10n).toBe(true);
  });

  it("injected decideFn replaces decide() and its rationale surfaces on the result", async () => {
    const picked = cand("reasoned-pick", ONE_USDC / 10n, ONE_USDC / 5n);
    const { adapter } = makeAdapter([picked], () => ONE_USDC / 5n);
    const state = freshState();
    let calledWith: unknown;
    const decideFn = async (
      tickState: LoopState,
      tickBudget: LoopBudget,
      candidates: readonly SkillCandidate[],
      nextTickMs: number,
    ) => {
      calledWith = { tickState, tickBudget, candidates, nextTickMs };
      return { action: { kind: "invoke" as const, skill: picked, reason: "llm pick" }, rationale: "because reasons" };
    };
    const { action, rationale } = await tick(state, freshBudget(), adapter, state.now, 60_000, decideFn);
    expect(calledWith).toBeDefined();
    expect(action.kind).toBe("invoke");
    expect(action.skill?.skillId).toBe("reasoned-pick");
    expect(rationale).toBe("because reasons");
  });
});
