import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { markTrustedRuntime, resetTrustedRuntimeForTest } from "../core/runtime_identity.js";
import { deriveCasperPrivateKey, casperAccountHash } from "../lib/casper/keypair.js";
import type { CasperClientLike } from "../plugins/casper.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

const SIGNER = deriveCasperPrivateKey(new Uint8Array(32).fill(0x44));

vi.mock("../lib/keystore.js", () => ({
  keystoreManager: {
    has: vi.fn((id: string) => id === "agent-alpha"),
    getCasperKeypair: vi.fn(() => SIGNER),
  },
}));

// Dynamic import AFTER mocks are registered (same convention as t3_tool.test.ts).
const { createCasperTools } = await import("../plugins/casper.tool.js");

function fakeClient(over: Partial<CasperClientLike> = {}): CasperClientLike {
  return {
    registerSkill: vi.fn(async () => ({ txHash: "tx-register" })),
    depositBond: vi.fn(async () => ({ txHash: "tx-bond" })),
    createJob: vi.fn(async () => ({ txHash: "tx-createjob" })),
    deliverResult: vi.fn(async () => ({ txHash: "tx-deliver" })),
    confirmCompletion: vi.fn(async () => ({ txHash: "tx-confirm" })),
    withdraw: vi.fn(async () => ({ txHash: "tx-withdraw" })),
    pendingWithdrawalsOf: vi.fn(async () => "1000000"),
    agentReputationOf: vi.fn(async () => 55),
    bondedOf: vi.fn(async () => "2000000000"),
    ...over,
  };
}

function find(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("createCasperTools (T13-live MCP surface)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    markTrustedRuntime();
    delete process.env.CASPER_RPC_URL;
    delete process.env.CASPER_CONTRACT_HASH;
    delete process.env.KARMA_ODRA_REGISTRY;
    delete process.env.CASPER_CHAIN_NAME;
  });

  afterEach(() => {
    resetTrustedRuntimeForTest();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers exactly the 8 documented tools", () => {
    const names = createCasperTools(() => fakeClient()).map((t) => t.name);
    expect(names).toEqual([
      "casper_health",
      "casper_register_skill",
      "casper_deposit_bond",
      "casper_create_job",
      "casper_deliver_result",
      "casper_confirm_completion",
      "casper_withdraw",
      "casper_get_account_state",
    ]);
  });

  describe("casper_health", () => {
    it("reports configured=false when CASPER_RPC_URL/KARMA_ODRA_REGISTRY are unset", async () => {
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_health").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({ configured: false });
    });

    it("reports configured=true once both env vars are set", async () => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "11".repeat(32);
      const tools = createCasperTools(() => fakeClient());
      const result = await find(tools, "casper_health").handler({}, {} as never);
      expect(result.structuredContent).toMatchObject({ configured: true });
    });
  });

  describe("write tools — fail closed when Casper isn't configured", () => {
    it.each([
      ["casper_register_skill", { agentId: "agent-alpha", name: "x", pricePerCallMotes: "1" }],
      ["casper_deposit_bond", { agentId: "agent-alpha", amountMotes: "1" }],
      ["casper_withdraw", { agentId: "agent-alpha" }],
    ] as const)("%s throws a clear 'not configured' error", async (name, args) => {
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, name).handler(args, {} as never)).rejects.toThrow(/Casper not configured/);
    });
  });

  describe("write tools — happy path once configured", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "22".repeat(32);
    });

    it("casper_register_skill signs with the resolved agent key and returns the real tx hash", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_register_skill").handler(
        { agentId: "agent-alpha", name: "rwa_price_oracle", pricePerCallMotes: "10000000" },
        {} as never,
      );
      expect(client.registerSkill).toHaveBeenCalledWith(
        SIGNER,
        expect.objectContaining({ name: "rwa_price_oracle", pricePerCallMotes: 10_000_000n }),
      );
      expect(result.structuredContent).toMatchObject({ txHash: "tx-register" });
    });

    it("casper_create_job rejects a malformed task hash before ever touching the client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await expect(
        find(tools, "casper_create_job").handler(
          { agentId: "agent-alpha", skillId: "1", taskHashHex: "not-hex", deadlineSecs: "60", escrowMotes: "1" },
          {} as never,
        ),
      ).rejects.toThrow();
      expect(client.createJob).not.toHaveBeenCalled();
    });

    it("rejects an unknown agentId before constructing a client", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      await expect(
        find(tools, "casper_withdraw").handler({ agentId: "nobody" }, {} as never),
      ).rejects.toThrow(/not found in keystore/);
      expect(client.withdraw).not.toHaveBeenCalled();
    });
  });

  describe("casper_get_account_state", () => {
    beforeEach(() => {
      process.env.CASPER_RPC_URL = "https://node.example";
      process.env.KARMA_ODRA_REGISTRY = "hash-" + "33".repeat(32);
    });

    it("resolves the account hash from agentId and reads all three fields", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const result = await find(tools, "casper_get_account_state").handler({ agentId: "agent-alpha" }, {} as never);
      expect(result.structuredContent).toMatchObject({
        accountHash: casperAccountHash(SIGNER),
        pendingWithdrawalsMotes: "1000000",
        reputation: 55,
        bondedMotes: "2000000000",
      });
    });

    it("accepts a raw accountHash for reading an agent outside this keystore", async () => {
      const client = fakeClient();
      const tools = createCasperTools(() => client);
      const foreignHash = "account-hash-" + "99".repeat(32);
      const result = await find(tools, "casper_get_account_state").handler({ accountHash: foreignHash }, {} as never);
      expect(result.structuredContent).toMatchObject({ accountHash: foreignHash });
    });

    it("throws if neither agentId nor accountHash is given", async () => {
      const tools = createCasperTools(() => fakeClient());
      await expect(find(tools, "casper_get_account_state").handler({}, {} as never)).rejects.toThrow(
        /needs agentId or accountHash/,
      );
    });
  });
});
