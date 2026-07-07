import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { keystoreManager } from "../lib/keystore.js";
import { casperAccountHash } from "../lib/casper/keypair.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";

/**
 * Casper skill-registry plugin (T13-live) — makes the Odra `AgentSkillRegistry` reachable
 * through KARMA's MCP tool surface, the same way `karma.tool.ts` exposes Pharos. Before this,
 * every Casper on-chain action (register_skill, create_job, …) only existed as a standalone
 * script (`register_rwa_oracle_skill.ts`, `demo_casper_e2e.ts`) — invisible to an MCP-connected
 * agent, and a poor fit for a project whose whole pitch is "a real, full MCP server". These
 * tools wrap `CasperLiveClient` 1:1 so any MCP client can drive the RWA-oracle flow directly.
 *
 * MUST run in-process, same reasoning as karma.tool.ts / t3.tool.ts: relies on the in-process
 * keystore singleton and CASPER_* env vars, neither of which survive the external child-process
 * plugin worker.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] casper.tool.ts must run in the trusted in-process runtime, not the external worker. " +
        "Add it to isTrustedBuiltInPlugin() and MCP_PLUGIN_ALLOWLIST, and keep MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;
const HEX32 = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 32 bytes as 64 hex chars");
const MOTES = z.string().regex(/^[0-9]+$/, "expected a base-10 motes string");

function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

/** CASPER_RPC_URL / CASPER_CONTRACT_HASH follow the same direct-process.env convention as
 *  `odra_registry.ts` and `register_rwa_oracle_skill.ts` (not the central `ENV` module — Casper
 *  wiring is opt-in and off by default, unlike Pharos's always-validated env block). */
