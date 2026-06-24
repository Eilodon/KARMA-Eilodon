/**
 * Live/testnet runner for the autonomous economic loop (T5.1).
 *
 *   pnpm exec tsx src/scripts/run_autonomous_loop.ts [--ticks N] [--budget USD] [--live]
 *
 *   • default (dry-run): deterministic, network-free. Drives the real `tick()` core against the
 *     dry-run adapter, writes the live dashboard JSON + replay ndjson. Fully verifiable offline.
 *   • --live: wires `StellarX402Plugin` for the x402 invoke leg. Requires testnet env (DP-3:
 *     STELLAR_NETWORK=*testnet* + STELLAR_X402_FACILITATOR_URL). Owner-driven — needs funded creds.
 *
 * Safety: per-tx + hourly USDC caps + a dashboard control file (`{ "paused": true }`) that pauses
 * the loop on the next tick. The $-budget is the cap, not the floor (DP-3).
 */

import {
  tick,
  totalEarnings,
  totalSpend,
  netPnl,
  type LoopBudget,
  type LoopState,
  type SkillCandidate,
  type EarningRecord,
} from "../lib/autonomous_loop/loop.js";
import {
  buildDryRunAdapter,
  buildLiveAdapter,
  requireTestnetEnv,
  type LiveInvoke,
  type DashboardSink,
} from "../lib/autonomous_loop/runner.js";
import { StellarX402Plugin } from "../plugins/x402_stellar.js";
import type { PaymentRequest } from "../lib/payment/plugin.js";

const USDC = 10_000_000n; // 1e7 stroops = $1

function flag(name: string): boolean {
  return process.argv.includes(name);
}
function opt(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}
function usd(stroops: bigint): string {
  return `$${(Number(stroops) / 1e7).toFixed(4)}`;
}

// Canned marketplace candidates — in --live these are the discovery seed (live discover_skills
// wiring is a follow-on); the x402 invoke leg is real on testnet.
const CANDIDATES: SkillCandidate[] = [
  { skillId: "rwa_btc_oracle", name: "rwa_btc_oracle", pricePerCallUsdc: 1_000_000n, expectedReturnUsdc: 1_400_000n, reputation: 82, payee: "GORACLEBTC", network: "stellar:testnet" },
  { skillId: "sentiment_feed", name: "sentiment_feed", pricePerCallUsdc: 500_000n, expectedReturnUsdc: 650_000n, reputation: 71, payee: "GSENTIMENT", network: "stellar:testnet" },
  { skillId: "expensive_noop", name: "expensive_noop", pricePerCallUsdc: 9_000_000n, expectedReturnUsdc: 8_000_000n, reputation: 40, payee: "GNOOP", network: "stellar:testnet" },
];

async function main(): Promise<void> {
  const ticks = opt("--ticks", 20);
  const budgetUsd = opt("--budget", 10);
  const live = flag("--live");
  const startingBudget = BigInt(Math.round(budgetUsd)) * USDC;

  const sink: DashboardSink = {
    jsonPath: "dashboard/autonomous_loop.json",
    ndjsonPath: "dashboard/autonomous_loop.ndjson",
    controlPath: "dashboard/control.json",
  };
  const budget: LoopBudget = {
    maxPerTxUsdc: 2_000_000n, // $0.20 per tx
    maxHourlyUsdc: 20_000_000n, // $2.00 / rolling hour
    circuitBreakerPaused: false,
  };

  const adapter = live
    ? buildLiveAdapter(
        { discover: async () => CANDIDATES, invoke: makeLiveInvoke() },
        sink,
        startingBudget,
      )
    : buildDryRunAdapter({ candidates: CANDIDATES, returnBps: 12_000 }, sink, startingBudget);

  console.log("=".repeat(80));
  console.log(`KARMA autonomous economic loop (T5.1) — ${live ? "LIVE (testnet)" : "DRY-RUN"}`);
  console.log(`Budget cap ${usd(startingBudget)} · ticks ${ticks} · per-tx ${usd(budget.maxPerTxUsdc)} · hourly ${usd(budget.maxHourlyUsdc)}`);
  console.log("=".repeat(80));

  const now0 = Date.now();
  let state: LoopState = { startedAt: now0, now: now0, budgetUsdc: startingBudget, spends: [], earnings: [], iterations: 0 };

  for (let i = 0; i < ticks; i++) {
    const now = state.now + 60_000; // 1 simulated minute per tick
    const { action, state: next } = await tick(state, budget, adapter, now, 60_000);
    if (action.kind === "invoke" && action.skill) {
      console.log(`[tick ${String(i + 1).padStart(3)}] INVOKE ${action.skill.name.padEnd(16)} budget=${usd(next.budgetUsdc)} pnl=${usd(netPnl(next, startingBudget))}`);
    } else {
      console.log(`[tick ${String(i + 1).padStart(3)}] noop   ${action.reason}`);
    }
    state = next;
  }

  box("Autonomous loop result", [
    `iterations       = ${state.iterations}`,
    `gross earnings   = ${usd(totalEarnings(state))}`,
    `gross spend      = ${usd(totalSpend(state))}`,
    `net P&L          = ${usd(netPnl(state, startingBudget))}`,
    `ending budget    = ${usd(state.budgetUsdc)}`,
    `dashboard        = ${sink.jsonPath} (+ ${sink.ndjsonPath})`,
  ]);
  console.log(`\n[loop] ${live ? "LIVE" : "DRY-RUN"} complete — net ${netPnl(state, startingBudget) >= 0n ? "PROFIT" : "LOSS"} ${usd(netPnl(state, startingBudget))}`);
}

function makeLiveInvoke(): LiveInvoke {
  const env = requireTestnetEnv(process.env);
  const plugin = new StellarX402Plugin(env.facilitatorUrl);
  const agentId = process.env.KARMA_AGENT_ID ?? "agent-alpha";
  return async (skill, state): Promise<EarningRecord> => {
    const req: PaymentRequest = {
      skillId: skill.skillId,
      price: skill.pricePerCallUsdc.toString(),
      asset: "USDC",
      payTo: skill.payee,
      network: skill.network,
    };
    const receipt = await plugin.pay(req, { agentId });
    // Spend leg is real on testnet; the realized return is the measured/oracle expectation —
    // refine with the agent's downstream sale once the live resale endpoint exists.
    return { at: state.now, amountUsdc: skill.expectedReturnUsdc, source: `x402:${receipt.facilitatorRef ?? "settled"}` };
  };
}

main().catch((e: unknown) => {
  console.error(`[loop] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
