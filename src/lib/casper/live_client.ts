import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperPrivateKey, Transaction, Args as CasperArgs } from "casper-js-sdk";
const { RpcClient, HttpHandler, ContractCallBuilder, Args, CLValue } = casperSdk;

/**
 * CasperLiveClient (T13-live) — the real casper-js-sdk path `register_rwa_oracle_skill.ts`'s
 * `runLive()` deferred until a deployed contract existed. Builds a `ContractCallBuilder`
 * transaction per entry point, signs it with the caller's Casper key, submits it via
 * `RpcClient.putTransaction`, and returns the real transaction hash.
 *
 * Scope: the six state-changing entry points the T13 RWA-oracle demo walks (register_skill,
 * deposit_bond, create_job, deliver_result, confirm_completion, withdraw). Argument shapes are
 * pinned to `contracts-odra/src/agent_skill_registry.rs`'s real signatures, not the simplified
 * `IAgentSkillRegistry` mirror in `odra_registry.ts` (that mirror predates P0-A/P0-B/P1-A and is
 * for offline demos only).
 *
 * Deliberately NOT implemented: read methods (get_skill, get_job, agent_reputation, …). Casper
 * doesn't return a Wasm entry point's return value through the RPC layer — the reliable read path
 * is a global-state query against the contract's storage, and `get_skill`/`get_job` are backed by
 * Odra `Mapping<K,V>` fields whose on-chain dictionary-item-key derivation needs calibrating
 * against a live deployed instance before it can be trusted. Faking that would be worse than not
 * having it. `skill_count()` / `job_count()` are plain `Var<u64>` and ARE safely queryable once
 * calibrated the same way — a natural follow-up once a contract is actually deployed.
 */

export interface CasperLiveClientOpts {
  rpcUrl: string;
  contractHash: string;
  chainName?: string;
  /** Gas payment ceiling in motes, per call. Overridable per-method. */
  defaultPaymentMotes?: bigint;
}

export interface RegisterSkillInput {
  name: string;
  description: string;
  mcpEndpoint: string;
  /** CSPR motes (9 decimals), matching the Rust `price_per_call: U512`. */
  pricePerCallMotes: bigint;
  minReputationToInvoke: number;
  identityPolicy: number;
}

export interface CreateJobInput {
  skillId: bigint;
  /** 32-byte task hash, hex-encoded (no 0x prefix). */
  taskHashHex: string;
  deadlineSecs: bigint;
  /** Escrow attached to the payable call, in motes — must equal the skill's `price_per_call`. */
  escrowMotes: bigint;
}

export interface DeliverResultInput {
  jobId: bigint;
  /** 32-byte result hash, hex-encoded (no 0x prefix). */
  resultHashHex: string;
}

const DEFAULT_PAYMENT_MOTES = 5_000_000_000n; // 5 CSPR ceiling — generous default, refund is automatic.

/** casper-client / DEMO_CASPER.md conventionally write contract package hashes as
 *  `hash-<64 hex>` (or `contract-package-wasm<64 hex>`); `ContractCallBuilder.byHash()` wants the
 *  bare 64-char hex, so strip whichever prefix is present. */
function stripHashPrefix(hash: string): string {
  return hash.replace(/^(hash-|contract-package-wasm|contract-)/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`[casper-live] odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Minimal seam `CasperLiveClient` needs from `RpcClient` — narrow on purpose so tests can
 *  inject a fake without reproducing casper-js-sdk's real JSON-RPC response parsing. */
export interface CasperTransactionSubmitter {
  putTransaction(transaction: Transaction): Promise<{ transactionHash: { toHex(): string } }>;
}

export class CasperLiveClient {
  private readonly rpc: CasperTransactionSubmitter;
  private readonly contractHash: string;
  private readonly chainName: string;
  private readonly defaultPaymentMotes: bigint;

  constructor(opts: CasperLiveClientOpts, rpcOverride?: CasperTransactionSubmitter) {
    this.rpc = rpcOverride ?? new RpcClient(new HttpHandler(opts.rpcUrl));
    this.contractHash = opts.contractHash;
    this.chainName = opts.chainName ?? "casper-test";
    this.defaultPaymentMotes = opts.defaultPaymentMotes ?? DEFAULT_PAYMENT_MOTES;
  }

  /** `register_skill(name, description, mcp_endpoint, price_per_call, min_reputation_to_invoke, identity_policy) -> u64` */
  async registerSkill(
    signer: CasperPrivateKey,
    s: RegisterSkillInput,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      name: CLValue.newCLString(s.name),
      description: CLValue.newCLString(s.description),
      mcp_endpoint: CLValue.newCLString(s.mcpEndpoint),
      price_per_call: CLValue.newCLUInt512(s.pricePerCallMotes.toString()),
      min_reputation_to_invoke: CLValue.newCLUInt32(s.minReputationToInvoke),
      identity_policy: CLValue.newCLUint8(s.identityPolicy),
    });
    return this.submit(signer, "register_skill", args, paymentMotes);
  }

  /** `#[odra(payable)] deposit_bond()` — Odra's payable convention: attach CSPR via the `amount` runtime arg. */
  async depositBond(signer: CasperPrivateKey, amountMotes: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ amount: CLValue.newCLUInt512(amountMotes.toString()) });
    return this.submit(signer, "deposit_bond", args, paymentMotes);
  }

  /** `#[odra(payable)] create_job(skill_id, task_hash: Bytes, deadline_secs) -> u64` */
  async createJob(signer: CasperPrivateKey, j: CreateJobInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      skill_id: CLValue.newCLUint64(j.skillId.toString()),
      task_hash: CLValue.newCLByteArray(hexToBytes(j.taskHashHex)),
      deadline_secs: CLValue.newCLUint64(j.deadlineSecs.toString()),
      amount: CLValue.newCLUInt512(j.escrowMotes.toString()),
    });
    return this.submit(signer, "create_job", args, paymentMotes);
  }

  /** `deliver_result(job_id, result_hash: Bytes)` */
  async deliverResult(signer: CasperPrivateKey, d: DeliverResultInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(d.jobId.toString()),
      result_hash: CLValue.newCLByteArray(hexToBytes(d.resultHashHex)),
    });
    return this.submit(signer, "deliver_result", args, paymentMotes);
  }

  /** `confirm_completion(job_id)` */
  async confirmCompletion(signer: CasperPrivateKey, jobId: bigint, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({ job_id: CLValue.newCLUint64(jobId.toString()) });
    return this.submit(signer, "confirm_completion", args, paymentMotes);
  }

  /** `withdraw()` — no args; pulls the caller's full `pending_withdrawals` balance. */
  async withdraw(signer: CasperPrivateKey, paymentMotes?: bigint): Promise<{ txHash: string }> {
    return this.submit(signer, "withdraw", Args.fromMap({}), paymentMotes);
  }

  private async submit(
    signer: CasperPrivateKey,
    entryPoint: string,
    args: CasperArgs,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const transaction = new ContractCallBuilder()
      .from(signer.publicKey)
      .byHash(stripHashPrefix(this.contractHash))
      .entryPoint(entryPoint)
      .runtimeArgs(args)
      .chainName(this.chainName)
      .payment(Number(paymentMotes ?? this.defaultPaymentMotes))
      .build();
    transaction.sign(signer);
    const result = await this.rpc.putTransaction(transaction);
    return { txHash: result.transactionHash.toHex() };
  }
}
