/**
 * Casper/Odra `AgentSkillRegistry` client (T2.1, P0.4).
 *
 * Two implementations behind a common `IAgentSkillRegistry` interface:
 *   • `InProcessRegistry` — faithful JS twin of `contracts-odra/src/agent_skill_registry.rs`
 *     (same composition primitive, validation order, weighted escrow split). Used when no live
 *     Casper RPC is available (demos, tests, MCP tool surface via `composition_tools.ts`).
 *   • `RpcRegistry` — thin RPC client against a deployed Odra contract. Activated when
 *     `CASPER_RPC_URL` + `CASPER_CONTRACT_HASH` env vars are set.
 *
 * Factory: `createRegistry()` picks the right implementation based on env.
 */

export const MAX_COMPOSITION_LEAVES = 8;
export const WEIGHT_DENOMINATOR = 10_000;
export const BASE_REPUTATION = 50;
export const REPUTATION_STEP = 5;
export const MAX_REPUTATION = 100;

/** Mirrors the Odra `Error` enum variants used by the composition + lifecycle paths. */
export type CompositionErrorCode =
  | "EmptyComposition"
  | "TooManyLeaves"
  | "WeightsMismatch"
  | "LeafSkillNotFound"
  | "LeafSkillInactive"
  | "LeafIsComposite"
  | "NotComposite"
  | "SkillNotFound"
  | "NotSkillOwner"
  | "EscrowMismatch"
  | "JobNotFound"
  | "NotProvider"
  | "NotRequester"
  | "JobNotOpen"
  | "JobNotDelivered"
  | "NoBond"
  | "NothingToWithdraw";

export class CompositionError extends Error {
  readonly code: CompositionErrorCode;
  constructor(code: CompositionErrorCode) {
    super(code);
    this.name = "CompositionError";
    this.code = code;
  }
}

export interface SkillRow {
  owner: string;
  name: string;
  price: bigint;
  rep: number;
  invocations: number;
  identityPolicy: number;
  active: boolean;
}

export interface Composition {
  leafSkillIds: number[];
  weightsBps: number[];
}

export type JobStatus = "Open" | "Delivered" | "Completed" | "Refunded" | "Disputed";

export interface JobRow {
  requester: string;
  provider: string;
  skillId: number;
  taskHash: string;
  escrow: bigint;
  status: JobStatus;
  resultHash: string | null;
}

export interface NewSkill {
  name: string;
  price: bigint;
  identityPolicy?: number;
}

/** Common interface for both in-process and RPC-backed registries (P0.4). */
export interface IAgentSkillRegistry {
  register_skill(owner: string, s: NewSkill): number | Promise<number>;
  deactivate_skill(skillId: number, caller: string): void | Promise<void>;
  register_composition(wrapperOwner: string, wrapper: NewSkill, leafSkillIds: number[], weightsBps: number[]): number | Promise<number>;
  is_composite(skillId: number): boolean | Promise<boolean>;
  get_composition(skillId: number): Composition | null | Promise<Composition | null>;
  list_composites(): Array<{ skillId: number; composition: Composition }> | Promise<Array<{ skillId: number; composition: Composition }>>;
  get_skill(skillId: number): SkillRow | Promise<SkillRow>;
  create_job(skillId: number, requester: string, taskHash: string, escrow: bigint): number | Promise<number>;
  deliver_result(jobId: number, provider: string, resultHash: string): void | Promise<void>;
  confirm_completion(jobId: number, requester: string): void | Promise<void>;
  dispute_result(jobId: number, requester: string): void | Promise<void>;
  pending_withdrawals_of(agent: string): bigint | Promise<bigint>;
  agent_reputation(agent: string): number | Promise<number>;
  withdraw(agent: string): bigint | Promise<bigint>;
  deposit_bond(agent: string, amount: bigint): void | Promise<void>;
  bonded_of(agent: string): bigint | Promise<bigint>;
  cross_chain_rep(agent: string): number | Promise<number>;
  set_cross_chain_rep(agent: string, score: number, sourceChain: string): void | Promise<void>;
}

