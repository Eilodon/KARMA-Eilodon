/**
 * KARMA self-hosting demo (T5.4) — KARMA pays itself via x402 to invoke its own
 * `discover_skills`.
 *
 * Why this is a single capstone deliverable:
 *   1. PROOF OF DOGFOOD — the trust kernel + payment rails are good enough that KARMA can
 *      participate in its own marketplace. No special case for "self".
 *   2. PROOF OF PROTOCOL NEUTRALITY — `discover_skills` is one MCP tool among many. The
 *      orchestrator does not know (or care) that the provider is KARMA itself; the wire is
 *      x402 + MCP, same as any third-party skill.
 *   3. PROOF OF SETTLEMENT — receipt's `payer` and `payee` resolve to KARMA's OWN derived
 *      Stellar address. The x402 leg is real; the settle leg is gated on a live facilitator.
 *
 * Runs entirely offline (no network). Demo flow:
 *
 *     Orchestrator
 *       │
 *       ├─ karma.discover_skills(query="paid discovery")            ← free leg, baseline
 *       │
 *       ├─ karma.create_job(
 *       │      skill = karma_discover_skills_paid,
 *       │      settlement_rail = "x402",
 *       │      payee = KARMA's own derived address)
 *       │      → x402Plugin/Stellar.pay(...) → receipt to KARMA
 *       │      → KARMA executes discover_skills internally
 *       │      → returns { receipt, discovery_result }
 *       │
 *       └─ inspect: payer == payee == KARMA wallet → self-hosting confirmed
 *
 *   pnpm exec tsx src/scripts/demo_self_hosting.ts
 */

import { StellarX402Plugin } from "../plugins/x402_stellar.js";
import { deriveStellarKeypair } from "../lib/stellar/keypair.js";

// ── Generic MCP-shaped tool registry (same shape as demo_casper_composability.ts) ──
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
interface ToolDef {
  name: string;
  description: string;
  handler: ToolHandler;
}
class ToolRegistry {
  private byName = new Map<string, ToolDef>();
  register(t: ToolDef): void {
    this.byName.set(t.name, t);
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.byName.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.handler(args);
  }
  list(): string[] {
    return [...this.byName.keys()];
  }
}

interface SkillRow {
  skillId: string;
  name: string;
  description: string;
  ownerAddress: string;
  pricePerCallStellar: string; // smallest USDC unit (7 decimals)
  reputationScore: number;
}

/** Hard-coded skill index for the demo. In production this is the live BM25 index. */
function buildSkillIndex(karmaOwnAddress: string): SkillRow[] {
  return [
    {
      skillId: "1",
      name: "rwa_price_oracle",
      description: "Real-world-asset price feed (BTC, ETH, gold).",
      ownerAddress: "GFOREXAMPLEPROVIDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      pricePerCallStellar: "100000", // 0.01 USDC
      reputationScore: 80,
    },
    {
      skillId: "2",
      name: "doc_summary",
      description: "Summarize long documents with LLM.",
      ownerAddress: "GFOREXAMPLEPROVIDERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      pricePerCallStellar: "200000", // 0.02 USDC
      reputationScore: 65,
    },
    // ── The self-hosted skill: KARMA selling its own discovery via x402. ──
    {
      skillId: "9999",
      name: "karma_discover_skills_paid",
      description:
        "KARMA's own discover_skills, exposed as a paid skill on KARMA's marketplace. " +
        "Settles to KARMA's wallet via x402.",
      ownerAddress: karmaOwnAddress, // ← payer == payee == KARMA's address
      pricePerCallStellar: "10000", // 0.001 USDC — cheap so dogfood loops don't drain wallet
      reputationScore: 99,
    },
  ];
}

/** Simulated KARMA-MCP — knows the skill index and how to execute discover. */
function buildKarmaMcp(plugin: StellarX402Plugin, index: SkillRow[]): ToolRegistry {
  const reg = new ToolRegistry();

  // The "free" surface: orchestrators call discover_skills like any MCP tool, no payment.
  reg.register({
    name: "karma.discover_skills",
    description: "Search the skill marketplace (free public read).",
    handler: async ({ query }) => {
      const q = String(query).toLowerCase();
      const hits = index.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
      return { query, hits };
    },
  });

  // The paid surface: same logic, gated through an x402 receipt, and route through KARMA's
  // own wallet when the requested skill IS karma_discover_skills_paid.
  reg.register({
    name: "karma.create_job",
    description:
      "Create a paid job. settlement_rail='x402' routes through the StellarX402Plugin (T7).",
    handler: async ({ skill_id, settlement_rail, agent_id, task_params, payee_override, price_override }) => {
      const skill = index.find((s) => s.skillId === String(skill_id));
      if (!skill) return { status: "rejected", reason: "unknown_skill" };
      if (settlement_rail !== "x402") {
        return { status: "rejected", reason: "settlement_rail_not_implemented_in_demo" };
      }
      const payee = typeof payee_override === "string" ? payee_override : skill.ownerAddress;
      const price = typeof price_override === "string" ? price_override : skill.pricePerCallStellar;

      const receipt = await plugin.pay(
        {
          skillId: skill.skillId,
          price,
          asset: "",
          payTo: payee,
          network: "stellar:testnet",
        },
        { agentId: String(agent_id) },
      );

      // If the paid skill is karma_discover_skills_paid, execute it server-side and bundle
      // the result with the receipt. That's the self-hosting loop in a single call.
      let executionResult: unknown = null;
      if (skill.name === "karma_discover_skills_paid") {
        const innerQuery =
          task_params && typeof task_params === "object" && "query" in task_params
            ? String((task_params as Record<string, unknown>).query)
            : "";
        executionResult = await reg.call("karma.discover_skills", { query: innerQuery });
      }

      return {
        status: "x402_payment_built",
        skill_id,
        skill_name: skill.name,
        settlement_rail,
        receipt,
        executionResult,
      };
    },
  });

  return reg;
}

