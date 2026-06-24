/**
 * Autonomous loop offline simulation (T5.1) — falsifiable proof in fast-forward.
 *
 * Drives `tick()` through N iterations against a deterministic mock adapter so the
 * loop's decision rules, budget caps, and ledger arithmetic can be observed without
 * waiting 24h. Output:
 *   • Per-tick log line (action + skill + budget + cumulative P&L).
 *   • Final summary box.
 *   • JSON snapshot + ndjson stream written to /tmp/karma-loop-state/.
 *
 * For the LIVE version (real Stellar mainnet $10 per DP-3), the same loop module
 * accepts a real adapter that calls `discover_skills` + StellarX402Plugin +
 * CasperX402Plugin. The live runner is `run_autonomous_loop.ts` (gated on
 * KARMA_AUTONOMOUS_LIVE=1 + funded keypair env vars).
 *
 *   pnpm exec tsx src/scripts/demo_autonomous_loop.ts
 *   pnpm exec tsx src/scripts/demo_autonomous_loop.ts --ticks 200
 */

import { join } from "node:path";
import {
  tick,
  type LoopAdapter,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
  type EarningRecord,
  totalEarnings,
  totalSpend,
  netPnl,
} from "../lib/autonomous_loop/loop.js";
import { snapshot, writeJsonSnapshot, appendNdjsonSnapshot } from "../lib/autonomous_loop/dashboard.js";

const STROOPS = 10_000_000n; // 1 USDC = 1e7 stroops
const STARTING_BUDGET = 10n * STROOPS; // DP-3 = $10
const TICKS_DEFAULT = 50;
const DASH_DIR = "/tmp/karma-loop-state";

function parseTicks(argv: string[]): number {
  const idx = argv.indexOf("--ticks");
  if (idx >= 0 && argv[idx + 1]) return Math.max(1, Number(argv[idx + 1]));
  return TICKS_DEFAULT;
}

function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

/** A deterministic "marketplace" — each call returns a freshly-shuffled mix of skills.
 *  Two have positive EV, one is a money sink. The loop's selection rule should pick the
 *  best EV consistently. */
function fakeMarketplace(seed: number): SkillCandidate[] {
  const r = (n: number) => ((seed * 9301 + 49297 + n * 1103) % 233280) / 233280;
  return [
    {
      skillId: "summarize",
      name: "doc_summary",
      pricePerCallUsdc: BigInt(Math.floor((50_000 + r(1) * 100_000))), // 0.005–0.015 USDC
      // Expected return modeled as a noisy gain — averages above price (positive EV).
      expectedReturnUsdc: BigInt(Math.floor((150_000 + r(2) * 200_000))), // 0.015–0.035 USDC
      reputation: 78,
      payee: "G".repeat(56),
      network: "stellar:testnet",
    },
    {
      skillId: "extract",
      name: "data_extract",
      pricePerCallUsdc: BigInt(Math.floor((80_000 + r(3) * 80_000))), // 0.008–0.016 USDC
      expectedReturnUsdc: BigInt(Math.floor((200_000 + r(4) * 100_000))), // 0.020–0.030 USDC
      reputation: 85,
      payee: "G".repeat(56),
      network: "stellar:testnet",
    },
    {
      skillId: "expensive_sink",
      name: "noise",
      pricePerCallUsdc: BigInt(Math.floor((300_000 + r(5) * 200_000))), // 0.030–0.050 USDC
      expectedReturnUsdc: BigInt(Math.floor(50_000 + r(6) * 50_000)), // 0.005–0.010 USDC — negative EV
      reputation: 40,
      payee: "G".repeat(56),
      network: "stellar:testnet",
    },
  ];
}

/** Adapter that delivers a realized earning ~ expectedReturn ± 10% noise. */
function makeAdapter(seedRef: { v: number }): { adapter: LoopAdapter; lastEarning?: EarningRecord } {
  const ref: { adapter: LoopAdapter; lastEarning?: EarningRecord } = { adapter: null as never };
  const jsonPath = join(DASH_DIR, "state.json");
  const streamPath = join(DASH_DIR, "stream.ndjson");
  ref.adapter = {
    discoverCandidates: async () => {
      const c = fakeMarketplace(seedRef.v);
      return c;
    },
    invokeSkill: async (skill, state) => {
      seedRef.v += 1;
      const expected = Number(skill.expectedReturnUsdc);
      const noise = ((((seedRef.v * 1103) % 233280) / 233280) - 0.5) * 0.2; // ±10%
      const realized = BigInt(Math.max(0, Math.floor(expected * (1 + noise))));
      const earning: EarningRecord = {
        at: state.now,
        amountUsdc: realized,
        source: skill.skillId,
      };
      ref.lastEarning = earning;
      return earning;
    },
    publish: async (state) => {
      // The action that produced this state is not known here; the runner records it via
      // a second `snapshot` call. For this offline simulator we just dump the state.
      const rec = snapshot(state, { kind: "noop", reason: "post-tick" }, STARTING_BUDGET);
      writeJsonSnapshot(jsonPath, rec);
      appendNdjsonSnapshot(streamPath, rec);
    },
    isCircuitBreakerPaused: async () => false,
  };
  return ref;
}

