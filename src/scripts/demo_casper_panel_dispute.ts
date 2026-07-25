/**
 * The panel-mode "courtroom" pillar, run for real: a requester disputes a delivered result via
 * dispute_result_via_panel (not the single-arbiter dispute_result), the provider contests by
 * matching the bond, and 2 of 3 independent panel arbiters vote ProviderAtFault — reaching
 * strict-majority threshold and settling automatically, same settle_dispute_verdict code path as
 * the single-arbiter courtroom flow (contracts-odra/src/agent_skill_registry.rs). Mirrors
 * demo_casper_courtroom.ts exactly, with dispute_result_via_panel/cast_panel_vote in place of
 * dispute_result/arbitrate.
 *
 * Requires the panel to already be active — run demo_casper_panel_governance.ts (and its
 * --execute follow-up after the 30-min timelock) first. Reads the 3 arbiter keys from
 * demo-video/out_casper/panel_governance_state.json, the same file that script wrote.
 *
 * Four distinct accounts, deliberately not overlapping:
 *   - 3 panel arbiters = the fresh keys demo_casper_panel_governance.ts generated and funded
 *   - requester        = governance signer 2
 *   - provider         = a freshly generated throwaway key, funded by a native CSPR transfer
 *                         from signer 1 (100 CSPR — the amount demo_casper_courtroom.ts's own
 *                         postmortem proved necessary for register_skill + deliver_result +
 *                         the payable respond_to_dispute proxy call in one take)
 *
 * Verdict is ProviderAtFault (2 of 3 vote it) — same mechanism teeth as the single-arbiter
 * courtroom: escrow + both bonds return to the requester, provider's skill reputation slashed,
 * and the panel fee splits across the 2 arbiters who voted (arb3 gets nothing — didn't vote).
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_2_SECRET_HEX in .env, plus signer 1 (funds the provider) and the panel state
 * file from demo_casper_panel_governance.ts.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import { jsonSafe } from "../lib/serialize.js";

const { PrivateKey, KeyAlgorithm, RpcClient, HttpHandler, NativeTransferBuilder } = casperSdk;

const PRICE_PER_CALL_MOTES = 1_000_000_000n; // 1 CSPR
const DISPUTE_BOND_MOTES = 1_000_000_000n; // 10_000 bps (1x escrow) of 1 CSPR
const PANEL_ARBITER_FEE_MOTES = 300_000_000n; // must match demo_casper_panel_governance.ts's proposal
const PROVIDER_FUNDING_MOTES = 100_000_000_000n; // 100 CSPR — proven amount, see demo_casper_courtroom.ts
const STATE_FILE = new URL("../../demo-video/out_casper/panel_governance_state.json", import.meta.url);

interface PanelState {
  arbiterAccountHashes: string[];
  arbiterSecretsHex: string[];
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function waitForFinalization(rpc: InstanceType<typeof casperSdk.RpcClient>, txHash: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const info = await rpc.getTransactionByTransactionHash(txHash);
      const exec = info.executionInfo;
      if (exec?.executionResult) {
        const err = exec.executionResult.errorMessage;
        console.log(`  [${label}] finalized. errorMessage: ${err === null ? "null (success)" : err}`);
        return;
      }
      console.log(`  [${label}] attempt ${attempt + 1}: not finalized yet...`);
    } catch (e) {
      console.log(`  [${label}] attempt ${attempt + 1}: query failed —`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`  [${label}] gave up waiting for finalization after 30 attempts`);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.CASPER_RPC_URL!;
  const apiKey = process.env.CASPER_RPC_API_KEY;
  const chainName = process.env.CASPER_CHAIN_NAME ?? "casper-test";
  const contractHash = process.env.CASPER_CONTRACT_HASH!;

  const funderSigner = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const requester = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const providerKey = PrivateKey.generate(KeyAlgorithm.SECP256K1);

  const state: PanelState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const [arb1, arb2, arb3] = state.arbiterSecretsHex.map((hex) => PrivateKey.fromHex(hex, KeyAlgorithm.SECP256K1));

  const requesterAccountHash = requester.publicKey.accountHash().toPrefixedString();
  const providerAccountHash = providerKey.publicKey.accountHash().toPrefixedString();
  console.log("requester (signer 2):", requesterAccountHash);
  console.log("provider (fresh throwaway key):", providerAccountHash);
  console.log("provider secret (throwaway testnet key, safe to print):", Buffer.from(providerKey.toBytes()).toString("hex"));
  console.log("panel arbiters (from panel_governance_state.json):", state.arbiterAccountHashes);

  const handler = new HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  // Sanity check before spending anything: panel must actually be active.
  const panel = await client.getArbiterPanel();
  const threshold = await client.getPanelThreshold();
  console.log("\non-chain arbiter_panel:", panel, " panel_threshold:", threshold);
  if (panel.length === 0) {
    throw new Error("arbiter_panel is empty on-chain — run demo_casper_panel_governance.ts --execute first");
  }

  console.log("\n0. funding the fresh provider key with 100 CSPR from signer 1...");
  const transferTx = new NativeTransferBuilder()
    .from(funderSigner.publicKey)
    .target(providerKey.publicKey)
    .amount(PROVIDER_FUNDING_MOTES.toString())
    .id(Date.now())
    .chainName(chainName)
    .payment(100_000_000)
    .build();
  transferTx.sign(funderSigner);
  const transferResult = await rpc.putTransaction(transferTx);
  const transferTxHash = transferResult.transactionHash.toHex();
  console.log("  tx:", transferTxHash);
  await waitForFinalization(rpc, transferTxHash, "fund_provider");

  // This is a freshly redeployed contract (2026-07-25) — probe rather than assume, same
  // re-runnable-safe pattern demo_casper_courtroom.ts already established.
  let skillId = 1n;
  while ((await client.getSkill(skillId)) !== undefined) skillId += 1n;
  console.log(`\n1. register_skill (provider, will be skill_id=${skillId})...`);
  const reg = await client.registerSkill(providerKey, {
    name: "casper_panel_dispute_demo",
    description: "KARMA N-of-M panel arbitration proof-of-life on the custody-hardened Casper contract",
    mcpEndpoint: "https://demo.karma.local/mcp/panel-dispute",
    pricePerCallMotes: PRICE_PER_CALL_MOTES,
    minReputationToInvoke: 0,
    identityPolicy: 0,
  });
  console.log("  tx:", reg.txHash);
  await waitForFinalization(rpc, reg.txHash, "register_skill");

  let jobId = 1n;
  while ((await client.getJob(jobId)) !== undefined) jobId += 1n;
  const taskHash = sha256Hex(`KARMA casper panel dispute demo task ${Date.now()}`);
  console.log(`\n2. create_job (will be job_id=${jobId}; requester escrows 1 CSPR)...`);
  const job = await client.createJob(requester, {
    skillId,
    taskHashHex: taskHash,
    deadlineSecs: 3600n,
    escrowMotes: PRICE_PER_CALL_MOTES,
  });
  console.log("  tx:", job.txHash);
  await waitForFinalization(rpc, job.txHash, "create_job");

  const resultHash = sha256Hex(`KARMA casper panel dispute demo — deliberately contested result ${Date.now()}`);
  console.log("\n3. deliver_result (provider)...");
  const deliver = await client.deliverResult(providerKey, { jobId, resultHashHex: resultHash });
  console.log("  tx:", deliver.txHash);
  await waitForFinalization(rpc, deliver.txHash, "deliver_result");

  console.log("\n4. dispute_result_via_panel (requester posts dispute bond + panel fee)...");
  const dispute = await client.disputeResultViaPanel(requester, jobId, DISPUTE_BOND_MOTES + PANEL_ARBITER_FEE_MOTES);
  console.log("  tx:", dispute.txHash);
  await waitForFinalization(rpc, dispute.txHash, "dispute_result_via_panel");

  console.log("\n5. respond_to_dispute (provider matches the bond, enters arbitration)...");
  const respond = await client.respondToDispute(providerKey, jobId, DISPUTE_BOND_MOTES);
  console.log("  tx:", respond.txHash);
  await waitForFinalization(rpc, respond.txHash, "respond_to_dispute");

  console.log("\n6. cast_panel_vote (arb1 votes ProviderAtFault — 1 of 3, not yet settled)...");
  const vote1 = await client.castPanelVote(arb1, jobId, "ProviderAtFault");
  console.log("  tx:", vote1.txHash);
  await waitForFinalization(rpc, vote1.txHash, "cast_panel_vote_arb1");

  const jobAfterVote1 = await client.getJob(jobId);
  console.log("  getJob after 1st vote (expect still Disputed):", JSON.stringify(jsonSafe(jobAfterVote1)));

  console.log("\n7. cast_panel_vote (arb2 votes ProviderAtFault — 2 of 3, strict majority reached, settles)...");
  const vote2 = await client.castPanelVote(arb2, jobId, "ProviderAtFault");
  console.log("  tx:", vote2.txHash);
  await waitForFinalization(rpc, vote2.txHash, "cast_panel_vote_arb2");

  console.log("\nverifying final state...");
  const skill = await client.getSkill(skillId);
  const finalJob = await client.getJob(jobId);
  console.log(`  getSkill(${skillId}):`, JSON.stringify(jsonSafe(skill)));
  console.log(`  getJob(${jobId}):`, JSON.stringify(jsonSafe(finalJob)));

  const arb1Hash = arb1.publicKey.accountHash().toPrefixedString();
  const arb2Hash = arb2.publicKey.accountHash().toPrefixedString();
  const arb3Hash = arb3.publicKey.accountHash().toPrefixedString();
  console.log("\n  pendingWithdrawals — requester:", await client.pendingWithdrawalsOf(requesterAccountHash));
  console.log("  pendingWithdrawals — arb1 (voted):", await client.pendingWithdrawalsOf(arb1Hash));
  console.log("  pendingWithdrawals — arb2 (voted):", await client.pendingWithdrawalsOf(arb2Hash));
  console.log("  pendingWithdrawals — arb3 (did NOT vote, expect 0):", await client.pendingWithdrawalsOf(arb3Hash));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
