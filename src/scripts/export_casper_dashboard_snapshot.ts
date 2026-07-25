/**
 * Exports a read-only JSON snapshot of the live `AgentSkillRegistry` deployment — lock status,
 * governance configuration, arbiter panel, proposal count — for the judge-facing status strip in
 * `docs/media/casper-judges.html`. Same-origin `fetch()` reads this file; no browser ever talks
 * to the Casper RPC node directly (that path is CORS-blocked — verified against the real public
 * node, not assumed: `OPTIONS /rpc` returns 403 with no `Access-Control-Allow-Origin`). This
 * script is the thing that's actually allowed to call the RPC node — server-side, from a
 * scheduled GitHub Actions run (`.github/workflows/dashboard-snapshot.yml`), which then commits
 * the output here so Pages serves it as a plain static file.
 *
 * Read-only: no signer, no keystore, no funded account needed. Safe to run from CI on every tick.
 *
 *   CASPER_RPC_URL=https://node.testnet.casper.network KARMA_ODRA_REGISTRY=hash-2262a0a9... \
 *     pnpm exec tsx src/scripts/export_casper_dashboard_snapshot.ts [outFile]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CasperLiveClient } from "../lib/casper/live_client.js";

const OUT_FILE = process.argv[2] ?? "docs/media/dashboard/casper_status.json";

async function main(): Promise<void> {
  const rpcUrl = process.env.CASPER_RPC_URL;
  const contractHash = process.env.KARMA_ODRA_REGISTRY ?? process.env.CASPER_CONTRACT_HASH;
  if (!rpcUrl || !contractHash) {
    throw new Error(
      "[dashboard-snapshot] set CASPER_RPC_URL and KARMA_ODRA_REGISTRY (the deployed AgentSkillRegistry package hash)",
    );
  }
  const client = new CasperLiveClient({ rpcUrl, contractHash });

  const [lockStatus, arbiter, governanceSigners, governanceThreshold, timelockDelayMs, arbiterPanel, panelThreshold] =
    await Promise.all([
      client.getLockStatus(),
      client.getArbiter(),
      client.getGovernanceSigners(),
      client.getGovernanceThreshold(),
      client.getTimelockDelayMs(),
      client.getArbiterPanel(),
      client.getPanelThreshold(),
    ]);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    contractHash,
    network: process.env.CASPER_CHAIN_NAME ?? "casper-test",
    lockStatus: lockStatus ?? "unknown",
    governance: {
      signerCount: governanceSigners.length,
      threshold: governanceThreshold,
      timelockDelayMs: timelockDelayMs.toString(),
    },
    arbiter: arbiter ? `${arbiter.kind}-${arbiter.hashHex}` : null,
    arbiterPanel: {
      size: arbiterPanel.length,
      threshold: panelThreshold,
    },
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`[dashboard-snapshot] wrote ${OUT_FILE}`);
  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((err) => {
  console.error("[dashboard-snapshot] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
