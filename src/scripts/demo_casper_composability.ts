/**
 * KARMA × Casper composability demo (T12).
 *
 * Proves the synthesis §6 claim — agentic composability is a PROTOCOL property, not a
 * platform feature. An orchestrator that holds tool sets from two independent MCP servers
 * (KARMA-MCP for the trust + discovery layer; Casper-MCP for chain state) reasons across
 * them with ZERO custom integration code — the unifying interface is the MCP tool envelope,
 * not a bespoke adapter.
 *
 * Why this script is offline-runnable:
 *   • Casper-MCP servers (`Tairon-ai/casper-network-mcp`, `msanlisavas/casper-mcp`) live as
 *     external npm packages outside this repo. Installing them per-clone would gate the demo
 *     on the reviewer's network. So we model both servers as IN-PROCESS TOOL REGISTRIES with
 *     the same shape as MCP tools (name, input schema, handler). Swap either registry for a
 *     live MCP client (stdio transport) and the orchestrator code below is bit-identical.
 *   • The KARMA side uses the real `CasperX402Plugin` (T11) for the payment leg — the only
 *     mocked piece on KARMA's side is `discover_skills`'s indexer (Pharos RPC dependency) +
 *     `create_job`'s on-chain escrow path (CSPR-on-Casper would settle via x402 instead).
 *
 *   pnpm exec tsx src/scripts/demo_casper_composability.ts
 */

import { CasperX402Plugin } from "../plugins/x402_casper.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";

// ── Generic MCP-shaped tool registry ──────────────────────────────────────────
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

// ── Casper-MCP mock — same surface as the published Casper MCP servers ───────
// Returns canned-but-realistic data: a 100 CSPR balance + an account-hash for our fixture key.
function buildCasperMcp(agentAccountHash: string): ToolRegistry {
  const reg = new ToolRegistry();
  const CSPR_BALANCE_MOTES = "100000000000"; // 100 CSPR (10^9 motes/CSPR)
  reg.register({
    name: "casper.get_account_balance",
    description: "Returns the agent's CSPR balance in motes.",
    handler: async ({ account_hash }) => ({
      account_hash,
      balance_motes: CSPR_BALANCE_MOTES,
      balance_cspr: "100",
      block_height: 4_123_456,
    }),
  });
  reg.register({
    name: "casper.get_account_info",
    description: "Returns account-hash + main purse uref for an account.",
    handler: async () => ({
      account_hash: agentAccountHash,
      main_purse: "uref-deadbeef-007",
      network: "casper:mainnet",
    }),
  });
  return reg;
}

// ── KARMA-MCP partial — discover_skills/create_job stubbed for orchestrator clarity ──
function buildKarmaMcp(plugin: CasperX402Plugin): ToolRegistry {
  const reg = new ToolRegistry();
  // discover_skills: in production this reads from the BM25 index over chain-mirrored skills.
  // Here we hard-code a single RWA-oracle skill that advertises a Casper x402 payment option,
  // matching what `register_rwa_oracle_skill` produces in T13.
  reg.register({
    name: "karma.discover_skills",
    description: "Returns ranked skill hits + their payment options.",
    handler: async ({ query }) => ({
      query,
      hits: [
        {
          skillId: "42",
          name: "rwa_price_oracle",
          description: "Signed real-world-asset price feed (BTC, ETH, gold).",
          provider: "casper-provider-alpha",
          provider_payee:
            "account-hash-3333333333333333333333333333333333333333333333333333333333333333",
          reputationScore: 75,
          payment_options: [
            { rail: "x402", network: "casper:mainnet", asset: "CSPR" },
            { rail: "escrow", network: "pharos:atlantic", asset: "PHRS" },
          ],
        },
      ],
    }),
  });
  // create_job with settlement_rail="x402" routes through the real T11 plugin to build the
  // signed payment envelope. With settlement_rail="escrow" it would hit Pharos — out of scope.
  reg.register({
    name: "karma.create_job",
    description: "Creates a paid job; for `x402` rails, the IPaymentPlugin builds the receipt.",
    handler: async ({ skill_id, settlement_rail, payee, price, network, asset, agent_id, task_params }) => {
      if (settlement_rail !== "x402") {
        return { status: "rejected", reason: "settlement_rail_not_implemented_in_demo" };
      }
      const receipt = await plugin.pay(
        {
          skillId: String(skill_id),
          price: String(price),
          asset: typeof asset === "string" ? asset : "",
          payTo: String(payee),
          network: String(network),
        },
        { agentId: String(agent_id) },
      );
      return {
        status: "x402_payment_built",
        skill_id,
        settlement_rail,
        receipt,
        task_params,
      };
    },
  });
  return reg;
}

