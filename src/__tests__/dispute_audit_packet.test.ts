import { describe, it, expect, vi } from "vitest";
import {
  buildDisputeAuditPacket,
  renderAuditPacketMarkdown,
  verifyAuditPacketArtifacts,
} from "../lib/casper/dispute_audit_packet.js";
import type { DisputeAuditPacketClient } from "../lib/casper/dispute_audit_packet.js";
import type { DecodedJob, DecodedDisputeInfo, DecodedSkill, CasperAddress } from "../lib/casper/odra_codec.js";

const acct = (hex: string): CasperAddress => ({ kind: "Account", hashHex: hex.repeat(32) });

function baseJob(overrides: Partial<DecodedJob> = {}): DecodedJob {
  return {
    requester: acct("11"),
    provider: acct("22"),
    skillId: 1n,
    taskHash: new Uint8Array(),
    escrowAmountMotes: 10_000_000n,
    deadline: 0n,
    status: "Completed",
    resultHash: new Uint8Array(),
    createdAt: 1_700_000_000n,
    completedAt: 1_700_100_000n,
    evaluator: undefined,
    evaluatorFeeMotes: 0n,
    ...overrides,
  };
}

function fakeClient(over: Partial<DisputeAuditPacketClient> = {}): DisputeAuditPacketClient {
  return {
    getJob: vi.fn(async () => undefined),
    getDisputeInfo: vi.fn(async () => undefined),
    getSkill: vi.fn(async (): Promise<DecodedSkill | undefined> => undefined),
    getRationaleHash: vi.fn(async () => undefined),
    getArbiter: vi.fn(async () => acct("aa")),
    ...over,
  };
}

const DISPUTE: DecodedDisputeInfo = {
  disputeBondMotes: 500_000n,
  providerBondMotes: 500_000n,
  disputedAt: 1_700_050_000n,
};

describe("buildDisputeAuditPacket", () => {
  it("reports not-found for a job that doesn't exist on-chain", async () => {
    const client = fakeClient();
    const packet = await buildDisputeAuditPacket(client, 999n);
    expect(packet.found).toBe(false);
    expect(packet.job).toBeNull();
    expect(packet.narrative).toContain("No job found");
  });

  it("no dispute — completed job narrates as a normal confirm", async () => {
    const client = fakeClient({ getJob: vi.fn(async () => baseJob({ status: "Completed" })) });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.dispute).toBeNull();
    expect(packet.narrative).toMatch(/No dispute — requester confirmed/);
  });

  it("Refunded WITHOUT a dispute record narrates as claim_refund, not adjudication", async () => {
    const client = fakeClient({ getJob: vi.fn(async () => baseJob({ status: "Refunded" })) });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.dispute).toBeNull();
    expect(packet.narrative).toMatch(/claim_refund/);
    expect(packet.narrative).not.toMatch(/[Aa]djudicated/);
  });

  it("Refunded WITH a dispute record narrates as ProviderAtFault adjudication", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob({ status: "Refunded" })),
      getDisputeInfo: vi.fn(async () => DISPUTE),
    });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.dispute).not.toBeNull();
    expect(packet.dispute?.providerResponded).toBe(true);
    expect(packet.narrative).toMatch(/ProviderAtFault/);
    expect(packet.dispute?.arbiter).toBe("Account:" + "aa".repeat(32));
  });

  it("Completed WITH a dispute record narrates as RequesterAtFault (frivolous)", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob({ status: "Completed" })),
      getDisputeInfo: vi.fn(async () => DISPUTE),
    });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.narrative).toMatch(/RequesterAtFault/);
  });

  it("Disputed with no provider bond yet narrates as awaiting response", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob({ status: "Disputed" })),
      getDisputeInfo: vi.fn(async () => ({ ...DISPUTE, providerBondMotes: 0n })),
    });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.dispute?.providerResponded).toBe(false);
    expect(packet.narrative).toMatch(/awaiting provider response/);
  });

  it("includes the attested rationale hash when present", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob()),
      getRationaleHash: vi.fn(async () => "ab".repeat(32)),
    });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.attestedRationaleHash).toBe("ab".repeat(32));
  });

  it("Markdown render includes the outcome narrative and job fields", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob({ status: "Refunded" })),
      getDisputeInfo: vi.fn(async () => DISPUTE),
    });
    const packet = await buildDisputeAuditPacket(client, 7n);
    const md = renderAuditPacketMarkdown(packet);
    expect(md).toContain("job 7");
    expect(md).toContain("ProviderAtFault");
    expect(md).toContain("500000 motes");
  });

  it("hex-encodes taskHash/resultHash onto the job record", async () => {
    const client = fakeClient({
      getJob: vi.fn(async () =>
        baseJob({ taskHash: new Uint8Array([0xde, 0xad]), resultHash: new Uint8Array([0xbe, 0xef]) }),
      ),
    });
    const packet = await buildDisputeAuditPacket(client, 1n);
    expect(packet.job?.taskHashHex).toBe("dead");
    expect(packet.job?.resultHashHex).toBe("beef");
  });
});

describe("verifyAuditPacketArtifacts", () => {
  it("reports not_checked for both fields when no artifact is supplied", async () => {
    const client = fakeClient({ getJob: vi.fn(async () => baseJob()) });
    const packet = await buildDisputeAuditPacket(client, 1n);
    const v = verifyAuditPacketArtifacts(packet);
    expect(v.resultHash.verdict).toBe("not_checked");
    expect(v.rationaleHash.verdict).toBe("not_checked");
  });

  it("MATCH when the supplied artifact hashes to the on-chain commitment", async () => {
    const resultHash = new Uint8Array(
      Buffer.from("ba299c51cd4cce8180785c0a3bf22f90d16293c5bee6360001558d65a95a0db5", "hex"),
    );
    const client = fakeClient({
      getJob: vi.fn(async () => baseJob({ resultHash })),
      getRationaleHash: vi.fn(async () => "bed49b6bbdd41dae532241948d564d9e7b930ff4acaf1a4aeff7ce4eb01e7fe6"),
    });
    const packet = await buildDisputeAuditPacket(client, 5n);
    const receiptJson =
      '{"feeds":[{"feed":"BTC/USD","price":"64603.00","timestamp":1785076056629,"source":"coingecko"},' +
      '{"feed":"UST-BILLS/AVG-YIELD","price":"3.71","timestamp":1785076058204,"source":"ustreasury"}],' +
      '"providerPublicKeyHex":"02034a7c7839fd6af86afac55c46b84780e89ddaf12af29df15809382af618a2c8cf",' +
      '"signatureHex":"0240f2d55e52f1e5bfdb5c61bcec893190498614e60921809adcb49134ab86f9335d9c42780e6a24e0670f64be6996b7fd33080bcc12c383b4dce8fb5767c97234"}';
    const v = verifyAuditPacketArtifacts(packet, { resultArtifactJson: receiptJson });
    expect(v.resultHash.verdict).toBe("match");
    expect(v.rationaleHash.verdict).toBe("not_checked");
  });

  it("MISMATCH when the supplied artifact was tampered with", async () => {
    const resultHash = new Uint8Array(
      Buffer.from("ba299c51cd4cce8180785c0a3bf22f90d16293c5bee6360001558d65a95a0db5", "hex"),
    );
    const client = fakeClient({ getJob: vi.fn(async () => baseJob({ resultHash })) });
    const packet = await buildDisputeAuditPacket(client, 5n);
    const v = verifyAuditPacketArtifacts(packet, { resultArtifactJson: '{"tampered":true}' });
    expect(v.resultHash.verdict).toBe("mismatch");
  });
});
