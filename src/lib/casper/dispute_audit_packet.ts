/**
 * Dispute audit-packet builder — a compact, human-and-machine-readable record of one job's full
 * dispute/arbitration history, read live from the Casper `AgentSkillRegistry`.
 *
 * Borrowed pattern (buildathon competitor research, 2026-07-22): AgentLedger's downloadable
 * dispute audit-packet UX — a non-technical judge or counterparty shouldn't have to run MCP
 * tools by hand to understand "what happened to job N." This assembles the same on-chain reads
 * `casper_get_job` / `casper_get_dispute_info` / `casper_get_rationale_hash` already expose as
 * MCP tools into one artifact, plus a plain-language narrative of the outcome.
 *
 * Read-only — this module never signs or submits a transaction. `status` alone doesn't tell you
 * whether a job was disputed (`Refunded` also happens via `claim_refund` on an undelivered job
 * past its deadline, with no dispute involved) — `hasDispute` is derived from whether a
 * `DisputeInfo` record exists at all, not from `status`, which is why this is a small dedicated
 * module rather than a one-line formatter.
 */

import { createHash } from "node:crypto";
import type { CasperAddress, DecodedDisputeInfo, DecodedJob, DecodedSkill } from "./odra_codec.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface DisputeAuditPacketClient {
  getJob(jobId: bigint): Promise<DecodedJob | undefined>;
  getDisputeInfo(jobId: bigint): Promise<DecodedDisputeInfo | undefined>;
  getSkill(skillId: bigint): Promise<DecodedSkill | undefined>;
  getRationaleHash(jobId: bigint): Promise<string | undefined>;
  getArbiter(): Promise<CasperAddress | undefined>;
}

export interface DisputeAuditPacket {
  generatedAt: string;
  jobId: string;
  found: boolean;
  job: {
    requester: string;
    provider: string;
    skillId: string;
    skillName: string | null;
    escrowAmountMotes: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    evaluator: string | null;
    evaluatorFeeMotes: string | null;
    taskHashHex: string;
    resultHashHex: string;
  } | null;
  dispute: {
    disputeBondMotes: string;
    providerBondMotes: string;
    disputedAt: string;
    providerResponded: boolean;
    arbiter: string | null;
  } | null;
  attestedRationaleHash: string | null;
  narrative: string;
}

function addr(a: CasperAddress | undefined): string | null {
  if (!a) return null;
  return `${a.kind}:${a.hashHex}`;
}

function narrate(status: string, hasDispute: boolean, providerResponded: boolean): string {
  if (status === "Open") return "No dispute — job created, awaiting delivery.";
  if (status === "Delivered") return "No dispute — result delivered, requester's review window is open.";
  if (status === "Disputed") {
    return providerResponded
      ? "Dispute posted and matched by the provider — awaiting arbiter adjudication."
      : "Dispute posted by the requester — awaiting provider response (default = concede if the response window elapses).";
  }
  if (status === "Refunded") {
    return hasDispute
      ? "Adjudicated ProviderAtFault: the arbiter ruled for the requester — escrow, dispute bond, " +
          "and provider bond all refunded to the requester; provider reputation slashed."
      : "No dispute — requester reclaimed escrow via claim_refund after the job was never " +
          "delivered before its deadline.";
  }
  if (status === "Completed") {
    return hasDispute
      ? "Adjudicated RequesterAtFault (frivolous dispute): the arbiter ruled for the provider — " +
          "escrow settles as if completed, requester's dispute bond forfeits to the provider."
      : "No dispute — requester confirmed completion normally.";
  }
  return `Unrecognized status: ${status}.`;
}

export async function buildDisputeAuditPacket(
  client: DisputeAuditPacketClient,
  jobId: bigint,
): Promise<DisputeAuditPacket> {
  const generatedAt = new Date().toISOString();
  const job = await client.getJob(jobId);
  if (!job) {
    return {
      generatedAt,
      jobId: jobId.toString(),
      found: false,
      job: null,
      dispute: null,
      attestedRationaleHash: null,
      narrative: `No job found on-chain with id ${jobId}.`,
    };
  }

  const [dispute, skill, rationaleHash, arbiter] = await Promise.all([
    client.getDisputeInfo(jobId),
    client.getSkill(job.skillId),
    client.getRationaleHash(jobId),
    client.getArbiter(),
  ]);

  const hasDispute = dispute !== undefined;
  const providerResponded = hasDispute ? dispute.providerBondMotes > 0n : false;

  return {
    generatedAt,
    jobId: jobId.toString(),
    found: true,
    job: {
      requester: addr(job.requester)!,
      provider: addr(job.provider)!,
      skillId: job.skillId.toString(),
      skillName: skill?.name ?? null,
      escrowAmountMotes: job.escrowAmountMotes.toString(),
      status: job.status,
      createdAt: job.createdAt.toString(),
      completedAt: job.completedAt > 0n ? job.completedAt.toString() : null,
      evaluator: addr(job.evaluator),
      evaluatorFeeMotes: job.evaluatorFeeMotes > 0n ? job.evaluatorFeeMotes.toString() : null,
      taskHashHex: Buffer.from(job.taskHash).toString("hex"),
      resultHashHex: Buffer.from(job.resultHash).toString("hex"),
    },
    dispute: hasDispute
      ? {
          disputeBondMotes: dispute.disputeBondMotes.toString(),
          providerBondMotes: dispute.providerBondMotes.toString(),
          disputedAt: dispute.disputedAt.toString(),
          providerResponded,
          arbiter: job.status === "Disputed" || job.status === "Refunded" || job.status === "Completed"
            ? addr(arbiter)
            : null,
        }
      : null,
    attestedRationaleHash: rationaleHash ?? null,
    narrative: narrate(job.status, hasDispute, providerResponded),
  };
}

