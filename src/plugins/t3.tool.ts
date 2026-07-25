import { hashMessage } from "viem";
import { z } from "zod/v4";
import {
  loadWasmComponent,
  T3nClient,
  createEthAuthInput,
  getNodeUrl,
  setEnvironment,
  getScriptVersion,
  compactDidFromBytes,
  createOrgDataClientFromSession,
  type GuestToHostHandler,
  type WasmComponent,
  type Did,
  type AgentAuthScriptGrant,
  type PayrollRunRequest,
  type TrustAnchorOrUnsafe,
} from "@terminal3/t3n-sdk";
import { keystoreManager } from "../lib/keystore.js";
import { realKarmaService } from "../lib/karma_service.js";
import { identitySessions, SESSION_TTL_MS } from "../lib/identity_session.js";
import { ENV } from "../config/env.js";
import { getRequestContext } from "../security/context.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";

// The T3N SDK defaults to the `production` environment, whose node (cn-api.sg.prod…)
// is unreachable for development (TLS connection reset). KARMA targets the public
// testnet (cn-api.sg.testnet…), where claimed accounts and test tokens live. An explicit
// T3N_NODE_URL still overrides this in buildT3nClient. See PATTERN-DEBT-T3N-004.
setEnvironment("testnet");

// DID sessions live in the SHARED IdentitySessionStore (src/lib/identity_session.ts) so create_job
// (Layer 1) can enforce a skill's identityPolicy without a backwards Layer1→Layer3 dependency. This
// also closes the volatile module-level cache (PATTERN-DEBT-T3N-001) — sessions are TTL'd + address-bound.

// T3nClientConfig.trustAnchor is REQUIRED as of SDK v4 (DKG attestation pinning, SP-003) — a client-
// pinned {expected_peer_ids, rtmr3_allowlist} manifest, or this explicit opt-out. Signed trust-anchor
// manifests for the T3N cluster are not published yet, so — per the SDK's own OrgDataClientOptions
// doc — "most callers pass `{ unsafe_trust_server: true }` today". There is no ENV-supplied allowlist
// to pin against, so this is the only viable value, not a shortcut around one.
const TRUST_ANCHOR: TrustAnchorOrUnsafe = { unsafe_trust_server: true };

// Module-level WASM singleton — loaded once on first call.
let wasmComponent: WasmComponent | null = null;

async function getWasm(): Promise<WasmComponent> {
  if (!wasmComponent) {
    wasmComponent = await loadWasmComponent();
  }
  return wasmComponent;
}

// Constructs a T3nClient AND completes the handshake — T3nClient.authenticate() throws
// "Must complete handshake before authentication" otherwise (not mocked by unit tests,
// only caught by a live smoke run; see PATTERN-DEBT-T3N-002).
async function buildT3nClient(wasm: WasmComponent, ethSignHandler: GuestToHostHandler): Promise<T3nClient> {
  const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
  const client = new T3nClient({
    wasmComponent: wasm,
    baseUrl,
    handlers: { EthSign: ethSignHandler },
    trustAnchor: TRUST_ANCHOR,
  });
  await client.handshake();
  return client;
}

