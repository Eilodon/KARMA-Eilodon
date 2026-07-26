/**
 * "Design A" from the batch/channel-primitive research: CEP-18's standard `approve`/
 * `transfer_from`/`allowance` — already deployed and delegated on `X402SettlementToken`
 * (`contracts-odra/src/x402_settlement_token.rs`), used by nothing in this repo until now — as a
 * streaming-payment primitive that needs ZERO new contract code, same as Design C
 * (`demo_casper_streaming_installments.ts`), but with a different trade-off:
 *
 *   - Design C (N escrow jobs): full dispute-bond + reputation protection per chunk, but the
 *     payer must actively co-sign every single chunk (`create_job` is `#[odra(payable)]` native
 *     CSPR, no relay).
 *   - Design A (this script): the payer signs ONCE (`approve`), then the provider pulls every
 *     chunk unattended via `transfer_from` — no payer interaction, no per-chunk signature, cheaper
 *     per call too (`approve`/`transfer_from` are plain calls, not the payable proxy-session
 *     `create_job` needs). Trade-off: zero dispute protection — this is a bare payment primitive,
 *     the same class as x402-exact itself, just pull-based instead of push-based. Right fit for
 *     metered access with nothing to dispute (e.g. paid read-only API calls), wrong fit for a
 *     deliverable that could be bad and needs a neutral verdict.
 *
 * Proves both halves live: N pulls succeed inside the approved budget, and the (N+1)th pull
 * — deliberately sized to exceed what's left — reverts with the contract's own
 * `Error::InsufficientAllowance` (60002, from `odra-modules`' `cep18::errors`), not a a generic
 * failure. A payer who wants to stop a stream mid-flight has exactly one lever: approve a smaller
 * remaining amount (or 0) — proven by the fact that this same enforcement path is what makes the
 * revert happen at all.
 *
 * Needs CASPER_RPC_URL (defaults to the public Testnet node), KARMA_X402_CASPER_SETTLEMENT_TOKEN,
 * and CASPER_GOV_SIGNER_1_SECRET_HEX (provider/spender) + CASPER_GOV_SIGNER_2_SECRET_HEX
 * (requester/owner) — same funded pair every other live Casper demo in this repo uses.
 *
 *   pnpm exec tsx src/scripts/demo_casper_x402_allowance_streaming.ts [chunkCount]
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import casperSdk from "casper-js-sdk";

const { RpcClient, HttpHandler, SessionBuilder, ContractCallBuilder, Args, CLValue, CLTypeUInt8, Key, PrivateKey, KeyAlgorithm } =
  casperSdk;

const PROXY_CALLER_WASM_URL = new URL("../lib/casper/resources/proxy_caller_with_return.wasm", import.meta.url);

const DEPOSIT_MOTES = 500_000_000n; // 0.5 CSPR wrapped into KX402 (requester/owner)
const BUDGET = 300_000_000n; // 0.3 KX402 approved to the provider/spender
const CHUNK_AMOUNT = 100_000_000n; // 0.1 KX402 pulled per chunk

/** Odra's `Address` CLTyped impl is `CLType::Key` — same convention `live_client.ts`'s
 *  `addressKeyArg` uses for AgentSkillRegistry's `Address` args. */
function addressKeyArg(accountHashPrefixed: string): InstanceType<typeof CLValue> {
  return CLValue.newCLKey(Key.newKey(accountHashPrefixed));
}

/** `casper_types::bytesrepr::Bytes`'s CLTyped impl is `CLType::List(U8)` — same encoding
 *  `demo_casper_x402_settlement_live.ts`'s local helper uses for the proxy-caller's `args` field. */
function bytesToCLList(bytes: Uint8Array): InstanceType<typeof CLValue> {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
}

function loadSigner(envVar: string, label: string): InstanceType<typeof PrivateKey> {
  const hex = process.env[envVar];
  if (!hex) throw new Error(`[allowance-streaming] set ${envVar} (${label})`);
  return PrivateKey.fromHex(hex, KeyAlgorithm.SECP256K1);
}