export interface ArtifactVerdict {
  onChainHex: string | null;
  recomputedHex: string | null;
  verdict: "match" | "mismatch" | "not_checked";
}

export interface AuditPacketVerification {
  resultHash: ArtifactVerdict;
  rationaleHash: ArtifactVerdict;
}

/** The chain only ever stores hash *commitments* (`resultHash`, `rationale_hash`) — genuinely
 *  verifying one means hashing the actual off-chain artifact (the signed receipt JSON, the
 *  plain-text rationale) and comparing, not just reading the commitment back. `jobId` alone
 *  is never enough for this; the artifact is a required second input. Same sha256 primitive
 *  every `attest_rationale`/`deliver_result` caller in this repo already uses (see
 *  `demo_casper_rwa_oracle_lifecycle_live.ts`) — not a new hashing convention. */
export function verifyAuditPacketArtifacts(
  packet: DisputeAuditPacket,
  artifacts: { resultArtifactJson?: string; rationaleArtifactText?: string } = {},
): AuditPacketVerification {
  const resultOnChain = packet.job?.resultHashHex ?? null;
  const resultRecomputed =
    artifacts.resultArtifactJson !== undefined ? sha256Hex(artifacts.resultArtifactJson) : null;
  const rationaleOnChain = packet.attestedRationaleHash;
  const rationaleRecomputed =
    artifacts.rationaleArtifactText !== undefined ? sha256Hex(artifacts.rationaleArtifactText) : null;
  return {
    resultHash: {
      onChainHex: resultOnChain,
      recomputedHex: resultRecomputed,
      verdict:
        resultRecomputed === null ? "not_checked" : resultOnChain === resultRecomputed ? "match" : "mismatch",
    },
    rationaleHash: {
      onChainHex: rationaleOnChain,
      recomputedHex: rationaleRecomputed,
      verdict:
        rationaleRecomputed === null
          ? "not_checked"
          : rationaleOnChain === rationaleRecomputed
            ? "match"
            : "mismatch",
    },
  };
}

export function renderAuditPacketMarkdown(packet: DisputeAuditPacket): string {
  const lines: string[] = [];
  lines.push(`# KARMA dispute audit packet — job ${packet.jobId}`, "");
  lines.push(`Generated: ${packet.generatedAt}`, "");
  if (!packet.found || !packet.job) {
    lines.push(packet.narrative);
    return lines.join("\n");
  }
  const j = packet.job;
  lines.push("## Job", "");
  lines.push(`- Skill: ${j.skillName ?? "(unknown)"} (id ${j.skillId})`);
  lines.push(`- Requester: \`${j.requester}\``);
  lines.push(`- Provider: \`${j.provider}\``);
  lines.push(`- Escrow: ${j.escrowAmountMotes} motes`);
  lines.push(`- Status: **${j.status}**`);
  lines.push(`- Task hash: \`${j.taskHashHex}\``);
  lines.push(`- Result hash: \`${j.resultHashHex}\``);
  lines.push(`- Created at: ${j.createdAt}`);
  if (j.completedAt) lines.push(`- Completed/resolved at: ${j.completedAt}`);
  if (j.evaluator) lines.push(`- Neutral evaluator: \`${j.evaluator}\` (fee: ${j.evaluatorFeeMotes} motes)`);
  lines.push("", "## Dispute", "");
  if (packet.dispute) {
    lines.push(`- Dispute bond (requester): ${packet.dispute.disputeBondMotes} motes`);
    lines.push(
      `- Provider bond: ${packet.dispute.providerBondMotes} motes` +
        (packet.dispute.providerResponded ? " (matched)" : " (not yet matched)"),
    );
    lines.push(`- Disputed at: ${packet.dispute.disputedAt}`);
    if (packet.dispute.arbiter) lines.push(`- Arbiter of record: \`${packet.dispute.arbiter}\``);
  } else {
    lines.push("No dispute was filed for this job.");
  }
  lines.push("", "## Attested rationale", "");
  lines.push(
    packet.attestedRationaleHash
      ? `Requester committed a rationale hash on-chain: \`${packet.attestedRationaleHash}\` ` +
          "(verify by re-hashing the plaintext rationale and comparing byte-for-byte)."
      : "No rationale was attested for this job.",
  );
  lines.push("", "## Outcome", "", packet.narrative, "");
  lines.push(
    "---",
    "*Every field above is a live, independently re-checkable on-chain read " +
      "(`casper_get_job` / `casper_get_dispute_info` / `casper_get_rationale_hash`) — " +
      "this packet is a convenience export, not a separate source of truth.*",
  );
  return lines.join("\n");
}
