/**
 * Export a dispute audit packet (JSON + Markdown) for one job on the live Casper
 * `AgentSkillRegistry` — a downloadable, independently re-checkable record of what happened to a
 * job, for a judge/counterparty who'd rather read one file than run MCP tools by hand.
 *
 * Requires the same live-read env every other `casper_get_*` tool needs: `CASPER_RPC_URL` +
 * `KARMA_ODRA_REGISTRY`. This is read-only — it never signs or submits anything, so no
 * `KEYSTORE_PATH`/`KEYSTORE_PASSWORD` is needed.
 *
 *   pnpm exec tsx src/scripts/export_dispute_audit_packet.ts --job 2
 *   pnpm exec tsx src/scripts/export_dispute_audit_packet.ts --job 2 --out dispute-2
 *
 * With `--result-artifact <file>` / `--rationale-artifact <file>`, also independently verifies
 * the on-chain `resultHash`/`rationale_hash` commitment against a local off-chain artifact (the
 * signed receipt JSON / plain rationale text) by recomputing sha256 and comparing — see
 * `verifyAuditPacketArtifacts` in `dispute_audit_packet.ts` for why the artifact is a required
 * second input (the chain only ever stores the hash commitment, never the payload).
 *
 * Every run also (unconditionally) writes `docs/media/dispute-packets/<jobId>.json` — the same
 * packet + verification result, shaped for `docs/media/verify.html`'s same-origin fetch, mirroring
 * the pattern `docs/media/casper-judges.html` already uses for its own pre-generated JSON snapshot.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { CasperLiveClient } from "../lib/casper/live_client.js";
import {
  buildDisputeAuditPacket,
  renderAuditPacketMarkdown,
  verifyAuditPacketArtifacts,
} from "../lib/casper/dispute_audit_packet.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const jobArg = argValue("--job");
  if (!jobArg) throw new Error("[export] usage: --job <id> [--out <basename>] [--result-artifact <file>] [--rationale-artifact <file>]");
  const jobId = BigInt(jobArg);
  const outBase = argValue("--out") ?? `dispute-audit-packet-job-${jobId}`;

  const rpcUrl = process.env.CASPER_RPC_URL;
  const contract = process.env.KARMA_ODRA_REGISTRY;
  if (!rpcUrl) throw new Error("[export] CASPER_RPC_URL not set");
  if (!contract) throw new Error("[export] KARMA_ODRA_REGISTRY not set");

  const client = new CasperLiveClient({
    rpcUrl,
    contractHash: contract,
    chainName: process.env.CASPER_CHAIN_NAME ?? "casper-test",
    rpcHeaders: process.env.CASPER_RPC_API_KEY ? { Authorization: process.env.CASPER_RPC_API_KEY } : undefined,
  });

  console.log(`[export] reading job ${jobId} live from ${contract} via ${rpcUrl}...`);
  const packet = await buildDisputeAuditPacket(client, jobId);

  const resultArtifactPath = argValue("--result-artifact");
  const rationaleArtifactPath = argValue("--rationale-artifact");
  const verification = verifyAuditPacketArtifacts(packet, {
    resultArtifactJson: resultArtifactPath ? await readFile(resultArtifactPath, "utf8") : undefined,
    rationaleArtifactText: rationaleArtifactPath ? await readFile(rationaleArtifactPath, "utf8") : undefined,
  });

  const jsonPath = `${outBase}.json`;
  const mdPath = `${outBase}.md`;
  await writeFile(jsonPath, JSON.stringify({ ...packet, verification }, null, 2) + "\n", "utf8");
  await writeFile(mdPath, renderAuditPacketMarkdown(packet) + "\n", "utf8");

  const verifyPageDir = "docs/media/dispute-packets";
  await mkdir(verifyPageDir, { recursive: true });
  const verifyPagePath = `${verifyPageDir}/${jobId}.json`;
  await writeFile(verifyPagePath, JSON.stringify({ ...packet, verification }, null, 2) + "\n", "utf8");

  console.log(`[export] wrote ${jsonPath}`);
  console.log(`[export] wrote ${mdPath}`);
  console.log(`[export] wrote ${verifyPagePath} (feeds docs/media/verify.html)`);
  console.log(`[export] outcome: ${packet.narrative}`);
  console.log(`[export] resultHash verdict: ${verification.resultHash.verdict}, rationaleHash verdict: ${verification.rationaleHash.verdict}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