// ── Pretty-printing (mirror T8's box style) ──────────────────────────────────
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
  console.log("KARMA × Casper composability demo (T12)");
  console.log("=".repeat(80));

  // Agent's Casper identity — derived from a deterministic fixture key, same shape T10
  // produces from the keystore at runtime.
  const agentKp = deriveCasperPrivateKey(new Uint8Array(32).fill(0x42));
  const agentAccountHash = casperAccountHash(agentKp);

  // Spin up the two "MCP" tool registries — orchestrator does NOT know whether each is
  // backed by a local handler or a remote stdio client. THAT is the composability claim.
  const plugin = new CasperX402Plugin("https://x402-facilitator.casper.network", () => agentKp);
  const casperMcp = buildCasperMcp(agentAccountHash);
  const karmaMcp = buildKarmaMcp(plugin);

  box("MCP tool sets available to the orchestrator", [
    `casper-mcp: ${casperMcp.list().join(", ")}`,
    `karma-mcp : ${karmaMcp.list().join(", ")}`,
  ]);

  // ── Step 1: Casper-MCP — check the agent's account state on Casper ──
  const account = (await casperMcp.call("casper.get_account_info", {})) as Record<string, unknown>;
  const balance = (await casperMcp.call("casper.get_account_balance", {
    account_hash: account.account_hash,
  })) as Record<string, unknown>;
  box("Step 1 — agent's Casper account (via casper-mcp)", [
    `account_hash  = ${String(account.account_hash).slice(0, 24)}...`,
    `main_purse    = ${String(account.main_purse)}`,
    `balance       = ${String(balance.balance_cspr)} CSPR (${String(balance.balance_motes)} motes)`,
    `block_height  = ${String(balance.block_height)}`,
  ]);

  // ── Step 2: KARMA-MCP — discover RWA-oracle skills + their Casper payment option ──
  const discovery = (await karmaMcp.call("karma.discover_skills", {
    query: "real world asset price oracle",
  })) as { hits: Array<Record<string, unknown>> };
  const skill = discovery.hits[0];
  box("Step 2 — discover_skills (via karma-mcp)", [
    `query              = "real world asset price oracle"`,
    `skill_id           = ${String(skill.skillId)}`,
    `name               = ${String(skill.name)}`,
    `rep                = ${String(skill.reputationScore)}/100`,
    `payment_options[0] = x402 / casper:mainnet / CSPR  ← the composable bridge`,
  ]);

  // ── Step 3: KARMA-MCP create_job with settlement_rail="x402" → T11 plugin ──
  const job = (await karmaMcp.call("karma.create_job", {
    skill_id: skill.skillId,
    settlement_rail: "x402",
    payee: skill.provider_payee,
    price: "0.01",
    network: "casper:mainnet",
    asset: "CSPR",
    agent_id: "agent-alpha",
    task_params: { feed: "BTC/USD" },
  })) as { status: string; receipt: Record<string, unknown> };

  box("Step 3 — create_job routed through x402Plugin/Casper (T11)", [
    `status         = ${job.status}`,
    `rail           = ${String(job.receipt.rail)}`,
    `payer          = ${String(job.receipt.payer).slice(0, 24)}...`,
    `payee          = ${String(job.receipt.payee).slice(0, 24)}...`,
    `amount (motes) = ${String(job.receipt.amount)}`,
    `asset          = ${String(job.receipt.asset)}`,
    `facilitator    = ${String(job.receipt.facilitatorRef)}`,
  ]);

  // ── Step 4: the orchestrator's source code is the entire integration ──
  console.log(
    "\n┌── Composability claim (synthesis §6) ─────────────────────────────────────",
  );
  console.log(
    "│ The above flow's orchestrator code calls `casperMcp.call(...)` and",
  );
  console.log(
    "│ `karmaMcp.call(...)` — generic MCP-shaped invocations, no chain-specific",
  );
  console.log(
    "│ glue. Swap either registry for `new StdioMcpClient(spawn(...))` and the",
  );
  console.log(
    "│ rest is unchanged: Casper-MCP and KARMA-MCP compose because the wire format",
  );
  console.log(
    "│ is the protocol, not a bilateral integration.",
  );
  console.log(
    "└───────────────────────────────────────────────────────────────────────────",
  );

  console.log("\n[demo] composability PASS");
  console.log("[demo] next step: DEMO_CASPER.md for the live MCP-server reproduction.");
}

main().catch((e) => {
  console.error("[demo] FAIL:", e);
  process.exit(1);
});