export class InProcessRegistry implements IAgentSkillRegistry {
  private readonly skills = new Map<number, SkillRow>();
  private readonly compositions = new Map<number, Composition>();
  private readonly jobs = new Map<number, JobRow>();
  private readonly pendingWithdrawals = new Map<string, bigint>();
  private readonly agentRep = new Map<string, number>();
  // Tier-2 Sybil bond (PD-007). Bond-unlock cooldown is omitted from this JS twin — no
  // current consumer drives `request_bond_unlock` / `withdraw_bond`, so the active-bond view
  // (`bonded_of`) is all the demo / flow_reputation seed path needs.
  private readonly bondedAmount = new Map<string, bigint>();
  private nextSkillId = 0;
  private nextJobId = 0;

  // ── Registration ──────────────────────────────────────────────────────────
  register_skill(owner: string, s: NewSkill): number {
    if (s.name.length === 0) throw new CompositionError("EmptyComposition");
    this.nextSkillId += 1;
    this.skills.set(this.nextSkillId, {
      owner,
      name: s.name,
      price: s.price,
      rep: BASE_REPUTATION,
      invocations: 0,
      identityPolicy: s.identityPolicy ?? 0,
      active: true,
    });
    return this.nextSkillId;
  }

  deactivate_skill(skillId: number, caller: string): void {
    const skill = this.requireSkill(skillId);
    if (skill.owner !== caller) throw new CompositionError("NotSkillOwner");
    skill.active = false;
  }

