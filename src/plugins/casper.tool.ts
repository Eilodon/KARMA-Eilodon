import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { keystoreManager } from "../lib/keystore.js";
import { casperAccountHash } from "../lib/casper/keypair.js";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import { casperSkillIndex, getCasperIndexerHealth } from "../lib/casper_indexer_runtime.js";

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
  | "claimAfterReview"
  | "withdraw"
  | "pendingWithdrawalsOf"
  | "agentReputationOf"
  | "bondedOf"
  | "registerComposition"
  | "getComposition"
  | "createJobWithEvaluator"
  | "evaluateResult"
  | "disputeResult"
  | "respondToDispute"
  | "concedeDispute"
  | "resolveDefaultConcede"
  | "arbitrate"
  | "getCrossChainRep"
  | "proposeSetCrossChainRep"
  | "proposeSetArbiter"
  | "proposeSetDisputeBondBps"
  | "approveProposal"
  | "executeProposal"
  | "cancelProposal"
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
      const indexer = getCasperIndexerHealth();
      return reply(`[KARMA] Casper: configured=${configured}` + (configured ? ` contract=${contractHash}` : ""), {
        configured,
        rpcUrl: rpcUrl ?? null,
        contractHash: contractHash ?? null,
        chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
        indexer,
      });
    },
  };

  const casperDiscoverSkills: ToolDefinition = {
    name: "casper_discover_skills",
    description:
      "Search Casper's discovery index by free text, ranked by relevance and reputation " +
      "(same BM25 engine as Pharos's discover_skills, backed by a SEPARATE index — Casper skill " +
      "ids are chain-local, not merged with Pharos's). Populated by the Casper event indexer " +
      "(casper_indexer_runtime.ts); empty until it has backfilled at least once.",
    inputSchema: {
      query: z.string(),
      maxPriceMotes: MOTES.optional(),
      minReputation: z.number().int().min(0).max(100).optional(),
      limit: z.number().int().positive().max(50).optional(),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: { ...readAnnotations, openWorldHint: false },
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        query: z.string(),
        maxPriceMotes: MOTES.optional(),
        minReputation: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }).parse(args);
      const skills = casperSkillIndex.search(a.query, {
        maxPriceWei: a.maxPriceMotes != null ? BigInt(a.maxPriceMotes) : undefined,
        minReputation: a.minReputation,
        limit: a.limit,
      });
      return reply(`[KARMA] casper_discover_skills found ${skills.length} match(es)`, { count: skills.length, skills });
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

  const casperClaimAfterReview: ToolDefinition = {
    name: "casper_claim_after_review",
    description:
      "Anti-deadlock path: the provider claims escrow once the review window has elapsed with " +
      "no casper_confirm_completion or casper_dispute_result from the requester. Reverts " +
      "ReviewWindowOpen while the window is still open, NotProvider for anyone else.",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
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
      const { txHash } = await client.claimAfterReview(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_claim_after_review broadcast; tx=${txHash}`, { txHash });
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

  const casperRegisterComposition: ToolDefinition = {
    name: "casper_register_composition",
    description:
      "Register a composite skill on the Odra registry: a wrapper that fans one job's escrow " +
      "out across 1-8 existing leaf skills by a basis-points weight vector (Σ = 10000). A real " +
      "signed transaction — the wrapper is stored as a normal skill (same id space) plus a " +
      "Composition record. On-chain checks reject a mismatched weight length/sum, an inactive or " +
      "already-composite leaf, or more than 8 leaves. Returns the composite's skill id.",
    inputSchema: {
      agentId: z.string().describe("Keystore agent id that owns/signs this composite skill."),
      name: z.string().min(1),
      description: z.string().default(""),
      mcpEndpoint: z.string().default(""),
      pricePerCallMotes: MOTES.describe("Price per call in CSPR motes, as a base-10 string."),
      minReputationToInvoke: z.number().int().min(0).max(100).default(0),
      identityPolicy: z.number().int().min(0).max(255).default(0),
      leafSkillIds: z.array(z.string().regex(/^[0-9]+$/)).min(1).max(8)
        .describe("Existing, active, non-composite skill ids (u64 strings) this composite pays out to."),
      weightsBps: z.array(z.number().int().min(0).max(10_000)).min(1).max(8)
        .describe("Basis-points weights, same length/order as leafSkillIds; must sum to exactly 10000."),
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
        leafSkillIds: z.array(z.string().regex(/^[0-9]+$/)).min(1).max(8),
        weightsBps: z.array(z.number().int().min(0).max(10_000)).min(1).max(8),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.registerComposition(signer, {
        name: a.name,
        description: a.description,
        mcpEndpoint: a.mcpEndpoint,
        pricePerCallMotes: BigInt(a.pricePerCallMotes),
        minReputationToInvoke: a.minReputationToInvoke,
        identityPolicy: a.identityPolicy,
        leafSkillIds: a.leafSkillIds.map((id) => BigInt(id)),
        weightsBps: a.weightsBps,
      });
      return reply(`[KARMA] casper_register_composition broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetComposition: ToolDefinition = {
    name: "casper_get_composition",
    description:
      "Read a skill's composition manifest directly from the Odra registry's 'state' dictionary " +
      "— leaf skill ids + basis-points weights, or isComposite=false if the id is a primitive " +
      "skill (no Composition record).",
    inputSchema: { skillId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: readAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ skillId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const client = makeClient(env);
      const composition = await client.getComposition(BigInt(a.skillId));
      if (!composition) {
        return reply(`[KARMA] skill ${a.skillId} is a primitive skill (no composition record)`, {
          skillId: a.skillId,
          isComposite: false,
          composition: null,
        });
      }
      return reply(
        `[KARMA] skill ${a.skillId} is composite: ${composition.leafSkillIds.length} leaves`,
        {
          skillId: a.skillId,
          isComposite: true,
          composition: {
            leafSkillIds: composition.leafSkillIds.map(String),
            weightsBps: composition.weightsBps,
          },
        },
      );
    },
  };

  const casperCreateJobWithEvaluator: ToolDefinition = {
    name: "casper_create_job_with_evaluator",
    description:
      "Create a job with a neutral third-party evaluator (P0-A) instead of the requester " +
      "reviewing directly — a real payable transaction. escrowMotes must equal exactly the " +
      "skill's price_per_call + evaluatorFeeMotes; the evaluator fee releases to the evaluator " +
      "once they call casper_evaluate_result, regardless of verdict.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id — signs and pays the escrow + evaluator fee."),
      skillId: z.string().regex(/^[0-9]+$/),
      taskHashHex: HEX32,
      deadlineSecs: z.string().regex(/^[0-9]+$/),
      evaluatorAccountHash: z.string().describe("The evaluator's 'account-hash-<hex>' — must differ from the requester."),
      evaluatorFeeMotes: MOTES,
      escrowMotes: MOTES.describe("Must equal exactly price_per_call + evaluatorFeeMotes."),
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
        evaluatorAccountHash: z.string(),
        evaluatorFeeMotes: MOTES,
        escrowMotes: MOTES,
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.createJobWithEvaluator(signer, {
        skillId: BigInt(a.skillId),
        taskHashHex: a.taskHashHex,
        deadlineSecs: BigInt(a.deadlineSecs),
        evaluatorAccountHash: a.evaluatorAccountHash,
        evaluatorFeeMotes: BigInt(a.evaluatorFeeMotes),
        escrowMotes: BigInt(a.escrowMotes),
      });
      return reply(`[KARMA] casper_create_job_with_evaluator broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperEvaluateResult: ToolDefinition = {
    name: "casper_evaluate_result",
    description:
      "The job's designated evaluator approves or rejects a delivered result within the review " +
      "window. Approve settles like confirm_completion; reject settles like a dispute loss for " +
      "the provider. The evaluator's fee releases either way.",
    inputSchema: {
      agentId: z.string().describe("Evaluator's keystore agent id — must match the job's designated evaluator."),
      jobId: z.string().regex(/^[0-9]+$/),
      approved: z.boolean(),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), approved: z.boolean() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.evaluateResult(signer, BigInt(a.jobId), a.approved);
      return reply(`[KARMA] casper_evaluate_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperDisputeResult: ToolDefinition = {
    name: "casper_dispute_result",
    description:
      "P1-A: requester contests a delivered result within the review window by posting a bond " +
      "(basis points of escrow, per casper_get_account_state's dispute-bond-bps view, floored at " +
      "the contract's MIN_DISPUTE_BOND_MOTES) — a real payable transaction. bondMotes must equal " +
      "the required amount exactly or the call reverts with WrongDisputeBond.",
    inputSchema: {
      agentId: z.string().describe("Requester's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      bondMotes: MOTES.describe("Must equal the exact required dispute bond, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), bondMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.disputeResult(signer, BigInt(a.jobId), BigInt(a.bondMotes));
      return reply(`[KARMA] casper_dispute_result broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperRespondToDispute: ToolDefinition = {
    name: "casper_respond_to_dispute",
    description:
      "P1-A: provider matches the requester's dispute bond exactly to contest (enter " +
      "arbitration), within RESPONSE_WINDOW of the dispute — a real payable transaction. If the " +
      "provider never responds, anyone can call casper_resolve_default_concede instead.",
    inputSchema: {
      agentId: z.string().describe("Provider's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      bondMotes: MOTES.describe("Must equal the requester's posted dispute bond exactly, in motes."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), jobId: z.string().regex(/^[0-9]+$/), bondMotes: MOTES }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.respondToDispute(signer, BigInt(a.jobId), BigInt(a.bondMotes));
      return reply(`[KARMA] casper_respond_to_dispute broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperConcedeDispute: ToolDefinition = {
    name: "casper_concede_dispute",
    description: "Provider concedes a dispute — forfeits both bonds + escrow to the requester, and freezes reputation (no rep bump/slash).",
    inputSchema: { agentId: z.string().describe("Provider's keystore agent id."), jobId: z.string().regex(/^[0-9]+$/) },
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
      const { txHash } = await client.concedeDispute(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_concede_dispute broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperResolveDefaultConcede: ToolDefinition = {
    name: "casper_resolve_default_concede",
    description:
      "Anyone may call this once the provider's RESPONSE_WINDOW elapses with no " +
      "casper_respond_to_dispute call — resolves identically to the provider conceding.",
    inputSchema: { jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string().describe("Any keystore agent id — this call has no access-control beyond the elapsed window.") },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ jobId: z.string().regex(/^[0-9]+$/), callerAgentId: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.callerAgentId);
      const client = makeClient(env);
      const { txHash } = await client.resolveDefaultConcede(signer, BigInt(a.jobId));
      return reply(`[KARMA] casper_resolve_default_concede broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperArbitrate: ToolDefinition = {
    name: "casper_arbitrate",
    description:
      "Arbiter-only: adjudicates a contested dispute (both sides bonded via " +
      "casper_dispute_result + casper_respond_to_dispute) — loser pays both bonds + escrow to " +
      "the winner. Reverts NotArbiter if the caller isn't the contract's current arbiter.",
    inputSchema: {
      agentId: z.string().describe("Arbiter's keystore agent id."),
      jobId: z.string().regex(/^[0-9]+$/),
      verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
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
        verdict: z.enum(["ProviderAtFault", "RequesterAtFault"]),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.arbitrate(signer, BigInt(a.jobId), a.verdict);
      return reply(`[KARMA] casper_arbitrate broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperGetCrossChainRep: ToolDefinition = {
    name: "casper_get_cross_chain_rep",
    description:
      "Read an agent's cross-chain reputation attestation (0-100, or 0 if never set) directly " +
      "from the Odra registry's 'state' dictionary — the P0.1 bridge value set through the " +
      "propose/approve/execute governance lifecycle below.",
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
      if (!a.agentId && !a.accountHash) throw new Error("[KARMA] casper_get_cross_chain_rep needs agentId or accountHash");
      const env = requireCasperEnv();
      const accountHash = a.accountHash ?? casperAccountHash(requireSigner(a.agentId!));
      const client = makeClient(env);
      const score = await client.getCrossChainRep(accountHash);
      return reply(`[KARMA] ${accountHash}: cross_chain_rep=${score}/100`, { accountHash, score });
    },
  };

  const casperProposeSetCrossChainRep: ToolDefinition = {
    name: "casper_propose_set_cross_chain_rep",
    description:
      "P0-B: propose a cross-chain reputation attestation for an agent (e.g. bridged from a " +
      "Stellar ZK credential or a Pharos history). Governance-signer only; the proposer's own " +
      "approval counts automatically. Takes effect only after casper_approve_proposal reaches " +
      "the configured threshold AND casper_execute_proposal is called once the timelock elapses " +
      "— no single-signer immediate-effect path.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      targetAccountHash: z.string().describe("The 'account-hash-<hex>' of the agent being attested."),
      score: z.number().int().min(0).max(100),
      sourceChain: z.string().describe("Free-form origin label, e.g. 'stellar' or 'pharos'."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({
        agentId: z.string(),
        targetAccountHash: z.string(),
        score: z.number().int().min(0).max(100),
        sourceChain: z.string(),
      }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetCrossChainRep(signer, a.targetAccountHash, a.score, a.sourceChain);
      return reply(`[KARMA] casper_propose_set_cross_chain_rep broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetArbiter: ToolDefinition = {
    name: "casper_propose_set_arbiter",
    description:
      "P0-B: propose a new arbiter address. Governance-signer only; same propose/approve/execute " +
      "+ timelock lifecycle as casper_propose_set_cross_chain_rep — no single-signer bypass.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      newArbiterAccountHash: z.string().describe("The 'account-hash-<hex>' of the proposed new arbiter."),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), newArbiterAccountHash: z.string() }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetArbiter(signer, a.newArbiterAccountHash);
      return reply(`[KARMA] casper_propose_set_arbiter broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperProposeSetDisputeBondBps: ToolDefinition = {
    name: "casper_propose_set_dispute_bond_bps",
    description:
      "P0-B: propose a new dispute-bond basis-points value (10000 = 1x escrow). Governance-signer " +
      "only; same propose/approve/execute + timelock lifecycle as the other propose_* tools.",
    inputSchema: {
      agentId: z.string().describe("A governance-signer's keystore agent id."),
      bps: z.number().int().min(0),
    },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), bps: z.number().int().min(0) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.proposeSetDisputeBondBps(signer, a.bps);
      return reply(`[KARMA] casper_propose_set_dispute_bond_bps broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperApproveProposal: ToolDefinition = {
    name: "casper_approve_proposal",
    description: "Approve a pending governance proposal. Governance-signer only; each signer may approve once.",
    inputSchema: { agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.approveProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_approve_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperExecuteProposal: ToolDefinition = {
    name: "casper_execute_proposal",
    description:
      "Execute a governance proposal once the approval threshold is met AND the timelock delay " +
      "has elapsed since it was created. Anyone may call this — the gating is entirely on-chain.",
    inputSchema: { agentId: z.string().describe("Any keystore agent id — pays gas, no access-control beyond threshold+timelock."), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.executeProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_execute_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  const casperCancelProposal: ToolDefinition = {
    name: "casper_cancel_proposal",
    description: "Cancel a pending (not yet executed) governance proposal. Governance-signer only.",
    inputSchema: { agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) },
    capabilities: ["network"],
    allowedPhases: [...PHASES],
    annotations: writeAnnotations,
    execution: { taskSupport: "forbidden" },
    handler: async (args) => {
      assertInProcess();
      const a = z.object({ agentId: z.string(), proposalId: z.string().regex(/^[0-9]+$/) }).parse(args);
      const env = requireCasperEnv();
      const signer = requireSigner(a.agentId);
      const client = makeClient(env);
      const { txHash } = await client.cancelProposal(signer, BigInt(a.proposalId));
      return reply(`[KARMA] casper_cancel_proposal broadcast; tx=${txHash}`, { txHash });
    },
  };

  return [
    casperHealth,
    casperRegisterSkill,
    casperDepositBond,
    casperCreateJob,
    casperDeliverResult,
    casperConfirmCompletion,
    casperClaimAfterReview,
    casperWithdraw,
    casperGetAccountState,
    casperDiscoverSkills,
    casperRegisterComposition,
    casperGetComposition,
    casperCreateJobWithEvaluator,
    casperEvaluateResult,
    casperDisputeResult,
    casperRespondToDispute,
    casperConcedeDispute,
    casperResolveDefaultConcede,
    casperArbitrate,
    casperGetCrossChainRep,
    casperProposeSetCrossChainRep,
    casperProposeSetArbiter,
    casperProposeSetDisputeBondBps,
    casperApproveProposal,
    casperExecuteProposal,
    casperCancelProposal,
  ];
}

const tools: ToolDefinition[] = createCasperTools();
export default tools;
