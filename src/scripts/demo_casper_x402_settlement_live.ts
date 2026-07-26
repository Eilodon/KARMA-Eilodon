/**
 * Real on-chain proof for the x402/EIP-712 rewrite (docs/rfc/2026-07-21-x402-casper-eip712-interop.md
 * §5.1-5.5): deposits CSPR into the deployed `X402SettlementToken`
 * (contracts-odra/src/x402_settlement_token.rs), signs a real `TransferAuthorization` with
 * `CasperX402Plugin.payWithEnvelope`, and submits it against the live contract's
 * `transfer_with_authorization` entry point via `settleTransferWithAuthorization` — the actual
 * on-chain execution is the only thing that can confirm the byte-level EIP-712 encoding this
 * plugin builds matches what `odra-modules`' `CEP3009` verifies on-chain (a passing unit test
 * only proves internal sign/verify consistency, not agreement with the deployed Rust contract).
 *
 * Needs CASPER_RPC_URL (defaults to the public Testnet node) and KARMA_X402_CASPER_SETTLEMENT_TOKEN
 * (defaults to the real Testnet deployment) — plus either CASPER_GOV_SIGNER_1_SECRET_HEX (raw
 * key, no keystore/agentId needed — same dual-path convention as `deploy_x402_settlement_token.ts`)
 * or KEYSTORE_PATH/KEYSTORE_PASSWORD + an agentId arg.
 *
 *   CASPER_GOV_SIGNER_1_SECRET_HEX=... pnpm exec tsx src/scripts/demo_casper_x402_settlement_live.ts
 *   # or: KEYSTORE_PATH=./keystore.json KEYSTORE_PASSWORD=... \
 *   #     pnpm exec tsx src/scripts/demo_casper_x402_settlement_live.ts x402-deployer
 */
import { readFileSync } from "node:fs";
import "dotenv/config";
import casperSdk from "casper-js-sdk";
import { keystoreManager } from "../lib/keystore.js";
import { casperAccountHash } from "../lib/casper/keypair.js";
import { CasperX402Plugin, settleTransferWithAuthorization } from "../plugins/x402_casper.js";

const { RpcClient, HttpHandler, SessionBuilder, ContractCallBuilder, Args, CLValue, CLTypeUInt8, PrivateKey, KeyAlgorithm } = casperSdk;

/** `casper_types::bytesrepr::Bytes`'s `CLTyped` impl is `CLType::List(U8)` — same encoding
 *  `CasperLiveClient`'s private `bytesToCLList` uses for the proxy-caller's `args` field. */
function bytesToCLList(bytes: Uint8Array): InstanceType<typeof CLValue> {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
}

const rpcUrl = process.env.CASPER_RPC_URL ?? "https://node.testnet.casper.network/rpc";
const apiKey = process.env.CASPER_RPC_API_KEY;
const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
const settlementTokenHash =
  process.env.KARMA_X402_CASPER_SETTLEMENT_TOKEN ??
  "hash-b3387d595fa53045f42b350907a68f3a0b95cc983c056fd9d71d26f776c1d310";
const bareTokenHash = settlementTokenHash.replace(/^hash-/, "");

const handler = new HttpHandler(rpcUrl);
if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
const rpc = new RpcClient(handler);

// Odra's proxy-caller session — same wasm `CasperLiveClient.submitPayable` uses for every other
// payable entry point (contract-agnostic; see live_client.ts's `PROXY_CALLER_WASM_PATH` header
// for why a plain `ContractCallBuilder` call can't attach CSPR).
const PROXY_CALLER_WASM_URL = new URL("../lib/casper/resources/proxy_caller_with_return.wasm", import.meta.url);

const DEPOSIT_MOTES = 50_000_000n; // 0.05 CSPR wrapped into KX402
const AUTHORIZED_VALUE = 1_000_000n; // 0.001 KX402 authorized via EIP-712 + settled on-chain