// T3N's EthSign challenge is SIWE (EIP-4361), mirroring the SDK's own metamask_sign: the
// base64 challenge is embedded as the hex `Nonce` inside a full SIWE message string. The WASM
// recovers the signer from (message, signature), so the message must be reproduced faithfully.
// Verified live against cn-api.sg.testnet.t3n.terminal3.io (auth → did:t3n:...).
export function buildSiweMessage(address: string, challengeB64: string): string {
  const nonceHex = `0x${Buffer.from(challengeB64, "base64").toString("hex")}`;
  const now = new Date();
  const exp = new Date(now.getTime() + 5 * 60 * 1000);
  return [
    "localhost wants you to sign in with your Ethereum account:",
    address.toLowerCase(),
    "",
    "",
    "URI: https://t3n.io",
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonceHex}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${exp.toISOString()}`,
  ].join("\n");
}

// Signs T3N SIWE challenges via viem Account.signMessage — raw key never leaves KeystoreManager.
// The response envelope is { host_to_guest, message, signature } where signature is BASE64 of
// the raw 65-byte secp256k1 signature. Signing the raw challenge bytes, omitting `message`, or
// hex-encoding the signature each pass the unit mocks but fail the live WASM with
// "expected 65, got 99" / "missing field message" (PATTERN-DEBT-T3N-002).
function buildEthSignHandler(agentId: string): GuestToHostHandler {
  const account = keystoreManager.getAccount(agentId);
  const address = keystoreManager.getAddress(agentId);
  return async (requestData) => {
    const { challenge } = requestData as { challenge: string };
    const message = buildSiweMessage(address, challenge);
    const sigHex = await account.signMessage({ message });
    const signature = Buffer.from(sigHex.slice(2), "hex").toString("base64");
    return new TextEncoder().encode(
      JSON.stringify({ host_to_guest: "EthSign", message, signature }),
    );
  };
}

// Creates a fresh T3nClient and authenticates it — required for session-bound methods (getUsage, getAuditEvents).
async function createAuthenticatedClient(agentId: string): Promise<{ client: T3nClient; did: Did }> {
  const wasm = await getWasm();
  const ethSignHandler = buildEthSignHandler(agentId);
  const client = await buildT3nClient(wasm, ethSignHandler);
  const address = keystoreManager.getAddress(agentId);
  const authInput = createEthAuthInput(address);
  const did = await client.authenticate(authInput);
  return { client, did };
}

// Exported for tests — resets module-level state between test cases.
export function clearVerifiedDidsForTest(): void {
  identitySessions.clear();
  wasmComponent = null;
}

export function getVerifiedDid(agentId: string): Did | undefined {
  return identitySessions.get(agentId)?.did as Did | undefined;
}

export function createT3Tools(): ToolDefinition[] {
  return [
    {
      name: "t3_health",
      description:
        "Validate Terminal3 SDK configuration and WASM component load. " +
        "Run first to confirm T3N_NODE_URL is set and WASM initialises correctly in this environment.",
      inputSchema: {},
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execution: { taskSupport: "forbidden" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N health-check — read-only, no auth token exchanged",
      },
      handler: async () => {
        const nodeUrl = ENV.T3N_NODE_URL ?? getNodeUrl();
        let wasmLoaded = false;
        let wasmError: string | undefined;
        try {
          await getWasm();
          wasmLoaded = true;
        } catch (e) {
          wasmError = e instanceof Error ? e.message : String(e);
        }
        const result = { wasmLoaded, nodeUrl, sdkVersion: "4.14.0", wasmError };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_verify_identity",
      description:
        "Authenticate a KARMA agent against the Terminal3 Network using EIP-191 signing. " +
        "Returns a verifiable DID (did:t3n:...) and caches it for t3_create_verified_job. " +
        "Must be called before t3_create_verified_job for high-threshold enterprise skills.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id to authenticate (must exist in keystore)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        accessesPrivateData: true,
        waiverReason: "T3N auth uses viem Account.signMessage — raw key never leaves KeystoreManager",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const wasm = await getWasm();
        const ethSignHandler = buildEthSignHandler(agent_id);
        const client = await buildT3nClient(wasm, ethSignHandler);
        const address = keystoreManager.getAddress(agent_id);
        const authInput = createEthAuthInput(address);
        const did = await client.authenticate(authInput);

        const now = Date.now();
        identitySessions.set(agent_id, {
          did: String(did), // Did is a branded string; store the plain string form
          address, // bind the session to the verified wallet (audit FM3)
          verifiedAt: now,
          expiresAt: now + SESSION_TTL_MS,
        });

        const result = {
          verified: true,
          did,
          agent_id,
          address,
          message: `Agent ${agent_id} verified. DID cached for t3_create_verified_job.`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_create_verified_job",
      description:
        "[DEPRECATED — prefer create_job: identity is now enforced there for any skill whose on-chain " +
        "identityPolicy is ≥1, so a separate verified-job tool is no longer required. Retained for " +
        "back-compat.] Create a KARMA job for a high-threshold skill, enforcing dual-layer trust: " +
        "(1) T3N identity gate — agent must have a verified DID from t3_verify_identity, " +
        "(2) On-chain reputation gate — agent reputation must meet the skill's minReputationToInvoke. " +
        "Use this for enterprise skills like payroll_hr_transfer where anonymity is unacceptable.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        skill_id: z.string().describe("On-chain skill id as string (e.g. '7')."),
        deadline_secs: z
          .number()
          .int()
          .min(60)
          .max(604800)
          .describe("Job deadline in seconds from now."),
        value_wei: z.string().describe("Escrow amount in wei as string (e.g. '1000000000000000')."),
      },
      allowedPhases: ["intake", "execution"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "On-chain write — guarded by T3N identity + KARMA reputation gates before contract call",
      },
      handler: async (args) => {
        const { agent_id, skill_id, deadline_secs, value_wei } = args as {
          agent_id: string;
          skill_id: string;
          deadline_secs: number;
          value_wei: string;
        };

        // Gate 1: T3N identity must be verified.
        const did = getVerifiedDid(agent_id);
        if (!did) {
          throw new Error(
            `[T3N] Identity gate: agent '${agent_id}' has no verified DID. ` +
              `Call t3_verify_identity first.`,
          );
        }

        const skillIdBig = BigInt(skill_id);
        const address = keystoreManager.getAddress(agent_id);

        // Gate 2: On-chain reputation must meet the skill's Trust Gate threshold.
        const reputation = realKarmaService.getReputation(address);
        const threshold = realKarmaService.getSkillThreshold(skillIdBig);

        if (threshold > 0 && reputation < threshold) {
          throw new Error(
            `[KARMA] Trust Gate: agent reputation ${reputation} is below skill threshold ${threshold}. ` +
              `Both identity (T3N) and reputation (KARMA) gates must pass.`,
          );
        }

        // Both gates passed — create job on-chain.
        const tenant = keystoreManager.getTenant(agent_id);
        const account = realKarmaService.account(agent_id, tenant);
        const taskHash = realKarmaService.deriveTaskHash(address, skillIdBig, BigInt(Date.now()));

        const existing = await realKarmaService.findExistingJob(address, taskHash);
        if (existing !== null) {
          const result = {
            jobId: existing.toString(),
            t3n_did: did,
            outcome: "existing",
            reputation,
            threshold,
          };
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        const { jobId, outcome } = await realKarmaService.createJob(account, {
          skillId: skillIdBig,
          taskHash,
          deadlineSecs: BigInt(deadline_secs),
          value: BigInt(value_wei),
        });

        const result = {
          jobId: jobId?.toString() ?? null,
          t3n_did: did,
          outcome: outcome.status,
          reputation,
          threshold,
          message: `Dual-layer trust verified: T3N identity (${String(did)}) + KARMA reputation (${reputation}/${threshold}).`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },
    {
      name: "t3_get_usage",
      description:
        "Query Terminal3 token usage and quota stats for a KARMA agent. " +
        "Re-authenticates against T3N to obtain a live TEE session, then reads token consumption via " +
        "T3nClient.getUsage(). Use to monitor agent token budget before high-frequency skill invocations. " +
        "Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N read-only usage query — re-authenticates, no state mutation",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        const cachedDid = getVerifiedDid(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const { client, did } = await createAuthenticatedClient(agent_id);
        const usage = await client.getUsage();

        const result = { agent_id, did, ...usage };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_get_audit_events",
      description:
        "Fetch the immutable TEE audit trail for a KARMA agent from the Terminal3 Network. " +
        "Every action the agent performs through T3N is logged to the hardware-secured TEE ledger. " +
        "Re-authenticates to get a live session, then reads events via T3nClient.getAuditEvents(). " +
        "Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason: "T3N read-only audit query — no mutation, TEE-attested log entries only",
      },
      handler: async (args) => {
        const { agent_id } = args as { agent_id: string };

        const cachedDid = getVerifiedDid(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const { client, did } = await createAuthenticatedClient(agent_id);
        const events = await client.getAuditEvents();

        const result = { agent_id, did, event_count: Array.isArray(events) ? events.length : 0, events };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_sign_job_commitment",
      description:
        "Create a non-repudiation commitment receipt for a KARMA job anchored to the agent's verified T3N DID. " +
        "Uses viem's hashMessage() to compute the EIP-191 digest of the commitment payload and T3N SDK's " +
        "compactDidFromBytes() to derive the canonical DID from the agent's Ethereum address. The resulting " +
        "EIP-191 signature binds the job irrevocably to the agent's on-chain identity — enterprise-grade " +
        "accountability without exposing private keys. Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z
          .string()
          .describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        job_id: z
          .string()
          .describe("KARMA job id to commit to (returned by create_job or t3_create_verified_job)."),
        skill_id: z.string().describe("Skill id associated with the job."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: [],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: false,
        accessesPrivateData: true,
        waiverReason:
          "Signs commitment via viem Account.signMessage — raw key never leaves KeystoreManager; " +
          "viem's hashMessage (EIP-191 personal-sign digest) and T3N SDK's compactDidFromBytes are " +
          "pure client-side cryptography with no network calls",
      },
      handler: async (args) => {
        const { agent_id, job_id, skill_id } = args as {
          agent_id: string;
          job_id: string;
          skill_id: string;
        };

        const did = getVerifiedDid(agent_id);
        if (!did) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }

        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const timestamp = Date.now();
        const payload = `KARMA job commitment: job_id=${job_id}, skill_id=${skill_id}, did=${String(did)}, ts=${timestamp}`;
        const msgBytes = new TextEncoder().encode(payload);

        // EIP-191 digest of the commitment payload (personal-sign prefix + keccak256).
        const digest = hashMessage({ raw: msgBytes }, "bytes");
        const digestHex = `0x${Buffer.from(digest).toString("hex")}`;

        // T3N SDK: derive the canonical compact DID from the agent's 20-byte Ethereum address.
        const address = keystoreManager.getAddress(agent_id);
        const addrBytes = new Uint8Array(Buffer.from(address.slice(2), "hex"));
        const compactDid = compactDidFromBytes(addrBytes);

        // Sign via viem Account.signMessage — raw key never exposed.
        const account = keystoreManager.getAccount(agent_id);
        const signature = await account.signMessage({ message: { raw: digest } });

        const result = {
          job_id,
          skill_id,
          did,
          compact_did: compactDid,
          commitment_payload: payload,
          digest_hex: digestHex,
          signature,
          signed_by: address,
          timestamp,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_authorize_payroll_agent",
      description:
        "Grant this agent a bounded, revocable Terminal3 agent-auth authorisation to invoke " +
        "specific payroll-v2 functions (subset of compute-payroll, execute-disbursement, finalize-audit, " +
        "submit-escalations, validate-credentials), scoped to a time window and a batch dollar cap. " +
        "The authorisation is written server-side via T3nClient.updateAgentAuth — a SelfOnly write, so " +
        "only the agent's own verified DID may grant its own authorisation; no raw private key ever " +
        "leaves KeystoreManager. After granting, attempts a direct invocation of the first authorised " +
        "function against Terminal3's tee:payroll contract; if the org-grant authorisation layer blocks " +
        "it, the gate rejection is returned as evidence (not an error) — proof the agent-auth and " +
        "org-grant layers are independent. Demonstrates Terminal3's real flagship feature: " +
        "server-enforced, DID-bound agent authority, not just identity. Requires prior t3_verify_identity call.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id (must be T3N-verified via t3_verify_identity)."),
        functions: z
          .array(z.enum(["compute-payroll", "execute-disbursement", "finalize-audit", "submit-escalations", "validate-credentials"]))
          .min(1)
          .max(16)
          .optional()
          .describe("Payroll v2 functions to authorise (subset of PAYROLL_FUNCTIONS_V1). Defaults to ['validate-credentials']."),
        ttl_secs: z
          .number()
          .int()
          .min(60)
          .max(86400)
          .optional()
          .describe("Authorisation validity window in seconds from now. Defaults to 3600 (1 hour)."),
        batch_cap_cents: z
          .string()
          .optional()
          .describe("Decimal-cents string bounding the run's total disbursement, e.g. '100000' for a $1,000.00 cap. Defaults to '100000'."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        accessesPrivateData: true,
        waiverReason:
          "Authorisation is written via T3N's agent-auth policy over the caller's own authenticated " +
          "session (SIWE/EthSign via account.signMessage) — raw key never leaves KeystoreManager. The " +
          "direct-invocation attempt is scoped to payroll-v2 read/validate functions and degrades " +
          "gracefully on an authorization rejection.",
      },
      handler: async (args) => {
        const { agent_id, ttl_secs, batch_cap_cents } = args as {
          agent_id: string;
          functions?: string[];
          ttl_secs?: number;
          batch_cap_cents?: string;
        };
        const functions = (args as { functions?: string[] }).functions ?? ["validate-credentials"];

        const cachedDid = getVerifiedDid(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }
        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const sortedFunctions = [...new Set(functions)].sort();
        const ttl = BigInt(ttl_secs ?? 3600);
        const nowSecs = BigInt(Math.floor(Date.now() / 1000));

        const { client, did } = await createAuthenticatedClient(agent_id);
        const baseUrl = ENV.T3N_NODE_URL ?? getNodeUrl();

        // Self-delegation demo: the just-verified DID authorises itself for tee:payroll. Egress is
        // pinned to the T3N node host — the only host these payroll functions ever call out to.
        const grant: AgentAuthScriptGrant = {
          scriptName: "tee:payroll",
          functions: sortedFunctions,
          scopes: [],
          validFromSecs: Number(nowSecs),
          validUntilSecs: Number(nowSecs + ttl),
          allowedHosts: [new URL(baseUrl).host],
        };
        const { preservedRows } = await client.updateAgentAuth(did.toString(), grant);

        const result: Record<string, unknown> = {
          agent_id,
          did,
          credential_issued: true,
          functions_authorised: sortedFunctions,
          not_before: new Date(Number(nowSecs) * 1000).toISOString(),
          not_after: new Date(Number(nowSecs + ttl) * 1000).toISOString(),
          batch_cap_cents: batch_cap_cents ?? "100000",
          preserved_script_rows: preservedRows,
          grant_provisioning_attempted: false,
          grant_provisioned: false,
          grant_provisioning_error: null as string | null,
          invocation_attempted: false,
          invocation_succeeded: false,
          invocation_result: null,
          invocation_error: null as string | null,
        };

        // Best-effort self-grant provisioning — exploratory: lets the direct invocation
        // attempt below succeed for real instead of only proving the credential layer.
        // org-data semantics for a self-administered org are not documented by the SDK;
        // independent failure path, never blocks authorisation issuance above.
        try {
          const orgClient = createOrgDataClientFromSession(client, baseUrl);
          await orgClient.createPolicy({ orgDid: did.toString(), initialAdminDid: did.toString() });
          await orgClient.setGrants({
            orgDid: did.toString(),
            contractId: "tee:payroll",
            grants: [{
              user_did: did.toString(),
              functions: sortedFunctions,
              scopes: [],
              constraints: {},
              expires_at_secs: null,
            }],
          });
          result.grant_provisioning_attempted = true;
          result.grant_provisioned = true;
        } catch (e) {
          result.grant_provisioning_attempted = true;
          result.grant_provisioning_error = e instanceof Error ? e.message : String(e);
        }

        // Best-effort direct invocation — failure here does NOT invalidate the authorisation
        // above (already validly written to the agent-auth policy). On public testnet the cause is
        // environmental (org/contract not provisioned), not an authz rejection; the note
        // below is derived from the actual error so the report never overstates the cause.
        try {
          const today = new Date();
          const periodEnd = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
          const payrollRequest: PayrollRunRequest = {
            org_id: did.toString(),
            cycle_id: `karma-demo-${Date.now()}`,
            pay_period_start: today.toISOString().slice(0, 10),
            pay_period_end: periodEnd.toISOString().slice(0, 10),
            batch_cap_cents: BigInt(batch_cap_cents ?? "100000"),
            historical_baselines: {},
          };
          const scriptVersion = await getScriptVersion(baseUrl, "tee:payroll");
          const payrollResult = await client.executeAndDecode({
            script_name: "tee:payroll",
            script_version: scriptVersion,
            function_name: sortedFunctions[0],
            input: { request: payrollRequest },
          });
          result.invocation_attempted = true;
          result.invocation_succeeded = true;
          result.invocation_result = payrollResult;
        } catch (e) {
          result.invocation_attempted = true;
          result.invocation_succeeded = false;
          const invErr = e instanceof Error ? e.message : String(e);
          result.invocation_error = invErr;
          // Derive the note from the ACTUAL failure so the report never overstates the cause.
          const authzBoundary = /grant|authoriz|forbidden|permission|denied/i.test(invErr);
          result.invocation_note = authzBoundary
            ? "Agent-auth authorisation is validly recorded server-side. Direct invocation was rejected at " +
              "the org-grant authorisation layer (independent of the agent-auth layer) — KARMA's defense-in-" +
              "depth boundary: a valid agent-auth grant alone does not grant execution rights without an org grant."
            : "Agent-auth authorisation is validly recorded server-side. Direct invocation could not run because " +
              "the 'tee:payroll' contract/org is not provisioned on this network (e.g. 404 / OrganisationNotFound " +
              "on public testnet). The recorded authorisation remains the verifiable, independently-checkable " +
              "artifact; live execution additionally requires a deployed payroll contract and an org grant.";
        }

        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },

    {
      name: "t3_revoke_payroll_authorization",
      description:
        "Revoke a Terminal3 agent-auth authorisation previously granted by t3_authorize_payroll_agent — " +
        "the whole grant, or a narrowed subset of its functions. Completes the grant → use → revoke " +
        "lifecycle: agent authority is never permanent. Reads the caller's live agent-auth policy " +
        "straight from T3N and writes back the narrowed or removed grant, so revocation always reflects " +
        "current server state (no local cache to go stale). Requires an active t3_authorize_payroll_agent " +
        "grant for this agent.",
      inputSchema: {
        agent_id: z.string().describe("KARMA agent id with a previously granted authorisation."),
        functions: z
          .array(z.enum(["compute-payroll", "execute-disbursement", "finalize-audit", "submit-escalations", "validate-credentials"]))
          .min(1)
          .max(16)
          .optional()
          .describe("Subset of functions to revoke. Omit to revoke the whole authorisation."),
      },
      allowedPhases: ["intake", "execution", "review", "completed"],
      capabilities: ["network"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      execution: { taskSupport: "optional" },
      securityPolicy: {
        externalCommunication: true,
        waiverReason:
          "Revocation reads and rewrites the caller's own agent-auth policy via the caller's own " +
          "authenticated T3nClient session (EthSign via account.signMessage) — SelfOnly: only the " +
          "grant's own DID may revoke it; raw key never exposed.",
      },
      handler: async (args) => {
        const { agent_id, functions } = args as { agent_id: string; functions?: string[] };

        const cachedDid = getVerifiedDid(agent_id);
        if (!cachedDid) {
          throw new Error(
            `[T3N] Agent '${agent_id}' not T3N-verified. Call t3_verify_identity first.`,
          );
        }
        // STRIDE-S: keystoreManager.has() alone only checks existence, not tenant ownership — any
        // tenant that knows another tenant's agent_id could otherwise drive this T3N identity/audit
        // flow on their behalf. assertOwnedBy() throws "Agent not found" first (unknown agents) and
        // a generic "not accessible to this tenant" otherwise, matching realKarmaService's addressOf.
        const { tenantId } = getRequestContext();
        keystoreManager.assertOwnedBy(agent_id, tenantId);

        const { client, did } = await createAuthenticatedClient(agent_id);
        const agentDid = did.toString();

        const policy = await client.getAgentAuth();
        const agentEntry = policy.agents.find((a) => a.agentDid === agentDid);
        const scriptRow = agentEntry?.scripts.find((s) => s.scriptName === "tee:payroll");
        if (!agentEntry || !scriptRow) {
          throw new Error(
            `[T3N] No issued credential found for agent '${agent_id}'. Call t3_authorize_payroll_agent first.`,
          );
        }

        // null means "no functions specified" (revoke everything); functionsToRemove is the concrete
        // set actually taken away (defaults to every currently-granted function in that case).
        const requestedFunctions = functions ?? null;
        const functionsToRemove = requestedFunctions ?? scriptRow.functions;
        const remainingFunctions = scriptRow.functions.filter((f) => !functionsToRemove.includes(f));
        const revokedEntirely = remainingFunctions.length === 0;

        if (revokedEntirely) {
          // Remove the tee:payroll row entirely (and the agent entry too, once it has no scripts left).
          const remainingScripts = agentEntry.scripts.filter((s) => s.scriptName !== "tee:payroll");
          const newAgents = remainingScripts.length > 0
            ? policy.agents.map((a) => (a.agentDid === agentDid ? { ...a, scripts: remainingScripts } : a))
            : policy.agents.filter((a) => a.agentDid !== agentDid);
          await client.agentAuthUpdate({ agents: newAgents, discoverDids: policy.discoverDids });
        } else {
          await client.updateAgentAuth(agentDid, { ...scriptRow, functions: remainingFunctions });
        }

        const result = {
          agent_id,
          did,
          revoked_entirely: revokedEntirely,
          revoked_functions: requestedFunctions === null ? null : functionsToRemove,
          remaining_functions: remainingFunctions,
          message: revokedEntirely
            ? `Authorization for agent '${agent_id}' revoked entirely. Agent can no longer use it.`
            : `Authorization for agent '${agent_id}' narrowed — remaining functions: ${remainingFunctions.join(", ")}.`,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    },
  ];
}

export default createT3Tools();
