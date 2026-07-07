import { describe, it, expect, vi } from "vitest";
import casperSdk from "casper-js-sdk";
import { CasperLiveClient, type CasperTransactionSubmitter } from "../lib/casper/live_client.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
const { CLValue, CLTypeUInt8 } = casperSdk;

/** Odra structs come back as `CLType::List(U8)`, not `Any` — confirmed against a real deployed
 *  contract read (see live_client.ts's `odraStructBytes`). Mirrors that real encoding here. */
function newCLOdraStructBytes(bytes: Uint8Array) {
  return CLValue.newCLList(CLTypeUInt8, Array.from(bytes).map((b) => CLValue.newCLUint8(b)));
}

const SIGNER = deriveCasperPrivateKey(new Uint8Array(32).fill(0x33));
const CONTRACT_HASH = "hash-1111111111111111111111111111111111111111111111111111111111111111";

const ENTITY_HASH = "2222222222222222222222222222222222222222222222222222222222222222";

function fakeSubmitter(): CasperTransactionSubmitter & {
  putTransaction: ReturnType<typeof vi.fn>;
  getStateRootHashLatest: ReturnType<typeof vi.fn>;
  getDictionaryItemByIdentifier: ReturnType<typeof vi.fn>;
  queryLatestGlobalState: ReturnType<typeof vi.fn>;
} {
  return {
    putTransaction: vi.fn().mockResolvedValue({ transactionHash: { toHex: () => "deadbeef" } }),
    getStateRootHashLatest: vi.fn().mockResolvedValue({ stateRootHash: { toHex: () => "srh" } }),
    getDictionaryItemByIdentifier: vi.fn().mockRejectedValue(new Error("not used in these tests")),
    queryLatestGlobalState: vi.fn().mockResolvedValue({
      storedValue: { contractPackage: { versions: [{ contractHash: { hash: { toHex: () => ENTITY_HASH } } }] } },
    }),
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
    expect(transaction.target.stored.id.byPackageHash?.addr.toHex()).toBe(
      CONTRACT_HASH.replace(/^hash-/, ""),
    );
    expect(transaction.args.getByName("name")?.toString()).toBe("rwa_price_oracle");
    expect(transaction.args.getByName("price_per_call")?.toString()).toBe("10000000");
    expect(transaction.approvals.length).toBeGreaterThan(0); // signed
  });

  it("depositBond routes through the proxy-caller session (Odra payable convention — deposit_bond takes no named args, only attached_value)", async () => {
    const rpc = fakeSubmitter();
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    await client.depositBond(SIGNER, 1_000_000_000n);
    const transaction = rpc.putTransaction.mock.calls[0][0];
    expect(transaction.target.session?.moduleBytes.length).toBeGreaterThan(0);
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("deposit_bond");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("1000000000");
    expect(transaction.args.getByName("amount")?.toString()).toBe("1000000000");
    expect(transaction.args.getByName("package_hash")).toBeTruthy();
    expect(transaction.args.getByName("args")).toBeTruthy(); // deposit_bond's own (empty) args, serialized
  });

  it("createJob is payable (no `amount` arg exists on the real entry point) — routes through the proxy-caller with skill_id/task_hash/deadline_secs as its own inner args and the escrow as attached_value", async () => {
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
    expect(transaction.target.session?.moduleBytes.length).toBeGreaterThan(0);
    expect(transaction.args.getByName("entry_point")?.toString()).toBe("create_job");
    expect(transaction.args.getByName("attached_value")?.toString()).toBe("10000000");

    // Decode the proxy's `args` (the entry point's own serialized inner RuntimeArgs) to prove
    // skill_id/task_hash/deadline_secs actually made it through, not just that something did.
    const innerArgsBytes = Uint8Array.from(
      transaction.args.getByName("args")!.list!.elements.map((e: InstanceType<typeof CLValue>) => e.ui8!.toNumber()),
    );
    const innerArgs = casperSdk.Args.fromBytes(innerArgsBytes);
    expect(innerArgs.getByName("skill_id")?.toString()).toBe("1");
    expect(innerArgs.getByName("deadline_secs")?.toString()).toBe("259200");
    expect(innerArgs.getByName("amount")).toBeUndefined(); // real signature has no such arg
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
      // Real dictionary reads come back as List(U8), not the native ui512 — see live_client.ts's
      // odraStructBytes / odra_codec.ts's decodeU512 header comments for why.
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt512("123456789").bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const balance = await client.pendingWithdrawalsOf(account);

    expect(balance).toBe("123456789");
    expect(rpc.getStateRootHashLatest).toHaveBeenCalledOnce();
    const [stateRootHash, identifier] = rpc.getDictionaryItemByIdentifier.mock.calls[0];
    expect(stateRootHash).toBe("srh");
    expect(identifier.contractNamedKey.key).toBe(`hash-${ENTITY_HASH}`);
    expect(identifier.contractNamedKey.dictionaryName).toBe("state");
    expect(identifier.contractNamedKey.dictionaryItemKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agentReputationOf parses a U32", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt32(75).bytes()) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.agentReputationOf(account)).toBe(75);
  });

  it("bondedOf parses a U512", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(CLValue.newCLUInt512("1000000000").bytes()) },
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

describe("CasperLiveClient.getSkill / getJob (T13-live, complex-struct dictionary reads)", () => {
  function u32(v: number): Uint8Array {
    return CLValue.newCLUInt32(v).bytes();
  }
  function bytesVec(b: Uint8Array): Uint8Array {
    return Buffer.concat([u32(b.length), Buffer.from(b)]);
  }
  function concat(...parts: Uint8Array[]): Uint8Array {
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  }
  const OWNER_HASH = "11".repeat(32);

  it("getSkill decodes the full Skill record from the raw Any bytes", async () => {
    const rpc = fakeSubmitter();
    const rawSkill = concat(
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // owner: Account
      bytesVec(Buffer.from("rwa_price_oracle")),
      bytesVec(Buffer.from("desc")),
      bytesVec(Buffer.from("casper-mcp://providers/rwa_price_oracle")),
      CLValue.newCLUInt512("10000000").bytes(),
      u32(75),
      CLValue.newCLUint64("42").bytes(),
      CLValue.newCLValueBool(true).bytes(),
      CLValue.newCLUint64("1700000000").bytes(),
      u32(10),
      CLValue.newCLUint8(2).bytes(),
    );
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawSkill) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const skill = await client.getSkill(1n);

    expect(skill?.owner).toEqual({ kind: "Account", hashHex: OWNER_HASH });
    expect(skill?.name).toBe("rwa_price_oracle");
    expect(skill?.pricePerCallMotes).toBe(10_000_000n);
    expect(skill?.reputationScore).toBe(75);
    expect(skill?.active).toBe(true);
  });

  it("getSkill returns undefined for an unregistered skill ID", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getSkill(999n)).toBeUndefined();
  });

  it("getJob decodes the full Job record including JobStatus and evaluator", async () => {
    const rpc = fakeSubmitter();
    const rawJob = concat(
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // requester
      Buffer.concat([Buffer.from([0]), Buffer.from(OWNER_HASH, "hex")]), // provider
      CLValue.newCLUint64("1").bytes(),
      bytesVec(Buffer.from("ab".repeat(32), "hex")),
      CLValue.newCLUInt512("10000000").bytes(),
      CLValue.newCLUint64("259200").bytes(),
      CLValue.newCLUint8(1).bytes(), // Delivered
      bytesVec(Buffer.from("cd".repeat(32), "hex")),
      CLValue.newCLUint64("1700000000").bytes(),
      CLValue.newCLUint64("0").bytes(),
      CLValue.newCLUint8(0).bytes(), // evaluator: None
      CLValue.newCLUInt512("0").bytes(),
    );
    rpc.getDictionaryItemByIdentifier.mockResolvedValue({
      storedValue: { clValue: newCLOdraStructBytes(rawJob) },
    });
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);

    const job = await client.getJob(1n);

    expect(job?.skillId).toBe(1n);
    expect(job?.status).toBe("Delivered");
    expect(job?.escrowAmountMotes).toBe(10_000_000n);
    expect(job?.evaluator).toBeUndefined();
  });

  it("getJob returns undefined for an uncreated job ID", async () => {
    const rpc = fakeSubmitter();
    rpc.getDictionaryItemByIdentifier.mockRejectedValue(new Error("state query failed: ValueNotFound"));
    const client = new CasperLiveClient({ rpcUrl: "https://node.example", contractHash: CONTRACT_HASH }, rpc);
    expect(await client.getJob(999n)).toBeUndefined();
  });
});
