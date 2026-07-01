import { parseEventLogs, type Account, type Address, type Hash } from "viem";
import { keystoreManager } from "./keystore.js";
import { agentSkillRegistryAbi } from "./abi.js";
import {
  deriveTaskHash,
  getContractAddress,
  getPublicClient,
  writeContractBounded,
  type WriteOutcome,
} from "./contract.js";
import { skillIndex, type SkillSearchHit, type SkillSearchOptions } from "./bm25_index.js";
import type { SkillDocument } from "./types.js";

/**
 * KarmaService — the network/keystore/index boundary the tools depend on.
 *
 * Tools (karma.tool.ts) are pure orchestration over this interface, so they unit-test against
 * a fake. realKarmaService wires the live Pharos clients, keystore, and BM25 index; its methods
 * are exercised end-to-end by the P7 demo. Writes return a WriteOutcome (confirmed|pending);
 * on `pending`, ids are null (no receipt to decode) and the caller surfaces a pending status.
 */

export interface OnchainSkill {
  owner: Address;
  name: string;
  description: string;
  mcpEndpoint: string;
  pricePerCall: bigint;
  reputationScore: bigint;
  totalInvocations: bigint;
  active: boolean;
  registeredAt: bigint;
  minReputationToInvoke: bigint; // Trust Gate threshold (v2, on-chain)
  identityPolicy: number; // Identity Gate policy (P0): 0 none · 1 T3N · 2 T3N-fresh · ≥3 unknown(fail-closed)
}

export interface OnchainJob {
  requester: Address;
  provider: Address;
  skillId: bigint;
  taskHash: Hash;
  escrowAmount: bigint;
  deadline: bigint;
  status: number;
  resultHash: Hash;
  createdAt: bigint;
  completedAt: bigint;
  evaluator: Address;
  evaluatorFee: bigint;
}

