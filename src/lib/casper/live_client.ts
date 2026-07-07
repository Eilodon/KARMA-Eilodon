import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import casperSdk from "casper-js-sdk";
import type { PrivateKey as CasperPrivateKey, Transaction, Args as CasperArgs } from "casper-js-sdk";
import {
  odraMappingDictionaryKey,
  accountAddressToBytes,
  u64ToBytes,
  AGENT_SKILL_REGISTRY_FIELD_INDEX,
} from "./odra_storage_key.js";
import { decodeSkill, decodeJob, decodeU32, decodeU512, type DecodedSkill, type DecodedJob } from "./odra_codec.js";
const {
  RpcClient,
  HttpHandler,
  ContractCallBuilder,
  SessionBuilder,
  Args,
  CLValue,
  CLTypeUInt8,
  ParamDictionaryIdentifier,
  ParamDictionaryIdentifierContractNamedKey,
} = casperSdk;

/** Odra's generic proxy-caller session (https://odra.dev/docs/basics/native-token —
 *  "Cargo Purse" idiom): Casper has no direct account→contract token transfer, so a "payable"
 *  entry point (one that reads `self.env().attached_value()`, e.g. `deposit_bond`/`create_job`)
 *  can't be reached via a plain stored-contract-call transaction with a `U512` arg named
 *  "amount" — that arg is never read by the contract and `attached_value()` stays zero
 *  (confirmed against a real deploy: reverted with `ExecutionError::NoBond`, code 20). The
 *  proxy session creates a one-time purse, funds it, and calls the target entry point with that
 *  purse's URef under the `cargo_purse` arg the wasm-env glue actually reads. Bundled verbatim
 *  from `odra-casper-test-vm` (its `resources/proxy_caller_with_return.wasm`) — Odra ships no
 *  separate npm package for it, and building it from source isn't necessary (it's
 *  contract-agnostic, not project-specific like `karma_odra.wasm`).
 */
const PROXY_CALLER_WASM_PATH = fileURLToPath(new URL("./resources/proxy_caller_with_return.wasm", import.meta.url));

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
 * `get_skill` / `get_job` (compound `Skill`/`Job` structs, not a single scalar) decode the raw
 * `CLValue.any` bytes via `odra_codec.ts`, field-by-field per the structs' `bytesrepr` layout —
 * see that module's header for how the byte-level rules were confirmed, not assumed.
 */

export interface CasperLiveClientOpts {
  rpcUrl: string;
  contractHash: string;
  chainName?: string;
  /** Gas payment ceiling in motes, per call. Overridable per-method. */
  defaultPaymentMotes?: bigint;
  /** Extra HTTP headers for every RPC call — e.g. `{ Authorization: <key> }` for hosted RPC
   *  providers (cspr.cloud) that now require an API key; the header value is passed through
   *  as-is (no "Bearer " prefix — cspr.cloud rejects that form). */
  rpcHeaders?: Record<string, string>;
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
// Proxy-caller sessions do more work than a plain entry-point call (create a purse + two native
// transfers + the entry point itself), so they need a higher ceiling than DEFAULT_PAYMENT_MOTES.
const PROXY_DEFAULT_PAYMENT_MOTES = 20_000_000_000n; // 20 CSPR ceiling.

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

/** Odra's `#[odra::odra_type]` struct/enum values come back over RPC as `CLType::List(U8)`
 *  (one CLValue::U8 element per byte) — confirmed against a real deployed contract read, not
 *  `CLType::Any` as first assumed (that assumption only ever passed against hand-built mocks). */
function odraStructBytes(clValue: InstanceType<typeof CLValue> | undefined): Uint8Array | undefined {
  if (clValue?.any) return clValue.any.bytes();
  if (clValue?.list) return Uint8Array.from(clValue.list.elements.map((e) => e.ui8!.toNumber()));
  return undefined;
}

/** `casper_types::bytesrepr::Bytes`'s `CLTyped` impl is literally `<Vec<u8>>::cl_type()` — i.e.
 *  `CLType::List(U8)`, the same encoding `odraStructBytes` reads back (confirmed in
 *  `casper-types` source, not assumed). Used for the proxy-caller's `args` field and for any
 *  entry-point arg whose Rust type is `Bytes` (e.g. `task_hash`/`result_hash` — NOT
 *  `CLValue.newCLByteArray`, which is the fixed-size `ByteArray` CLType instead). */
function bytesToCLList(bytes: Uint8Array): InstanceType<typeof CLValue> {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
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
  queryLatestGlobalState(
    key: string,
    path: string[],
  ): Promise<{
    storedValue: { contractPackage?: { versions: Array<{ contractHash: { hash: { toHex(): string } } }> } };
  }>;
}

export class CasperLiveClient {
  private readonly rpc: CasperTransactionSubmitter;
  private readonly contractHash: string;
  private readonly chainName: string;
  private readonly defaultPaymentMotes: bigint;