function requireCasperEnv(): { rpcUrl: string; contractHash: string; chainName: string } {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  if (!rpcUrl || !contractHash) {
    throw new Error(
      "[KARMA] Casper not configured — set CASPER_RPC_URL and KARMA_ODRA_REGISTRY (the deployed " +
        "contract package hash) to enable these tools. See DEMO_CASPER.md §Live run.",
    );
  }
  return { rpcUrl, contractHash, chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test" };
}

function requireSigner(agentId: string) {
  if (!keystoreManager.has(agentId)) {
    throw new Error(`[KARMA] Agent '${agentId}' not found in keystore. Run setup:keystore first.`);
  }
  return keystoreManager.getCasperKeypair(agentId);
}

/** The exact `CasperLiveClient` surface these tools call — narrowed to a type so tests can
 *  inject a fake without a real RPC endpoint, mirroring `createKarmaTools(svc: KarmaService)`. */
export type CasperClientLike = Pick<
  CasperLiveClient,
  | "registerSkill"
  | "depositBond"
  | "createJob"
  | "deliverResult"
  | "confirmCompletion"
  | "withdraw"
  | "pendingWithdrawalsOf"
  | "agentReputationOf"
  | "bondedOf"
>;

export function createCasperTools(
  makeClient: (env: { rpcUrl: string; contractHash: string; chainName: string }) => CasperClientLike = (env) =>
    new CasperLiveClient(env),
): ToolDefinition[] {
  const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  const casperHealth: ToolDefinition = {
    name: "casper_health",
    description:
      "Report whether the Casper Odra AgentSkillRegistry rail is configured (CASPER_RPC_URL + " +
      "KARMA_ODRA_REGISTRY). Run first — the other casper_* tools throw a clear error otherwise.",
    inputSchema: {},
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async () => {
      assertInProcess();
      const rpcUrl = process.env.CASPER_RPC_URL;
      const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
      const configured = Boolean(rpcUrl && contractHash);
      return reply(`[KARMA] Casper: configured=${configured}` + (configured ? ` contract=${contractHash}` : ""), {
        configured,
        rpcUrl: rpcUrl ?? null,
        contractHash: contractHash ?? null,
        chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
      });
    },
  };

  const casperRegisterSkill: ToolDefinition = {
    name: "casper_register_skill",
    description:
      "Register a skill on Casper's Odra AgentSkillRegistry — a real signed casper-js-sdk " +
      "transaction, not a simulation. Mirrors the Solidity/Pharos register_skill, with the RWA-" +
      "oracle's identityPolicy gate. Returns the real transaction hash once broadcast.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs this skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallMotes: MOTES.describe("Price per call in CSPR motes (9 decimals), as a base-10 string."),
      minReputationToInvoke: z.number().int().min(0).max(100).default(0),
      identityPolicy: z.number().int().min(0).max(255).default(0)
        .describe("0 = open, 1 = require a verified did:t3n, 2 = require a FRESH did:t3n."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        name: z.string().min(1),
        description: z.string().default(""),
        mcpEndpoint: z.string().default(""),
        pricePerCallMotes: MOTES,
        minReputationToInvoke: z.number().int().min(0).max(100).default(0),
        identityPolicy: z.number().int().min(0).max(255).default(0),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.registerSkill(signer, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCallMotes: BigInt(a.pricePerCallMotes),
        minReputationToInvoke: a.minReputationToInvoke,
        identityPolicy: a.identityPolicy,
      });
      return reply(`[KARMA] casper_register_skill broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDepositBond: ToolDefinition = {
    name: "casper_deposit_bond",
    description:
      "Deposit a Tier-2 Sybil-resistance bond (PD-007) for the given agent on the Odra registry " +
      "— a real payable casper-js-sdk transaction. Required before a provider's reputation seeds " +
      "into flow_reputation's off-chain trust graph.",
    inputSchema: {
      agentId: z.string(),
      amountMotes: MOTES.describe("Bond amount in CSPR motes, as a base-10 string."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), amountMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.depositBond(signer, BigInt(a.amountMotes));
      return reply(`[KARMA] casper_deposit_bond broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCreateJob: ToolDefinition = {
    name: "casper_create_job",
    description:
      "Create a job against a skill on the Odra registry, escrowing CSPR in the same payable " +
      "transaction (create_job's `amount` arg must equal the skill's price_per_call). Pair with " +
      "an x402 envelope (x402_casper.ts) for the fast-lane payment-intent leg off-chain.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id — signs and pays the escrow."),
      skillId: z.string().regex(/^[0-9]+$/).describe("Skill id (u64) from casper_register_skill."),
      taskHashHex: HEX32.describe("32-byte task hash (hex, no 0x prefix) binding this job to its off-chain parameters."),
      deadlineSecs: z.string().regex(/^[0-9]+$/).describe("Review-window deadline, seconds from now."),
      escrowMotes: MOTES.describe("Must equal the skill's price_per_call, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        skillId: z.string().regex(/^[0-9]+$/),
        taskHashHex: HEX32,
        deadlineSecs: z.string().regex(/^[0-9]+$/),
        escrowMotes: MOTES,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.createJob(signer, {
        skillId: BigInt(a.skillId),
        taskHashHex: a.taskHashHex,
        deadlineSecs: BigInt(a.deadlineSecs),
        escrowMotes: BigInt(a.escrowMotes),
      });
      return reply(`[KARMA] casper_create_job broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDeliverResult: ToolDefinition = {
    name: "casper_deliver_result",
    description: "Provider records a result hash for a job, opening the review window (deliver_result).",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      resultHashHex: HEX32,
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        jobId: z.string().regex(/^[0-9]+$/),
        resultHashHex: HEX32,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.deliverResult(signer, { jobId: BigInt(a.jobId), resultHashHex: a.resultHashHex });
      return reply(`[KARMA] casper_deliver_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperConfirmCompletion: ToolDefinition = {
    name: "casper_confirm_completion",
    description: "Requester confirms a delivered job — releases escrow to the provider's pull-payment ledger and bumps reputation (arm's-length only).",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.confirmCompletion(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_confirm_completion broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperWithdraw: ToolDefinition = {
    name: "casper_withdraw",
    description: "Pull the caller's full released-escrow balance from the Odra registry's pull-payment ledger (CEI — zeroed on-chain before transfer).",
    inputSchema: { agentId: z.string() },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.withdraw(signer);
      return reply(`[KARMA] casper_withdraw broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetAccountState: ToolDefinition = {
    name: "casper_get_account_state",
    description:
      "Read an agent's on-chain state on the Odra registry directly from the 'state' dictionary " +
      "(pending withdrawable balance, reputation 0-100, bonded Sybil-resistance amount) — a real " +
      "global-state query, not a cached/off-chain estimate.",
    inputSchema: {
      agentId: z.string().optional().describe("Keystore agent id — resolves its Casper account hash. Provide this OR accountHash."),
      accountHash: z.string().optional().describe("Raw 'account-hash-...' string, for reading an agent not in this keystore."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string().optional(), accountHash: z.string().optional() }).parse(args);
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_account_state needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const [pendingWithdrawalsMotes, reputation, bondedMotes] = await Promise.all([
        client.pendingWithdrawalsOf(accountHash),
        client.agentReputationOf(accountHash),
        client.bondedOf(accountHash),
      ]);
      return reply(
        `[KARMA] ${accountHash}: pending=${pendingWithdrawalsMotes} motes rep=${reputation}/100 bonded=${bondedMotes} motes`,
        { accountHash, pendingWithdrawalsMotes, reputation, bondedMotes },
      );
    },
  };

  return [
    casperHealth,
    casperRegisterSkill,
    casperDepositBond,
    casperCreateJob,
    casperDeliverResult,
    casperConfirmCompletion,
    casperWithdraw,
    casperGetAccountState,
  ];
}

const tools: ToolDefinition[] = createCasperTools();
export default tools;