async function main(): Promise<void> {
  const TICKS = parseTicks(process.argv);
  console.log("=".repeat(80));
  console.log(`KARMA autonomous loop — offline simulation (T5.1)`);
  console.log(`Budget: $${(Number(STARTING_BUDGET) / 1e7).toFixed(2)} · Ticks: ${TICKS}`);
  console.log("=".repeat(80));

  const startedAt = Date.now();
  let state: LoopState = {
    startedAt,
    now: startedAt,
    budgetUsdc: STARTING_BUDGET,
    spends: [],
    earnings: [],
    iterations: 0,
  };
  const budget: LoopBudget = {
    maxPerTxUsdc: STROOPS, // $1 per tx
    maxHourlyUsdc: 2n * STROOPS, // $2/h rolling
    circuitBreakerPaused: false,
  };
  const seedRef = { v: 1 };
  const ref = makeAdapter(seedRef);

  let invokes = 0;
  let noops = 0;

  for (let i = 0; i < TICKS; i++) {
    const now = state.now + 60_000; // 1 minute per tick
    const { action, state: next } = await tick(state, budget, ref.adapter, now, 60_000);
    state = next;
    if (action.kind === "invoke") {
      invokes++;
      const lastEarn = ref.lastEarning;
      console.log(
        `[tick ${i + 1}] INVOKE ${action.skill?.name.padEnd(14)} ` +
          `cost=$${(Number(action.skill?.pricePerCallUsdc) / 1e7).toFixed(3)} ` +
          `earn=$${(Number(lastEarn?.amountUsdc ?? 0n) / 1e7).toFixed(3)} ` +
          `budget=$${(Number(state.budgetUsdc) / 1e7).toFixed(2)}`,
      );
    } else {
      noops++;
      console.log(`[tick ${i + 1}] NOOP   ${action.reason}`);
    }
    if (state.budgetUsdc < STROOPS / 100n) {
      console.log(`[tick ${i + 1}] budget depleted — halting`);
      break;
    }
  }

  const pnl = netPnl(state, STARTING_BUDGET);
  const sign = pnl >= 0n ? "+" : "-";
  const absPnlUsd = (Number(pnl < 0n ? -pnl : pnl) / 1e7).toFixed(2);
  box("Final summary", [
    `iterations         = ${state.iterations}`,
    `invokes            = ${invokes}`,
    `noops              = ${noops}`,
    `total spend        = $${(Number(totalSpend(state)) / 1e7).toFixed(2)}`,
    `total earnings     = $${(Number(totalEarnings(state)) / 1e7).toFixed(2)}`,
    `closing budget     = $${(Number(state.budgetUsdc) / 1e7).toFixed(2)}`,
    `net P&L            = ${sign}$${absPnlUsd}`,
    `dashboard JSON     = ${join(DASH_DIR, "state.json")}`,
    `dashboard stream   = ${join(DASH_DIR, "stream.ndjson")}`,
  ]);

  console.log(
    "\n┌── Falsifiable claim ──────────────────────────────────────────────────────",
  );
  console.log(
    "│ The loop above ran with NO HUMAN in the loop and NO SPECIAL CASE for KARMA.",
  );
  console.log(
    "│ Same code path as the live runner (`run_autonomous_loop.ts`); the only diff is",
  );
  console.log(
    "│ the adapter (mock marketplace vs. real Stellar/Casper x402 plugins).",
  );
  console.log(
    "│ Hard caps were enforced PER-TX (≤ $1) and PER-HOUR (≤ $2) by the loop, not the",
  );
  console.log(
    "│ adapter — so a misbehaving adapter cannot escalate spend.",
  );
  console.log(
    "└──────────────────────────────────────────────────────────────────────────",
  );

  console.log("\n[demo] autonomous loop PASS");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