  constructor(opts: CasperLiveClientOpts, rpcOverride?: CasperTransactionSubmitter) {
    if (rpcOverride) {
      this.rpc = rpcOverride;
    } else {
      const handler = new HttpHandler(opts.rpcUrl);
      if (opts.rpcHeaders) handler.setCustomHeaders(opts.rpcHeaders);
      this.rpc = new RpcClient(handler);
    }
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
    // deposit_bond() takes no named args — it reads self.env().attached_value(), which only a
    // proxy-caller session (see submitPayable) can actually populate on Casper.
    return this.submitPayable(signer, "deposit_bond", Args.fromMap({}), amountMotes, paymentMotes);
  }

  /** `create_job(skill_id, task_hash: Bytes, deadline_secs) -> u64` — payable: takes no
   *  `amount`/escrow arg at all (confirmed against the deployed contract's own entry-point
   *  signature); the escrow is `self.env().attached_value()`, checked to equal exactly
   *  `skill.price_per_call` — hence `submitPayable`, not a plain `amount` runtime arg. */
  async createJob(signer: CasperPrivateKey, j: CreateJobInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const innerArgs = Args.fromMap({
      skill_id: CLValue.newCLUint64(j.skillId.toString()),
      task_hash: bytesToCLList(hexToBytes(j.taskHashHex)),
      deadline_secs: CLValue.newCLUint64(j.deadlineSecs.toString()),
    });
    return this.submitPayable(signer, "create_job", innerArgs, j.escrowMotes, paymentMotes);
  }