export interface KarmaService {
  /** Resolve the signing account for an agent, asserting the calling tenant owns it (STRIDE-S). */
  account(agentId: string, tenantId: string): Account;
  /** Resolve an agent's address, asserting the calling tenant owns it (STRIDE-S). */
  addressOf(agentId: string, tenantId: string): Address;
  registerSkill(
    account: Account,
    p: { name: string; description: string; mcpEndpoint: string; pricePerCall: bigint; minReputationToInvoke: bigint; identityPolicy: number },
  ): Promise<{ skillId: bigint | null; outcome: WriteOutcome }>;
  readSkill(skillId: bigint): Promise<OnchainSkill>;
  readJob(jobId: bigint): Promise<OnchainJob>;
  deriveTaskHash(requester: Address, skillId: bigint, nonce: bigint): Hash;
  findExistingJob(requester: Address, taskHash: Hash): Promise<bigint | null>;
  createJob(
    account: Account,
    p: { skillId: bigint; taskHash: Hash; deadlineSecs: bigint; value: bigint },
  ): Promise<{ jobId: bigint | null; outcome: WriteOutcome }>;
  /** Create a job with a neutral third-party evaluator (P0-A). */
  createJobWithEvaluator(
    account: Account,
    p: { skillId: bigint; taskHash: Hash; deadlineSecs: bigint; evaluator: Address; evaluatorFee: bigint; value: bigint },
  ): Promise<{ jobId: bigint | null; outcome: WriteOutcome }>;
  deliverResult(account: Account, p: { jobId: bigint; resultHash: Hash }): Promise<WriteOutcome>;
  confirmCompletion(account: Account, p: { jobId: bigint }): Promise<WriteOutcome>;
  /** P1-A: Requester disputes a delivered result within the review window — bond-backed. */
  disputeResult(account: Account, p: { jobId: bigint; value: bigint }): Promise<WriteOutcome>;
  /** Provider claims payment after the review window if the requester ghosted (v2). */
  claimAfterReview(account: Account, p: { jobId: bigint }): Promise<WriteOutcome>;
  /** P1-A: Provider matches the dispute bond to contest. */
  respondToDispute(account: Account, p: { jobId: bigint; value: bigint }): Promise<WriteOutcome>;
  /** P1-A: Provider concedes the dispute. */
  concedeDispute(account: Account, p: { jobId: bigint }): Promise<WriteOutcome>;
  /** P1-A: Anyone triggers default concede after RESPONSE_WINDOW. */
  resolveDefaultConcede(account: Account, p: { jobId: bigint }): Promise<WriteOutcome>;
  /** P1-A: Arbiter adjudicates a contested dispute. verdict: 0=ProviderAtFault, 1=RequesterAtFault. */
  arbitrate(account: Account, p: { jobId: bigint; verdict: number }): Promise<WriteOutcome>;
  /** P1-A: Owner sets the dispute bond basis points. */
  setDisputeBondBps(account: Account, p: { bps: bigint }): Promise<WriteOutcome>;
  /** P1-A: Owner sets the arbiter address. */
  setArbiter(account: Account, p: { newArbiter: Address }): Promise<WriteOutcome>;
  /** P1-A: Read dispute info for a job. */
  getDisputeInfo(jobId: bigint): Promise<{ disputeBond: bigint; providerBond: bigint; disputedAt: bigint }>;
  /** P1-A: Read the current dispute bond bps. */
  getDisputeBondBps(): Promise<bigint>;
  /** P1-A: Read the arbiter address. */
  getArbiter(): Promise<Address>;
  /** Evaluator approves or rejects a delivered result (P0-A). */
  evaluateResult(account: Account, p: { jobId: bigint; approved: boolean }): Promise<WriteOutcome>;
  /** Read the evaluator address and fee for a job (P0-A). */
  getJobEvaluator(jobId: bigint): Promise<{ evaluator: Address; evaluatorFee: bigint }>;
  /** Owner adjusts a skill's on-chain Trust Gate threshold (v2). */
  setMinReputation(account: Account, p: { skillId: bigint; minReputation: number }): Promise<WriteOutcome>;
  /** Owner sets a skill's on-chain Identity Gate policy (P0). Declarative; server-enforced. */
  setIdentityPolicy(account: Account, p: { skillId: bigint; policy: number }): Promise<WriteOutcome>;
  /** On-chain earned agent reputation (lazy base-50). Authoritative source for the Trust Gate (v2). */
  getAgentReputation(addr: Address): Promise<number>;
  getAgentSkills(addr: Address): Promise<readonly bigint[]>;
  getProviderJobs(addr: Address): Promise<readonly bigint[]>;
  getRequesterJobs(addr: Address): Promise<readonly bigint[]>;
  /** Withdrawable balance (released escrow awaiting pull-payment), in wei. */
  getPendingWithdrawal(addr: Address): Promise<bigint>;
  /** Pull the full withdrawable balance. amount is decoded from the Withdrawn event (null if pending). */
  withdraw(account: Account): Promise<{ amount: bigint | null; outcome: WriteOutcome }>;
  indexUpsert(doc: SkillDocument): void;
  /** Remove a skill from the discovery index (e.g. on SkillDeactivated). */
  indexDiscard(skillId: number): void;
  /** Update a skill's Trust Gate threshold in-place — no RPC, survives restart via MinReputationSet replay. */
  indexSetMinReputation(skillId: number, threshold: number): void;
  search(query: string, opts: SkillSearchOptions): SkillSearchHit[];
  /** First indexed skill doc for an owner (reputation source, 0 RPC), or null. */
  getByOwner(addr: Address): SkillDocument | null;
  /** Trust Gate (Phase 1): threshold declared for a skill, 0 = no gate. Index-derived (0 RPC). */
  getSkillThreshold(skillId: bigint): number;
  /** Trust Gate (Phase 1): an address's requester reputation (max owned-skill rep, else 0). 0 RPC. */
  getReputation(addr: Address): number;
  /** P0-B: cross-chain reputation score for an agent, 0 if none set. */
  getCrossChainRep(addr: Address): Promise<bigint>;
  /** P0-B: current registry owner (Ownable2Step). */
  getOwner(): Promise<Address>;
  /** P0-B: pending owner (Ownable2Step two-step transfer). */
  getPendingOwner(): Promise<Address>;
}

