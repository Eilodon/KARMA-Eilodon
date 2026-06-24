/**
 * In-process model of the Casper/Odra `AgentSkillRegistry` (T2.1, Option B).
 *
 * This is a faithful JS twin of `contracts-odra/src/agent_skill_registry.rs` (45/45 Rust tests) —
 * the same composition primitive, validation order, weighted escrow split (last leaf absorbs the
 * rounding remainder), and self-deal reputation carve-out. It exists so the Casper composition
 * primitive is invocable + discoverable through an MCP-shaped tool surface (see
 * `composition_tools.ts`) without a live Casper RPC / WASM deploy — mirroring the established
 * `demo_casper_e2e` / `demo_casper_composability` in-process pattern ("drop-in swappable for a
 * live StdioMcpClient"). The Pharos/Solidity port + real `karma.tool.ts` wiring stay P3 backlog.
 */

export const MAX_COMPOSITION_LEAVES = 8;
export const WEIGHT_DENOMINATOR = 10_000;
export const BASE_REPUTATION = 50;
export const REPUTATION_STEP = 5;
export const MAX_REPUTATION = 100;

/** Mirrors the Odra `Error` enum variants used by the composition path. */
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
  | "JobNotDelivered";

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

export class OdraRegistry {
  private readonly skills = new Map<number, SkillRow>();
  private readonly compositions = new Map<number, Composition>();
  private readonly jobs = new Map<number, JobRow>();
  private readonly pendingWithdrawals = new Map<string, bigint>();
  private readonly agentRep = new Map<string, number>();
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
