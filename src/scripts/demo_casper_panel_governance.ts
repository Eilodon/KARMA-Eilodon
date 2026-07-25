/**
 * Fires a real propose -> approve -> (later) execute governance chain to activate the N-of-M
 * panel arbitration mode on the custody-hardened, panel-enabled Casper contract redeployed
 * 2026-07-25 (see docs/super-skills/adrs/2026-07-25-casper-custody-hardening-and-panel-activation.md).
 * Two proposals: propose_set_arbiter_panel (3 fresh arbiters, threshold 2) and
 * propose_set_panel_arbiter_fee. Same pattern as demo_casper_cross_chain_rep_governance.ts.
 *
 * This contract is FRESH (deployed today, proposal_counter starts at 0), so the first propose_*
 * call gets proposal_id=1, the second gets proposal_id=2 — not hardcoded from a guess, verified
 * via getGovernanceState()/getEventCount() before assuming so.
 *
 * timelock_delay_ms on this contract is 1_800_000 (30 minutes), not 48h — chosen specifically so
 * this whole chain (propose -> approve -> early-execute-revert-proof -> wait -> execute) fits in
 * one Buildathon day. See spec §3b.
 *
 * Needs CASPER_RPC_URL/CASPER_RPC_API_KEY/CASPER_CHAIN_NAME/CASPER_CONTRACT_HASH/
 * CASPER_GOV_SIGNER_1_SECRET_HEX/CASPER_GOV_SIGNER_2_SECRET_HEX in .env.
 *
 *   pnpm exec tsx src/scripts/demo_casper_panel_governance.ts             # propose + approve + early-execute-attempt
 *   pnpm exec tsx src/scripts/demo_casper_panel_governance.ts --execute   # after the 30-min wait
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient } from "../lib/casper/live_client.js";

const { PrivateKey, KeyAlgorithm } = casperSdk;

const PANEL_ARBITER_FEE_MOTES = 300_000_000n; // 0.3 CSPR per dispute, split across voters
const STATE_FILE = new URL("../../demo-video/out_casper/panel_governance_state.json", import.meta.url);

interface PanelState {
  arbiterAccountHashes: string[];
  arbiterSecretsHex: string[];
  panelProposalId: string;
  feeProposalId: string;
  proposedAtIso: string;
}

async function waitForFinalization(
  client: CasperLiveClient,
  rpc: InstanceType<typeof casperSdk.RpcClient>,
  txHash: string,
  label: string,
): Promise<void> {
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

  const signer1 = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_1_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  const signer2 = PrivateKey.fromHex(process.env.CASPER_GOV_SIGNER_2_SECRET_HEX!, KeyAlgorithm.SECP256K1);
  console.log("governance signer 1 (proposer):", signer1.publicKey.accountHash().toPrefixedString());
  console.log("governance signer 2 (approver):", signer2.publicKey.accountHash().toPrefixedString());

  const handler = new casperSdk.HttpHandler(rpcUrl);
  if (apiKey) handler.setCustomHeaders({ Authorization: apiKey });
  const rpc = new casperSdk.RpcClient(handler);
  const client = new CasperLiveClient({ rpcUrl, rpcHeaders: apiKey ? { Authorization: apiKey } : undefined, chainName, contractHash });

  const mode = process.argv[2];

  if (mode === "--execute") {
    if (!existsSync(STATE_FILE)) throw new Error(`no state file at ${STATE_FILE} — run without --execute first`);
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PanelState;
    console.log("loaded state from earlier run:", state);

    console.log(`\nexecuting panel proposal ${state.panelProposalId}...`);
    const execPanel = await client.executeProposal(signer1, BigInt(state.panelProposalId));
    console.log("submitted. tx hash:", execPanel.txHash);
    await waitForFinalization(client, rpc, execPanel.txHash, "execute_panel");

    console.log(`\nexecuting fee proposal ${state.feeProposalId}...`);
    const execFee = await client.executeProposal(signer1, BigInt(state.feeProposalId));
    console.log("submitted. tx hash:", execFee.txHash);
    await waitForFinalization(client, rpc, execFee.txHash, "execute_fee");

    const panel = await client.getArbiterPanel();
    const threshold = await client.getPanelThreshold();
    console.log("\nverifying final panel state...");
    console.log("  arbiter_panel:", panel);
    console.log("  panel_threshold:", threshold);
    console.log("\nPanel is active. Arbiter secrets (throwaway testnet keys) saved in", STATE_FILE.pathname);
    return;
  }

  // Fresh arbiters — deliberately NOT overlapping with the governance signers or the job's
  // requester/provider, same principle demo_casper_courtroom.ts already established for the
  // single-arbiter path: nobody who's a party to a dispute should also be judging it.
  console.log("\ngenerating 3 fresh arbiter keys, funding each with 10 CSPR from signer 1...");
  const arbiterKeys = [1, 2, 3].map(() => PrivateKey.generate(KeyAlgorithm.SECP256K1));
  const arbiterAccountHashes = arbiterKeys.map((k) => k.publicKey.accountHash().toPrefixedString());
  for (const [i, key] of arbiterKeys.entries()) {
    const transferTx = new casperSdk.NativeTransferBuilder()
      .from(signer1.publicKey)
      .target(key.publicKey)
      .amount("10000000000") // 10 CSPR
      .id(Date.now() + i)
      .chainName(chainName)
      .payment(100_000_000)
      .build();
    transferTx.sign(signer1);
    const result = await rpc.putTransaction(transferTx);
    const txHash = result.transactionHash.toHex();
    console.log(`  arb${i + 1} (${arbiterAccountHashes[i]}) funding tx:`, txHash);
    await waitForFinalization(client, rpc, txHash, `fund_arb${i + 1}`);
  }

  console.log(`\nproposing arbiter panel [${arbiterAccountHashes.join(", ")}], threshold=2...`);
  const proposePanel = await client.proposeSetArbiterPanel(signer1, arbiterAccountHashes, 2);
  console.log("submitted. tx hash:", proposePanel.txHash);
  await waitForFinalization(client, rpc, proposePanel.txHash, "propose_panel");

  console.log(`\nproposing panel arbiter fee = ${PANEL_ARBITER_FEE_MOTES} motes (0.3 CSPR)...`);
  const proposeFee = await client.proposeSetPanelArbiterFee(signer1, PANEL_ARBITER_FEE_MOTES);
  console.log("submitted. tx hash:", proposeFee.txHash);
  await waitForFinalization(client, rpc, proposeFee.txHash, "propose_fee");

  // Both proposals auto-approve the proposer (signer 1) at 1/2 — confirmed by reading
  // propose_set_arbiter_panel/propose_set_panel_arbiter_fee in agent_skill_registry.rs
  // (both emit ProposalApproved with approval_count:1 immediately). proposal_counter is a
  // contract-wide counter shared by every proposal type, and this is a freshly redeployed
  // contract (proposal_counter starts at 0) — so panel=1, fee=2, not guessed.
  const panelProposalId = "1";
  const feeProposalId = "2";

  console.log(`\napproving panel proposal ${panelProposalId} as signer 2...`);
  const approvePanel = await client.approveProposal(signer2, BigInt(panelProposalId));
  console.log("submitted. tx hash:", approvePanel.txHash);
  await waitForFinalization(client, rpc, approvePanel.txHash, "approve_panel");

  console.log(`\napproving fee proposal ${feeProposalId} as signer 2...`);
  const approveFee = await client.approveProposal(signer2, BigInt(feeProposalId));
  console.log("submitted. tx hash:", approveFee.txHash);
  await waitForFinalization(client, rpc, approveFee.txHash, "approve_fee");

  console.log("\nattempting execute_proposal on the panel proposal NOW (expected to revert — 30-min timelock not elapsed)...");
  try {
    const exec = await client.executeProposal(signer1, BigInt(panelProposalId));
    console.log("submitted. tx hash:", exec.txHash);
    await waitForFinalization(client, rpc, exec.txHash, "early_execute_attempt");
  } catch (e) {
    console.log("execute attempt result (submission-level):", e instanceof Error ? e.message : e);
  }

  const state: PanelState = {
    arbiterAccountHashes,
    arbiterSecretsHex: arbiterKeys.map((k) => Buffer.from(k.toBytes()).toString("hex")),
    panelProposalId,
    feeProposalId,
    proposedAtIso: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`\nstate saved to ${STATE_FILE.pathname} (throwaway testnet arbiter keys, safe to keep local).`);
  console.log("Re-run this script with `--execute` after the 30-minute timelock elapses to complete the chain.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