async function waitForExecution(txHash: string, label: string): Promise<void> {
  console.log(`[${label}] submitted: ${txHash}`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      // `errorMessage` lives under `executionResult`, NOT on `exec` directly — confirmed the
      // hard way (a first version of this check read `exec.errorMessage`, which is always
      // undefined, so a real on-chain revert silently printed [PASS]). Also: `exec` can be
      // truthy while `executionResult` is present-but-incompletely-populated (errorMessage
      // itself undefined, not null) for a transaction that already succeeded — confirmed live
      // in demo_casper_streaming_installments.ts's own run, where a raw RPC re-query for the
      // same hash showed errorMessage: null once fully populated. Only accept once errorMessage
      // is unambiguously null (success) or a string (revert), never undefined.
      const executionResult = (
        exec as { executionResult?: { errorMessage?: string | null; consumed?: string | number } } | undefined
      )?.executionResult;
      if (executionResult?.errorMessage !== undefined) {
        console.log(`[${label}] execution result:`, JSON.stringify(exec, null, 2));
        if (executionResult.errorMessage) throw new Error(`[${label}] on-chain execution failed: ${executionResult.errorMessage}`);
        console.log(`[${label}] consumed: ${executionResult.consumed} motes`);
        return;
      }
      console.log(`[${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`[${label}]`)) throw e;
      console.log(`[${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  throw new Error(`[${label}] never finalized after 150s`);
}

async function main() {
  const rawHex = process.env.CASPER_GOV_SIGNER_1_SECRET_HEX;
  let payerSigner: InstanceType<typeof PrivateKey>;
  let agentId: string;
  if (rawHex) {
    payerSigner = PrivateKey.fromHex(rawHex, KeyAlgorithm.SECP256K1);
    agentId = "x402-deployer"; // label only — the raw-hex lookup below ignores it
    console.log("signing with CASPER_GOV_SIGNER_1_SECRET_HEX (raw key)");
  } else {
    const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
    const password = process.env.KEYSTORE_PASSWORD;
    if (!password) throw new Error("[x402-settlement-live] set either CASPER_GOV_SIGNER_1_SECRET_HEX or KEYSTORE_PASSWORD");
    const argAgentId = process.argv[2];
    if (!argAgentId) throw new Error("[x402-settlement-live] usage: demo_casper_x402_settlement_live.ts <agentId>");
    agentId = argAgentId;
    await keystoreManager.load(keystorePath, password);
    payerSigner = keystoreManager.getCasperKeypair(agentId);
  }
  const payer = casperAccountHash(payerSigner);
  console.log("payer / relayer account:", payer);
  console.log("settlement token:", settlementTokenHash);

  // ── Step 1: deposit() — wrap CSPR into KX402 (payable, needs the proxy-caller session) ────
  const packageHashBytes = Uint8Array.from(Buffer.from(bareTokenHash, "hex"));
  const proxyArgs = Args.fromMap({
    package_hash: CLValue.newCLByteArray(packageHashBytes),
    entry_point: CLValue.newCLString("deposit"),
    args: bytesToCLList(Args.fromMap({}).toBytes()),
    attached_value: CLValue.newCLUInt512(DEPOSIT_MOTES.toString()),
    amount: CLValue.newCLUInt512(DEPOSIT_MOTES.toString()),
  });
  const proxyWasm = new Uint8Array(readFileSync(PROXY_CALLER_WASM_URL));
  const depositTx = new SessionBuilder()
    .from(payerSigner.publicKey)
    .wasm(proxyWasm)
    .runtimeArgs(proxyArgs)
    .chainName(chainName)
    .payment(20_000_000_000) // 20 CSPR ceiling — proxy session does a purse + two transfers + the call
    .build();
  depositTx.sign(payerSigner);
  const depositResult = await rpc.putTransaction(depositTx);
  await waitForExecution(depositResult.transactionHash.toHex(), "deposit");
  console.log(`[deposit] wrapped ${DEPOSIT_MOTES} motes into KX402 for ${payer}`);

  // ── Step 2: sign a real EIP-712 TransferAuthorization (payer -> payer, proof-of-concept) ──
  const plugin = new CasperX402Plugin("http://localhost:0", () => payerSigner, {
    settlementTokenPackageHash: settlementTokenHash,
  });
  const { envelope } = await plugin.payWithEnvelope(
    {
      skillId: "1",
      price: AUTHORIZED_VALUE.toString(),
      asset: "KX402",
      payTo: payer, // self-transfer — simplest proof the whole EIP-712 + settlement path round-trips
      network: "casper:casper-test",
    },
    { agentId },
  );
  console.log("[sign] EIP-712 TransferAuthorization signed:", {
    from: envelope.payload.from,
    to: envelope.payload.to,
    value: envelope.payload.value,
    nonce: envelope.payload.nonce.slice(0, 16) + "...",
  });

  // ── Step 3: settle on-chain — the real proof the digest this plugin builds matches what
  // odra-modules' CEP3009 verifies on-chain (any mismatch reverts with InvalidSignature). ──
  const { txHash: settleTxHash } = await settleTransferWithAuthorization(
    rpc,
    (args) =>
      (() => {
        const tx = new ContractCallBuilder()
          .from(payerSigner.publicKey)
          .byPackageHash(bareTokenHash)
          .entryPoint("transfer_with_authorization")
          .runtimeArgs(args)
          .chainName(chainName)
          .payment(5_000_000_000)
          .build();
        tx.sign(payerSigner);
        return tx;
      })(),
    envelope,
  );
  await waitForExecution(settleTxHash, "transfer_with_authorization");
  console.log("\n[PASS] real EIP-712-signed transfer_with_authorization executed on Casper Testnet.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
