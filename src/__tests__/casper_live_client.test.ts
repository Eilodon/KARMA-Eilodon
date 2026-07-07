import { describe, it, expect, vi } from "vitest";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient, type CasperTransactionSubmitter } from "../lib/casper/live_client.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
const { CLValue } = casperSdk;

const SIGNER = deriveCasperPrivateKey(new Uint8Array(32).fill(0x33));
const CONTRACT_HASH = "hash-1111111111111111111111111111111111111111111111111111111111111111";

function fakeSubmitter(): CasperTransactionSubmitter & {
  putTransaction: ReturnType<typeof vi.fn>;
  getStateRootHashLatest: ReturnType<typeof vi.fn>;
  getDictionaryItemByIdentifier: ReturnType<typeof vi.fn>;
} {
  return {
    putTransaction: vi.fn().mockResolvedValue({ transactionHash: { toHex: () => "deadbeef" } }),
    getStateRootHashLatest: vi.fn().mockResolvedValue({ stateRootHash: { toHex: () => "srh" } }),
    getDictionaryItemByIdentifier: vi.fn().mockRejectedValue(new Error("not used in these tests")),
  };
}

describe("CasperLiveClient (T13-live)", () => {
  it("registerSkill signs and submits a real Transaction targeting the given contract hash + entry point", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const { txHash } = await client.registerSkill(SIGNER, {
      name: "rwa_price_oracle",
      description: "desc",
      mcpEndpoint: "casper-mcp://providers/rwa_price_oracle",
      pricePerCallMotes: 10_000_000n,
      minReputationToInvoke: 0,
      identityPolicy: 0,
    });

    expect(txHash).toBe("deadbeef");
    expect(rpc.putTransaction).toHaveBeenCalledOnce();
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("register_skill");
    expect(transaction.target.stored.id.byHash?.toHex()).toBe(
      CONTRACT_HASH.replace(/^hash-/, ""),
    );
    expect(transaction.args.getByName("name")?.toString()).toBe("rwa_price_oracle");
    expect(transaction.args.getByName("price_per_call")?.toString()).toBe("10000000");
    expect(transaction.approvals.length).toBeGreaterThan(0); // signed
  });

  it("depositBond attaches the bond amount via the `amount` runtime arg (Odra payable convention)", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await client.depositBond(SIGNER, 1_000_000_000n);
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("deposit_bond");
    expect(transaction.args.getByName("amount")?.toString()).toBe("1000000000");
  });

  it("createJob carries skill_id, task_hash, deadline_secs, and the escrow amount", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    const taskHashHex = "ab".repeat(32);
    await client.createJob(SIGNER, {
      skillId: 1n,
      taskHashHex,
      deadlineSecs: 259_200n,
      escrowMotes: 10_000_000n,
    });
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.entryPoint.customEntryPoint).toBe("create_job");
    expect(transaction.args.getByName("skill_id")?.toString()).toBe("1");
    expect(transaction.args.getByName("amount")?.toString()).toBe("10000000");
  });

  it("deliverResult / confirmCompletion / withdraw hit the right entry points", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    await client.deliverResult(SIGNER, { jobId: 1n, resultHashHex: "cd".repeat(32) });
    expect(rpc.putTransaction.mock.calls[0][0].entryPoint.customEntryPoint).toBe("deliver_result");

    await client.confirmCompletion(SIGNER, 1n);
    expect(rpc.putTransaction.mock.calls[1][0].entryPoint.customEntryPoint).toBe("confirm_completion");

    await client.withdraw(SIGNER);
    expect(rpc.putTransaction.mock.calls[2][0].entryPoint.customEntryPoint).toBe("withdraw");
  });

  it("uses the configured chain name and a caller-overridable payment ceiling", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient(
      { rpcUrl: "https://node.example", contractHash: CONTRACT_HASH, chainName: "casper-net-1", defaultPaymentMotes: 1n },
      rpc,
    );
    await client.withdraw(SIGNER, 42n);
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.chainName).toBe("casper-net-1");
    expect(transaction.pricingMode).toBeTruthy();
  });
});

describe("CasperLiveClient reads (T13-live, real dictionary-item derivation)", () => {
  const account = casperAccountHash(SIGNER);

  it("pendingWithdrawalsOf queries the state dictionary at the derived key and parses a U512", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: CLValue.newCLUInt512("123456789") },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const balance = await client.pendingWithdrawalsOf(account);

    expect(balance).toBe("123456789");
    expect(rpc.getStateRootHashLatest).toHaveBeenCalledOnce();
    const [stateRootHash, identifier] = rpc.getDictionaryItemByIdentifier.mock.calls[0];
    expect(stateRootHash).toBe("srh");
    expect(identifier.contractNamedKey.key).toBe(CONTRACT_HASH.replace(/^hash-/, ""));
    expect(identifier.contractNamedKey.dictionaryName).toBe("state");
    expect(identifier.contractNamedKey.dictionaryItemKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agentReputationOf parses a U32", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: CLValue.newCLUInt32(75) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.agentReputationOf(account)).toBe(75);
  });

  it("bondedOf parses a U512", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: CLValue.newCLUInt512("1000000000") },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.bondedOf(account)).toBe("1000000000");
  });

  it("returns the contract's documented defaults when the dictionary key has never been written", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    expect(await client.pendingWithdrawalsOf(account)).toBe("0");
    expect(await client.agentReputationOf(account)).toBe(50); // BASE_REPUTATION
    expect(await client.bondedOf(account)).toBe("0");
  });

  it("re-throws an unrelated RPC error instead of silently defaulting", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await expect(client.pendingWithdrawalsOf(account)).rejects.toThrow("ECONNREFUSED");
  });
});