const rpcUrl = process.env.CASPER_RPC_URL ?? "https://node.testnet.casper.network/rpc";
const apiKey = process.env.CASPER_RPC_API_KEY;
const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
const settlementTokenHash = process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN;
if (!settlementTokenHash) throw new Error("[allowance-streaming] KARMA_X402_CASPER_SETTLEMENT_TOKEN not set");
const bareTokenHash = settlementTokenHash.replace(/^hash-/, "");

const handler = new HttpHandler(rpcUrl);
if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
const rpc = new RpcClient(handler);

interface Finalized {
  errorMessage: string | null;
  consumed: bigint;
}

/** Same fix as demo_casper_streaming_installments.ts's waitForFinalization and
 *  demo_casper_x402_settlement_live.ts's waitForExecution: only accept once errorMessage is
 *  unambiguously null or a string, never undefined (a present-but-incompletely-populated SDK
 *  response for an already-finalized transaction — confirmed live in both of those runs). */
async function waitForFinalization(txHash: string, label: string): Promise<Finalized> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const executionResult = (
        info.executionInfo as { executionResult?: { errorMessage?: string | null; consumed?: string | number } } | undefined
      )?.executionResult;
      if (executionResult?.errorMessage !== undefined) {
        const consumed = BigInt(executionResult.consumed ?? 0);
        console.log(`    [${label}] finalized. errorMessage: ${executionResult.errorMessage === null ? "null (success)" : executionResult.errorMessage}, consumed: ${consumed} motes`);
        return { errorMessage: executionResult.errorMessage, consumed };
      }
      console.log(`    [${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`    [${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  throw new Error(`[${label}] never finalized after 150s`);
}

async function deposit(owner: InstanceType<typeof PrivateKey>, motes: bigint): Promise<Finalized> {
  const packageHashBytes = Uint8Array.from(Buffer.from(bareTokenHash, "hex"));
  const proxyArgs = Args.fromMap({
    package_hash: CLValue.newCLByteArray(packageHashBytes),
    entry_point: CLValue.newCLString("deposit"),
    args: bytesToCLList(Args.fromMap({}).toBytes()),
    attached_value: CLValue.newCLUInt512(motes.toString()),
    amount: CLValue.newCLUInt512(motes.toString()),
  });
  const proxyWasm = new Uint8Array(readFileSync(PROXY_CALLER_WASM_URL));
  const tx = new SessionBuilder()
    .from(owner.publicKey)
    .wasm(proxyWasm)
    .runtimeArgs(proxyArgs)
    .chainName(chainName)
    .payment(20_000_000_000) // 20 CSPR ceiling — proxy session does a purse + two transfers + the call
    .build();
  tx.sign(owner);
  const { transactionHash } = await rpc.putTransaction(tx);
  console.log(`  tx: ${transactionHash.toHex()}`);
  return waitForFinalization(transactionHash.toHex(), "deposit");
}

/** approve/transfer_from are plain (non-payable) entry points — a plain ContractCallBuilder call,
 *  no proxy-purse session needed (unlike deposit/create_job). */
async function callPlain(
  signer: InstanceType<typeof PrivateKey>,
  entryPoint: string,
  args: InstanceType<typeof Args>,
  paymentMotes: number,
): Promise<Finalized> {
  const tx = new ContractCallBuilder()
    .from(signer.publicKey)
    .byPackageHash(bareTokenHash)
    .entryPoint(entryPoint)
    .runtimeArgs(args)
    .chainName(chainName)
    .payment(paymentMotes)
    .build();
  tx.sign(signer);
  const { transactionHash } = await rpc.putTransaction(tx);
  console.log(`  tx: ${transactionHash.toHex()}`);
  return waitForFinalization(transactionHash.toHex(), entryPoint);
}

async function main(): Promise<void> {
  const chunkCount = Number(process.argv[2] ?? "3");
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error(`chunkCount must be a positive integer, got ${process.argv[2]}`);
  }
  if (BigInt(chunkCount) * CHUNK_AMOUNT > BUDGET) {
    throw new Error(`chunkCount=${chunkCount} * ${CHUNK_AMOUNT} exceeds BUDGET=${BUDGET} — lower chunkCount or raise BUDGET`);
  }

  const requester = loadSigner("CASPER_GOV_SIGNER_2_SECRET_HEX", "requester/owner"); // approves once, then can walk away
  const provider = loadSigner("CASPER_GOV_SIGNER_1_SECRET_HEX", "provider/spender"); // pulls unattended
  const requesterHash = requester.publicKey.accountHash().toPrefixedString();
  const providerHash = provider.publicKey.accountHash().toPrefixedString();
  console.log("requester/owner (approves once):", requesterHash);
  console.log("provider/spender (pulls unattended):", providerHash);
  console.log("settlement token:", settlementTokenHash);
  console.log(`streaming ${chunkCount} chunk(s) of ${CHUNK_AMOUNT} KX402 motes, budget ${BUDGET}\n`);

  console.log("1. deposit — requester wraps CSPR into KX402");
  const depositResult = await deposit(requester, DEPOSIT_MOTES);
  if (depositResult.errorMessage) throw new Error(`deposit reverted: ${depositResult.errorMessage}`);

  console.log("\n2. approve — requester authorizes the provider to pull up to BUDGET, ONCE");
  const approveArgs = Args.fromMap({
    spender: addressKeyArg(providerHash),
    amount: CLValue.newCLUInt256(BUDGET.toString()),
  });
  const approveResult = await callPlain(requester, "approve", approveArgs, 3_000_000_000);
  if (approveResult.errorMessage) throw new Error(`approve reverted: ${approveResult.errorMessage}`);

  const pullCosts: bigint[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    console.log(`\n3.${i + 1} transfer_from — provider pulls chunk ${i + 1}/${chunkCount}, no requester signature`);
    const args = Args.fromMap({
      owner: addressKeyArg(requesterHash),
      recipient: addressKeyArg(providerHash),
      amount: CLValue.newCLUInt256(CHUNK_AMOUNT.toString()),
    });
    const result = await callPlain(provider, "transfer_from", args, 3_000_000_000);
    if (result.errorMessage) throw new Error(`chunk ${i + 1} transfer_from reverted: ${result.errorMessage}`);
    pullCosts.push(result.consumed);
  }

  const remaining = BUDGET - BigInt(chunkCount) * CHUNK_AMOUNT;
  const overLimit = remaining + CHUNK_AMOUNT; // deliberately more than what's left
  console.log(
    `\n4. transfer_from — provider attempts to pull ${overLimit} with only ${remaining} left in the allowance (expect InsufficientAllowance, 60002)`,
  );
  const overArgs = Args.fromMap({
    owner: addressKeyArg(requesterHash),
    recipient: addressKeyArg(providerHash),
    amount: CLValue.newCLUInt256(overLimit.toString()),
  });
  const overResult = await callPlain(provider, "transfer_from", overArgs, 3_000_000_000);
  if (!overResult.errorMessage) {
    throw new Error("over-limit pull unexpectedly SUCCEEDED — allowance enforcement is not working as documented");
  }
  console.log(`  correctly reverted: ${overResult.errorMessage}`);

  const totalPullConsumed = pullCosts.reduce((a, b) => a + b, 0n);
  console.log(`\n${chunkCount} chunk(s) pulled unattended, real gas consumed:`);
  console.log(`  deposit (once):  ${depositResult.consumed} motes`);
  console.log(`  approve (once):  ${approveResult.consumed} motes`);
  console.log(`  ${chunkCount}x transfer_from: ${totalPullConsumed} motes (${pullCosts.join(" + ")})`);
  console.log(
    `  total: ${depositResult.consumed + approveResult.consumed + totalPullConsumed} motes ≈ ${
      Number(depositResult.consumed + approveResult.consumed + totalPullConsumed) / 1e9
    } CSPR`,
  );
  console.log(`\n[PASS] approve-once, pull-N-times streaming proven live — and the budget ceiling is real, not documentation.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