  /**
   * Validation order mirrors the Rust contract exactly: empty -> too-many -> weights-length ->
   * weights-sum -> per-leaf (not-found / inactive / composite). Only after all guards pass is the
   * underlying wrapper skill created, so a rejected registration leaves no orphan skill.
   */
  register_composition(
    wrapperOwner: string,
    wrapper: NewSkill,
    leafSkillIds: number[],
    weightsBps: number[],
  ): number {
    if (leafSkillIds.length === 0) throw new CompositionError("EmptyComposition");
    if (leafSkillIds.length > MAX_COMPOSITION_LEAVES) throw new CompositionError("TooManyLeaves");
    if (leafSkillIds.length !== weightsBps.length) throw new CompositionError("WeightsMismatch");
    const sum = weightsBps.reduce((acc, w) => acc + w, 0);
    if (sum !== WEIGHT_DENOMINATOR) throw new CompositionError("WeightsMismatch");
    for (const leafId of leafSkillIds) {
      const leaf = this.skills.get(leafId);
      if (!leaf) throw new CompositionError("LeafSkillNotFound");
      if (!leaf.active) throw new CompositionError("LeafSkillInactive");
      if (this.compositions.has(leafId)) throw new CompositionError("LeafIsComposite");
    }
    const compositeId = this.register_skill(wrapperOwner, wrapper);
    this.compositions.set(compositeId, {
      leafSkillIds: [...leafSkillIds],
      weightsBps: [...weightsBps],
    });
    return compositeId;
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  is_composite(skillId: number): boolean {
    return this.compositions.has(skillId);
  }

  /** Option-like: null for a primitive skill — mirrors branch-5's `get_composition -> Option`. */
  get_composition(skillId: number): Composition | null {
    const c = this.compositions.get(skillId);
    return c ? { leafSkillIds: [...c.leafSkillIds], weightsBps: [...c.weightsBps] } : null;
  }

  list_composites(): Array<{ skillId: number; composition: Composition }> {
    return [...this.compositions.entries()].map(([skillId, c]) => ({
      skillId,
      composition: { leafSkillIds: [...c.leafSkillIds], weightsBps: [...c.weightsBps] },
    }));
  }

  get_skill(skillId: number): SkillRow {
    return { ...this.requireSkill(skillId) };
  }

  // ── Job lifecycle ───────────────────────────────────────────────────────────
  create_job(skillId: number, requester: string, taskHash: string, escrow: bigint): number {
    const skill = this.requireSkill(skillId);
    if (escrow !== skill.price) throw new CompositionError("EscrowMismatch");
    this.nextJobId += 1;
    this.jobs.set(this.nextJobId, {
      requester,
      provider: skill.owner,
      skillId,
      taskHash,
      escrow,
      status: "Open",
      resultHash: null,
    });
    return this.nextJobId;
  }

  deliver_result(jobId: number, provider: string, resultHash: string): void {
    const job = this.requireJob(jobId);
    if (job.provider !== provider) throw new CompositionError("NotProvider");
    if (job.status !== "Open") throw new CompositionError("JobNotOpen");
    job.status = "Delivered";
    job.resultHash = resultHash;
  }

  confirm_completion(jobId: number, requester: string): void {
    const job = this.requireJob(jobId);
    if (job.requester !== requester) throw new CompositionError("NotRequester");
    if (job.status !== "Delivered") throw new CompositionError("JobNotDelivered");
    this.settleCompletion(job);
  }

  dispute_result(jobId: number, requester: string): void {
    const job = this.requireJob(jobId);
    if (job.requester !== requester) throw new CompositionError("NotRequester");
    if (job.status !== "Delivered") throw new CompositionError("JobNotDelivered");
    job.status = "Disputed";
    // Full escrow back to the requester — no splits, no reputation change.
    this.credit(job.requester, job.escrow);
  }

  pending_withdrawals_of(agent: string): bigint {
    return this.pendingWithdrawals.get(agent) ?? 0n;
  }

  agent_reputation(agent: string): number {
    return this.agentRep.get(agent) ?? BASE_REPUTATION;
  }

  // ── Pull-payment + Tier-2 bond (mirror of agent_skill_registry.rs:589-624) ─
  /**
   * CEI parity: zero the ledger BEFORE returning the credit, matching the audited Solidity /
   * Odra `withdraw` (`pending_withdrawals.set(caller, 0)` then `transfer_tokens(caller, amount)`).
   * Throws `NothingToWithdraw` to mirror `Error::NothingToWithdraw`.
   */
  withdraw(agent: string): bigint {
    const amount = this.pendingWithdrawals.get(agent) ?? 0n;
    if (amount === 0n) throw new CompositionError("NothingToWithdraw");
    this.pendingWithdrawals.set(agent, 0n);
    return amount;
  }

  /** Mirrors the `#[odra(payable)] deposit_bond` entry-point. Reverts `NoBond` on zero. */
  deposit_bond(agent: string, amount: bigint): void {
    if (amount <= 0n) throw new CompositionError("NoBond");
    this.bondedAmount.set(agent, (this.bondedAmount.get(agent) ?? 0n) + amount);
  }

  bonded_of(agent: string): bigint {
    return this.bondedAmount.get(agent) ?? 0n;
  }

  // ── Cross-chain reputation (P0.1 mirror) ──────────────────────────────────
  private readonly crossChainRep = new Map<string, number>();

  cross_chain_rep(agent: string): number {
    return this.crossChainRep.get(agent) ?? 0;
  }

  set_cross_chain_rep(agent: string, score: number, _sourceChain: string): void {
    if (score > MAX_REPUTATION) throw new CompositionError("EscrowMismatch"); // reuse for "bad threshold"
    this.crossChainRep.set(agent, score);
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private settleCompletion(job: JobRow): void {
    job.status = "Completed";
    const selfDeal = job.requester === job.provider;
    const comp = this.compositions.get(job.skillId);

    if (comp) {
      const escrow = job.escrow;
      let distributed = 0n;
      const n = comp.leafSkillIds.length;
      comp.leafSkillIds.forEach((leafId, i) => {
        const weight = comp.weightsBps[i];
        // Last leaf gets `escrow - distributed` so rounding never leaves dust behind.
        const payout = i + 1 === n
          ? escrow - distributed
          : (escrow * BigInt(weight)) / BigInt(WEIGHT_DENOMINATOR);
        if (i + 1 !== n) distributed += payout;
        const leaf = this.requireSkill(leafId);
        this.credit(leaf.owner, payout);
        if (!selfDeal && job.requester !== leaf.owner) {
          this.bumpSkill(leafId);
          this.bumpAgent(leaf.owner);
        }
      });
      if (!selfDeal) {
        this.bumpSkill(job.skillId);
        this.bumpAgent(job.provider);
        this.bumpAgent(job.requester);
      }
      return;
    }

    // Primitive-skill path.
    this.credit(job.provider, job.escrow);
    if (!selfDeal) {
      this.bumpSkill(job.skillId);
      this.bumpAgent(job.provider);
      this.bumpAgent(job.requester);
    }
  }

  private credit(agent: string, amount: bigint): void {
    this.pendingWithdrawals.set(agent, this.pending_withdrawals_of(agent) + amount);
  }

  private bumpSkill(skillId: number): void {
    const skill = this.requireSkill(skillId);
    skill.invocations += 1;
    skill.rep = Math.min(MAX_REPUTATION, skill.rep + REPUTATION_STEP);
  }

  private bumpAgent(agent: string): void {
    this.agentRep.set(agent, Math.min(MAX_REPUTATION, this.agent_reputation(agent) + REPUTATION_STEP));
  }

  private requireSkill(skillId: number): SkillRow {
    const skill = this.skills.get(skillId);
    if (!skill) throw new CompositionError("SkillNotFound");
    return skill;
  }

  private requireJob(jobId: number): JobRow {
    const job = this.jobs.get(jobId);
    if (!job) throw new CompositionError("JobNotFound");
    return job;
  }
}

/**
 * RPC-backed registry client (P0.4). Delegates to a deployed Odra contract via Casper JSON-RPC.
 * Activated when `CASPER_RPC_URL` + `CASPER_CONTRACT_HASH` are set.
 *
 * Stub: method signatures match `IAgentSkillRegistry` but throw until casper-js-sdk wiring
 * lands (requires the contract to be deployed on testnet first).
 */
export class RpcRegistry implements IAgentSkillRegistry {
  constructor(
    readonly rpcUrl: string,
    readonly contractHash: string,
  ) {}

  private notImplemented(): never {
    throw new Error(
      `RpcRegistry: casper-js-sdk wiring not yet implemented. ` +
      `Using CASPER_RPC_URL=${this.rpcUrl} contract=${this.contractHash}. ` +
      `Unset CASPER_RPC_URL to fall back to InProcessRegistry.`,
    );
  }

  async register_skill(_owner: string, _s: NewSkill): Promise<number> { this.notImplemented(); }
  async deactivate_skill(_skillId: number, _caller: string): Promise<void> { this.notImplemented(); }
  async register_composition(_wrapperOwner: string, _wrapper: NewSkill, _leafSkillIds: number[], _weightsBps: number[]): Promise<number> { this.notImplemented(); }
  async is_composite(_skillId: number): Promise<boolean> { this.notImplemented(); }
  async get_composition(_skillId: number): Promise<Composition | null> { this.notImplemented(); }
  async list_composites(): Promise<Array<{ skillId: number; composition: Composition }>> { this.notImplemented(); }
  async get_skill(_skillId: number): Promise<SkillRow> { this.notImplemented(); }
  async create_job(_skillId: number, _requester: string, _taskHash: string, _escrow: bigint): Promise<number> { this.notImplemented(); }
  async deliver_result(_jobId: number, _provider: string, _resultHash: string): Promise<void> { this.notImplemented(); }
  async confirm_completion(_jobId: number, _requester: string): Promise<void> { this.notImplemented(); }
  async dispute_result(_jobId: number, _requester: string): Promise<void> { this.notImplemented(); }
  async pending_withdrawals_of(_agent: string): Promise<bigint> { this.notImplemented(); }
  async agent_reputation(_agent: string): Promise<number> { this.notImplemented(); }
  async withdraw(_agent: string): Promise<bigint> { this.notImplemented(); }
  async deposit_bond(_agent: string, _amount: bigint): Promise<void> { this.notImplemented(); }
  async bonded_of(_agent: string): Promise<bigint> { this.notImplemented(); }
  async cross_chain_rep(_agent: string): Promise<number> { this.notImplemented(); }
  async set_cross_chain_rep(_agent: string, _score: number, _sourceChain: string): Promise<void> { this.notImplemented(); }
}

/** Backward-compatible alias — both as value (constructor) and type. */
export const OdraRegistry = InProcessRegistry;
export type OdraRegistry = InProcessRegistry;

/**
 * Factory: picks InProcessRegistry or RpcRegistry based on env.
 * - `CASPER_RPC_URL` + `CASPER_CONTRACT_HASH` set → RpcRegistry
 * - Otherwise → InProcessRegistry (current default, network-free)
 */
export function createRegistry(env: Record<string, string | undefined> = process.env): IAgentSkillRegistry {
  const rpcUrl = env.CASPER_RPC_URL;
  const contractHash = env.CASPER_CONTRACT_HASH;
  if (rpcUrl && contractHash) {
    return new RpcRegistry(rpcUrl, contractHash);
  }
  return new InProcessRegistry();
}
