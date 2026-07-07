import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperPrivateKey, Transaction, Args as CasperArgs } from "casper-js-sdk";
import {
  odraMappingDictionaryKey,
  accountAddressToBytes,
  AGENT_SKILL_REGISTRY_FIELD_INDEX,
} from "./odra_storage_key.js";
const { RpcClient, HttpHandler, ContractCallBuilder, Args, CLValue, ParamDictionaryIdentifier, ParamDictionaryIdentifierContractNamedKey } = casperSdk;

/**
 * CasperLiveClient (T13-live) — the real casper-js-sdk path `register_rwa_oracle_skill.ts`'s
 * `runLive()` deferred until a deployed contract existed. Builds a `ContractCallBuilder`
 * transaction per entry point, signs it with the caller's Casper key, submits it via
 * `RpcClient.putTransaction`, and returns the real transaction hash.
 *
 * Writes cover the six state-changing entry points the T13 RWA-oracle demo walks (register_skill,
 * deposit_bond, create_job, deliver_result, confirm_completion, withdraw). Argument shapes are
 * pinned to `contracts-odra/src/agent_skill_registry.rs`'s real signatures, not the simplified
 * `IAgentSkillRegistry` mirror in `odra_registry.ts` (that mirror predates P0-A/P0-B/P1-A and is
 * for offline demos only).
 *
 * Reads (`pendingWithdrawalsOf`, `agentReputationOf`, `bondedOf`) query the "state" dictionary
 * directly via `odra_storage_key.ts`'s derivation — Casper doesn't return a Wasm entry point's
 * return value through the RPC layer, so a getter *entry point* can't be called for a free read;
 * a global-state query against the contract's own storage is the only reliable path. The
 * dictionary-item-key formula and the field indices below are pinned by `cargo expand` against
 * the actual macro output (see `contracts-odra/README.md`), not guessed, and cross-checked in
 * `casper_odra_storage_key.test.ts` against an independent Python blake2b256 reference.
 * `get_skill` / `get_job` (compound `Skill`/`Job` structs, not a single scalar) are NOT yet
 * implemented — same derivation, but decoding the returned bytes needs the structs'
 * field-by-field `bytesrepr` layout, which is mechanical but unverified; a natural follow-up.
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
  getStateRootHashLatest(): Promise<{ stateRootHash: { toHex(): string } }>;
  getDictionaryItemByIdentifier(
    stateRootHash: string | null,
    identifier: InstanceType<typeof ParamDictionaryIdentifier>,
  ): Promise<{ storedValue: { clValue?: InstanceType<typeof CLValue> } }>;
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

  /** Reads `pending_withdrawals[account]` (motes, as a base-10 string) directly from the
   *  "state" dictionary — 0 if the account has never been credited. */
  async pendingWithdrawalsOf(accountHashHex: string): Promise<string> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.pendingWithdrawals,
      accountAddressToBytes(accountHashHex),
    );
    return clValue?.ui512?.toString() ?? "0";
  }

  /** Reads `agent_rep[account]` (0-100) directly from the "state" dictionary — the contract's
   *  `BASE_REPUTATION` default (50) if the account has never invoked/completed a job. */
  async agentReputationOf(accountHashHex: string): Promise<number> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentRep,
      accountAddressToBytes(accountHashHex),
    );
    return clValue?.ui32?.toNumber() ?? 50;
  }

  /** Reads `bonded_amount[account]` (motes, as a base-10 string) directly from the "state"
   *  dictionary — 0 if the account has never deposited a Tier-2 Sybil bond. */
  async bondedOf(accountHashHex: string): Promise<string> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.bondedAmount,
      accountAddressToBytes(accountHashHex),
    );
    return clValue?.ui512?.toString() ?? "0";
  }

  /** Shared read path: derive the dictionary-item key, query the contract's "state" dictionary
   *  at the latest state root, and return the stored `CLValue` (undefined ⇒ key not written yet,
   *  the Casper equivalent of Solidity's zero-valued default storage slot). */
  private async readMapping(fieldIndex: number, mappingKeyBytes: Uint8Array): Promise<InstanceType<typeof CLValue> | undefined> {
    const dictionaryItemKey = odraMappingDictionaryKey(fieldIndex, mappingKeyBytes);
    const { stateRootHash } = await this.rpc.getStateRootHashLatest();
    const identifier = new ParamDictionaryIdentifier(
      undefined,
      new ParamDictionaryIdentifierContractNamedKey(stripHashPrefix(this.contractHash), "state", dictionaryItemKey),
    );
    try {
      const result = await this.rpc.getDictionaryItemByIdentifier(stateRootHash.toHex(), identifier);
      return result.storedValue.clValue;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|ValueNotFound/i.test(msg)) return undefined;
      throw e;
    }
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