function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  // viem infers a literal functionName + tuple args; this dynamic dispatch needs the cast.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return getPublicClient().readContract({
    address: getContractAddress(),
    abi: agentSkillRegistryAbi,
    functionName,
    args,
  } as never) as Promise<T>;
}

/** Decode a uint256 arg from the first matching event in a confirmed receipt; null if pending. */
function extractId(outcome: WriteOutcome, eventName: string, argName: string): bigint | null {
  if (outcome.status !== "confirmed") return null;
  const logs = parseEventLogs({
    abi: agentSkillRegistryAbi,
    eventName: eventName as never,
    logs: outcome.receipt.logs,
  });
  const first = logs[0] as { args?: Record<string, unknown> } | undefined;
  const id = first?.args?.[argName];
  return typeof id === "bigint" ? id : null;
}

export const realKarmaService: KarmaService = {
  account: (agentId, tenantId) => {
    keystoreManager.assertOwnedBy(agentId, tenantId);
    return keystoreManager.getAccount(agentId);
  },
  addressOf: (agentId, tenantId) => {
    keystoreManager.assertOwnedBy(agentId, tenantId);
    return keystoreManager.getAddress(agentId);
  },

  async registerSkill(account, p) {
    const outcome = await writeContractBounded(account, {
      functionName: "registerSkill",
      args: [p.name, p.description, p.mcpEndpoint, p.pricePerCall, p.minReputationToInvoke, p.identityPolicy],
    });
    return { skillId: extractId(outcome, "SkillRegistered", "skillId"), outcome };
  },

  async readSkill(skillId) {
    const t = await read<readonly unknown[]>("skills", [skillId]);
    return {
      owner: t[0] as Address,
      name: t[1] as string,
      description: t[2] as string,
      mcpEndpoint: t[3] as string,
      pricePerCall: t[4] as bigint,
      reputationScore: t[5] as bigint,
      totalInvocations: t[6] as bigint,
      active: t[7] as boolean,
      registeredAt: t[8] as bigint,
      minReputationToInvoke: t[9] as bigint,
      identityPolicy: Number(t[10]),
    };
  },

  async readJob(jobId) {
    const t = await read<readonly unknown[]>("jobs", [jobId]);
    return {
      requester: t[0] as Address,
      provider: t[1] as Address,
      skillId: t[2] as bigint,
      taskHash: t[3] as Hash,
      escrowAmount: t[4] as bigint,
      deadline: t[5] as bigint,
      status: Number(t[6]),
      resultHash: t[7] as Hash,
      createdAt: t[8] as bigint,
      completedAt: t[9] as bigint,
      evaluator: t[10] as Address,
      evaluatorFee: t[11] as bigint,
    };
  },

  deriveTaskHash,
  // PD-003 closed: O(1) on-chain lookup (taskHash already binds the requester; 0 = no existing job).
  findExistingJob: async (_requester, taskHash) => {
    const id = await read<bigint>("jobByTaskHash", [taskHash]);
    return id === 0n ? null : id;
  },

  async createJob(account, p) {
    const outcome = await writeContractBounded(account, {
      functionName: "createJob",
      args: [p.skillId, p.taskHash, p.deadlineSecs],
      value: p.value,
    });
    return { jobId: extractId(outcome, "JobCreated", "jobId"), outcome };
  },

  async createJobWithEvaluator(account, p) {
    const outcome = await writeContractBounded(account, {
      functionName: "createJobWithEvaluator",
      args: [p.skillId, p.taskHash, p.deadlineSecs, p.evaluator, p.evaluatorFee],
      value: p.value,
    });
    return { jobId: extractId(outcome, "JobCreated", "jobId"), outcome };
  },

  deliverResult: (account, p) =>
    writeContractBounded(account, { functionName: "deliverResult", args: [p.jobId, p.resultHash] }),

  confirmCompletion: (account, p) =>
    writeContractBounded(account, { functionName: "confirmCompletion", args: [p.jobId] }),

  disputeResult: (account, p) =>
    writeContractBounded(account, { functionName: "disputeResult", args: [p.jobId], value: p.value }),

  claimAfterReview: (account, p) =>
    writeContractBounded(account, { functionName: "claimAfterReview", args: [p.jobId] }),

  respondToDispute: (account, p) =>
    writeContractBounded(account, { functionName: "respondToDispute", args: [p.jobId], value: p.value }),

  concedeDispute: (account, p) =>
    writeContractBounded(account, { functionName: "concedeDispute", args: [p.jobId] }),

  resolveDefaultConcede: (account, p) =>
    writeContractBounded(account, { functionName: "resolveDefaultConcede", args: [p.jobId] }),

  arbitrate: (account, p) =>
    writeContractBounded(account, { functionName: "arbitrate", args: [p.jobId, p.verdict] }),

  setDisputeBondBps: (account, p) =>
    writeContractBounded(account, { functionName: "setDisputeBondBps", args: [p.bps] }),

  setArbiter: (account, p) =>
    writeContractBounded(account, { functionName: "setArbiter", args: [p.newArbiter] }),

  async getDisputeInfo(jobId) {
    const t = await read<readonly [bigint, bigint, bigint]>("disputes", [jobId]);
    return { disputeBond: t[0], providerBond: t[1], disputedAt: t[2] };
  },

  getDisputeBondBps: () => read("disputeBondBps", []),
  getArbiter: () => read("arbiter", []),

  evaluateResult: (account, p) =>
    writeContractBounded(account, { functionName: "evaluateResult", args: [p.jobId, p.approved] }),

  async getJobEvaluator(jobId) {
    const t = await read<readonly [Address, bigint]>("getJobEvaluator", [jobId]);
    return { evaluator: t[0], evaluatorFee: t[1] };
  },

  setMinReputation: (account, p) =>
    writeContractBounded(account, { functionName: "setMinReputation", args: [p.skillId, BigInt(p.minReputation)] }),

  setIdentityPolicy: (account, p) =>
    writeContractBounded(account, { functionName: "setIdentityPolicy", args: [p.skillId, p.policy] }),

  async getAgentReputation(addr) {
    return Number(await read<bigint>("agentReputation", [addr]));
  },

  getAgentSkills: (addr) => read("getAgentSkills", [addr]),
  getProviderJobs: (addr) => read("getProviderJobs", [addr]),
  getRequesterJobs: (addr) => read("getRequesterJobs", [addr]),
  getPendingWithdrawal: (addr) => read("pendingWithdrawals", [addr]),

  async withdraw(account) {
    const outcome = await writeContractBounded(account, { functionName: "withdraw", args: [] });
    return { amount: extractId(outcome, "Withdrawn", "amount"), outcome };
  },

  indexUpsert: (doc) => skillIndex.upsert(doc),
  indexDiscard: (skillId) => skillIndex.discard(skillId),
  indexSetMinReputation: (skillId, threshold) => skillIndex.setMinReputation(skillId, threshold),
  search: (query, opts) => skillIndex.search(query, opts),
  getByOwner: (addr) => skillIndex.getByOwner(addr),
  getSkillThreshold: (skillId) => skillIndex.getThreshold(Number(skillId)),
  getReputation: (addr) => skillIndex.getReputation(addr),
  getCrossChainRep: (addr) => read("crossChainRep", [addr]),
  getOwner: () => read("owner", []),
  getPendingOwner: () => read("pendingOwner", []),
};