  /** `deliver_result(job_id, result_hash: Bytes)` */
  async deliverResult(signer: CasperPrivateKey, d: DeliverResultInput, paymentMotes?: bigint): Promise<{ txHash: string }> {
    const args = Args.fromMap({
      job_id: CLValue.newCLUint64(d.jobId.toString()),
      result_hash: bytesToCLList(hexToBytes(d.resultHashHex)),
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
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU512(bytes).toString() : "0";
  }

  /** Reads `agent_rep[account]` (0-100) directly from the "state" dictionary — the contract's
   *  `BASE_REPUTATION` default (50) if the account has never invoked/completed a job. */
  async agentReputationOf(accountHashHex: string): Promise<number> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.agentRep,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU32(bytes) : 50;
  }

  /** Reads `bonded_amount[account]` (motes, as a base-10 string) directly from the "state"
   *  dictionary — 0 if the account has never deposited a Tier-2 Sybil bond. */
  async bondedOf(accountHashHex: string): Promise<string> {
    const clValue = await this.readMapping(
      AGENT_SKILL_REGISTRY_FIELD_INDEX.bondedAmount,
      accountAddressToBytes(accountHashHex),
    );
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeU512(bytes).toString() : "0";
  }

  /** Reads `skills[skillId]` — the full `Skill` record — decoding Odra's raw struct bytes.
   *  `undefined` if the ID was never registered. */
  async getSkill(skillId: bigint): Promise<DecodedSkill | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.skills, u64ToBytes(skillId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeSkill(bytes) : undefined;
  }

  /** Reads `jobs[jobId]` — the full `Job` record — decoding Odra's raw struct bytes.
   *  `undefined` if the ID was never created. */
  async getJob(jobId: bigint): Promise<DecodedJob | undefined> {
    const clValue = await this.readMapping(AGENT_SKILL_REGISTRY_FIELD_INDEX.jobs, u64ToBytes(jobId));
    const bytes = odraStructBytes(clValue);
    return bytes ? decodeJob(bytes) : undefined;
  }

  /** `this.contractHash` is the *package* hash (stable across upgrades — what
   *  `ContractCallBuilder.byPackageHash()` wants), but the "state" named key holding every
   *  Mapping/Var lives on the package's *entity* (a specific installed version), under a
   *  different hash. Resolved via `query_global_state` on the package and cached — cheap to
   *  recompute per client instance, wrong to assume it never changes across a real upgrade. */
  private entityHash: string | undefined;

  private async resolveEntityHash(): Promise<string> {
    if (this.entityHash) return this.entityHash;
    const packageKey = this.contractHash.startsWith("hash-") ? this.contractHash : `hash-${stripHashPrefix(this.contractHash)}`;
    const { storedValue } = await this.rpc.queryLatestGlobalState(packageKey, []);
    const versions = storedValue.contractPackage?.versions ?? [];
    if (versions.length === 0) {
      throw new Error(`[casper-live-client] no contract versions found for package ${packageKey}`);
    }
    const latest = versions[versions.length - 1];
    this.entityHash = `hash-${latest.contractHash.hash.toHex()}`;
    return this.entityHash;
  }

  /** Shared read path: derive the dictionary-item key, query the contract's "state" dictionary
   *  at the latest state root, and return the stored `CLValue` (undefined ⇒ key not written yet,
   *  the Casper equivalent of Solidity's zero-valued default storage slot). */
  private async readMapping(fieldIndex: number, mappingKeyBytes: Uint8Array): Promise<InstanceType<typeof CLValue> | undefined> {
    const dictionaryItemKey = odraMappingDictionaryKey(fieldIndex, mappingKeyBytes);
    const entityKey = await this.resolveEntityHash();
    const { stateRootHash } = await this.rpc.getStateRootHashLatest();
    const identifier = new ParamDictionaryIdentifier(
      undefined,
      new ParamDictionaryIdentifierContractNamedKey(entityKey, "state", dictionaryItemKey),
    );
    try {
      const result = await this.rpc.getDictionaryItemByIdentifier(stateRootHash.toHex(), identifier);
      return result.storedValue.clValue;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = (e as { sourceErr?: { data?: string } })?.sourceErr?.data;
      if (/not found|ValueNotFound/i.test(msg) || (detail && /not found/i.test(detail))) return undefined;
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
      .byPackageHash(stripHashPrefix(this.contractHash))
      .entryPoint(entryPoint)
      .runtimeArgs(args)
      .chainName(this.chainName)
      .payment(Number(paymentMotes ?? this.defaultPaymentMotes))
      .build();
    transaction.sign(signer);
    const result = await this.rpc.putTransaction(transaction);
    return { txHash: result.transactionHash.toHex() };
  }

  /** Calls a "payable" entry point (one that reads `self.env().attached_value()`) via Odra's
   *  proxy-caller session — see the `PROXY_CALLER_WASM_PATH` comment for why a plain
   *  `ContractCallBuilder` call can't attach CSPR. `innerArgs` are the entry point's own
   *  arguments (e.g. empty for `deposit_bond`); `attachedValueMotes` is the CSPR to transfer in,
   *  separate from `paymentMotes` (the gas ceiling, higher than a plain call's default — the
   *  proxy also creates a purse and does two native transfers). */
  private async submitPayable(
    signer: CasperPrivateKey,
    entryPoint: string,
    innerArgs: CasperArgs,
    attachedValueMotes: bigint,
    paymentMotes?: bigint,
  ): Promise<{ txHash: string }> {
    const packageHashBytes = hexToBytes(stripHashPrefix(this.contractHash));
    const proxyArgs = Args.fromMap({
      package_hash: CLValue.newCLByteArray(packageHashBytes),
      entry_point: CLValue.newCLString(entryPoint),
      args: bytesToCLList(innerArgs.toBytes()),
      attached_value: CLValue.newCLUInt512(attachedValueMotes.toString()),
      amount: CLValue.newCLUInt512(attachedValueMotes.toString()),
    });
    const wasmBytes = readFileSync(PROXY_CALLER_WASM_PATH);
    const transaction = new SessionBuilder()
      .from(signer.publicKey)
      .wasm(new Uint8Array(wasmBytes))
      .runtimeArgs(proxyArgs)
      .chainName(this.chainName)
      .payment(Number(paymentMotes ?? PROXY_DEFAULT_PAYMENT_MOTES))
      .build();
    transaction.sign(signer);
    const result = await this.rpc.putTransaction(transaction);
    return { txHash: result.transactionHash.toHex() };
  }
}