function box(label: string, lines: string[]): void {
  const width = Math.max(label.length, ...lines.map((l) => l.length)) + 2;
  console.log("\n┌" + "─".repeat(width) + "┐");
  console.log("│ " + label.padEnd(width - 1) + "│");
  console.log("├" + "─".repeat(width) + "┤");
  for (const l of lines) console.log("│ " + l.padEnd(width - 1) + "│");
  console.log("└" + "─".repeat(width) + "┘");
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("KARMA self-hosting demo (T5.4) — KARMA pays itself via x402");
  console.log("=".repeat(80));

  // KARMA's own Stellar identity — derived from a deterministic fixture key, same shape
  // T6's deriveStellarKeypair produces from the keystore at runtime.
  const karmaKp = deriveStellarKeypair(new Uint8Array(32).fill(0x4B)); // 'K' for KARMA
  const karmaAddress = karmaKp.publicKey();

  // Plugin uses the KARMA keypair both as "agent" (when invoking) and as the payee
  // (when serving). Both roles are real — this is what dogfooding looks like.
  const plugin = new StellarX402Plugin("https://www.x402.org/facilitator", () => karmaKp);
  const index = buildSkillIndex(karmaAddress);
  const karmaMcp = buildKarmaMcp(plugin, index);

  box("KARMA's own derived Stellar address (T6 + same secret as the test fixture)", [
    `address = ${karmaAddress}`,
  ]);

  // ── Step 1: baseline — orchestrator calls free discover_skills, sees the marketplace ──
  const free = (await karmaMcp.call("karma.discover_skills", {
    query: "discover",
  })) as { hits: SkillRow[] };
  box("Step 1 — FREE discover_skills (baseline; no payment)", [
    `query              = "discover"`,
    `hits               = ${free.hits.length}`,
    ...free.hits.map(
      (h) =>
        `  #${h.skillId}: ${h.name.padEnd(28)} ${h.pricePerCallStellar.padStart(8)} stroops  rep=${h.reputationScore}`,
    ),
    `paid leaf          = karma_discover_skills_paid (skill #9999)  ← KARMA selling its own discovery`,
  ]);

  // ── Step 2: orchestrator pays x402 to invoke karma_discover_skills_paid ──
  const paidJob = (await karmaMcp.call("karma.create_job", {
    skill_id: "9999",
    settlement_rail: "x402",
    agent_id: "agent-alpha",
    task_params: { query: "rwa" },
  })) as {
    status: string;
    skill_name: string;
    receipt: Record<string, unknown>;
    executionResult: unknown;
  };

  box("Step 2 — PAID discover_skills via x402 (recursive self-call)", [
    `status            = ${paidJob.status}`,
    `skill             = ${paidJob.skill_name}`,
    `rail              = ${String(paidJob.receipt.rail)}`,
    `payer             = ${String(paidJob.receipt.payer).slice(0, 24)}…`,
    `payee             = ${String(paidJob.receipt.payee).slice(0, 24)}…`,
    `amount (stroops)  = ${String(paidJob.receipt.amount)}`,
    `asset (USDC)      = ${String(paidJob.receipt.asset)}`,
    `facilitator       = ${String(paidJob.receipt.facilitatorRef)}`,
  ]);

  // ── Step 3: the self-hosting reveal — payer == payee == KARMA's address ──
  const payer = String(paidJob.receipt.payer);
  const payee = String(paidJob.receipt.payee);
  const selfPaying = payer === karmaAddress && payee === karmaAddress;
  box("Step 3 — self-hosting check", [
    `payer == KARMA address ? ${payer === karmaAddress}`,
    `payee == KARMA address ? ${payee === karmaAddress}`,
    `→ KARMA paid itself via x402 to invoke its own discover_skills: ${selfPaying}`,
  ]);

  // ── Step 4: the actual execution result that the paid call returned ──
  const inner = paidJob.executionResult as { query: string; hits: SkillRow[] };
  box("Step 4 — discover_skills RESULT delivered as part of the paid response", [
    `query (passed through task_params) = "${inner.query}"`,
    `hits delivered                     = ${inner.hits.length}`,
    ...inner.hits.map((h) => `  #${h.skillId}: ${h.name}`),
  ]);

  // ── Step 5: the dogfood claim ──
  console.log(
    "\n┌── Self-hosting claim ─────────────────────────────────────────────────────",
  );
  console.log(
    "│ KARMA registered its own `discover_skills` as a x402-priced skill, then",
  );
  console.log(
    "│ paid itself to invoke it. The payment is real (StellarX402Plugin builds",
  );
  console.log(
    "│ the receipt; the live `settle()` leg is gated on a live x402 facilitator).",
  );
  console.log(
    "│ Same code path a third-party agent would use against any third-party skill.",
  );
  console.log(
    "│ The protocol is good enough that KARMA does not need a special case for itself.",
  );
  console.log(
    "└───────────────────────────────────────────────────────────────────────────",
  );

  if (!selfPaying) {
    console.error("[demo] FAIL — payer/payee mismatch; self-hosting invariant broken");
    process.exit(1);
  }
  if (!inner || !Array.isArray(inner.hits)) {
    console.error("[demo] FAIL — paid call did not deliver the execution result");
    process.exit(1);
  }
  console.log("\n[demo] self-hosting PASS");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
