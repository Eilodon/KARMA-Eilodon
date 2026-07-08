export const PATTERN_DEBT_IDS = [
  "DEBT-001",
  "DEBT-002",
  "DEBT-003",
  "DEBT-004",
  "DEBT-005",
  "DEBT-006",
  "DEBT-007",
] as const;

export type PatternDebtId = typeof PATTERN_DEBT_IDS[number];
export type PatternDebtStatus = "open" | "monitoring" | "partially_resolved" | "implemented";
export type PatternDebtUrgency = "documented" | "monitor" | "ready_to_implement" | "release_blocking" | "resolved";

export interface PatternDebtItem {
  id: PatternDebtId;
  key: string;
  title: string;
  status: PatternDebtStatus;
  urgency: PatternDebtUrgency;
  currentControl: string;
  limitation: string;
  resolutionTrigger: string;
  implementationGate: string;
  ownerHint: string;
  runtimeGuards: string[];
  nextAction: string;
}

const ITEMS: readonly PatternDebtItem[] = [
  {
    id: "DEBT-001",
    key: "plugin-os-isolation",
    title: "Plugin OS isolation",
    status: "open",
    urgency: "release_blocking",
    currentControl: "Plugin allowlist, optional SHA-256 allowlist, capability declarations, safe mode, manifest pinning, a pluggable runner interface, currentPluginIsolationLevel=process-best-effort by default, hardened child-process lifecycle, scrubbed worker environment without PATH, expanded JS-level escape/mutation guards, optional Node permission best-effort mode, and a production fail-closed gate for non-built-in plugins unless an explicit best-effort waiver is set.",
    limitation: "Policy mode is trusted-only and rejects non-built-ins, while the external child-process runner remains a best-effort process boundary rather than a full container, Wasmtime, or microVM isolation boundary.",
    resolutionTrigger: "A production-ready container, microVM, WASM, or equivalent runner enforces OS-level filesystem, network, process, environment, CPU, memory, timeout, and artifact egress boundaries.",
    implementationGate: "Do not implement an in-process pseudo-sandbox. External isolation must enforce egress allowlist, read-only mount, process/env isolation, seccomp/AppArmor or equivalent syscall boundary, CPU/memory quotas, timeout, and artifact egress policy before it can replace policy mode or close this debt.",
    ownerHint: "runtime-security",
    runtimeGuards: [
      "MCP_PLUGIN_ISOLATION_MODE defaults to external for non-built-ins; policy mode rejects non-built-ins instead of running them in-process.",
      "External plugin workers use a scrubbed allowlisted environment without PATH, NODE_OPTIONS, npm_config_* values, or inherited CI secrets.",
      "Plugin child processes use stderr caps, single-settle promise handling, listener cleanup, timeout/abort hard-stop, and worker send-and-exit semantics.",
      "JS-level guards block worker_threads.Worker, dgram, http2, raw net.Socket, VM APIs, process.dlopen, process.kill, DNS, inspector, cluster, child_process, and expanded filesystem mutation APIs.",
      "MCP_EXTERNAL_PLUGIN_NODE_PERMISSION=true enables node-permission-best-effort only on supported built JavaScript runtimes and never claims container isolation.",
      "Plugin manifest hash is pinned after startup when MCP_PLUGIN_PIN_MANIFEST=true.",
      "NODE_ENV=production with non-built-in plugins fails unless MCP_ALLOW_BEST_EFFORT_PLUGIN_SANDBOX=true documents a trusted-plugin waiver.",
    ],
    nextAction: "Keep DEBT-001 open until a real container/Wasmtime/microVM runner is implemented and tested as an OS/runtime isolation boundary.",
  },
  {
    id: "DEBT-002",
    key: "crypto-erasure",
    title: "Crypto erasure",
    status: "implemented",
    urgency: "resolved",
    currentControl: "smcp:v4:kms KMS-backed per-tenant/user DEK crypto-erasure is implemented (2026-06-14) across four ITenantKeyRegistry providers (LocalKeyRegistry dev/test, VaultKeyRegistry, AwsKmsKeyRegistry, GcpKmsKeyRegistry). EncryptionService seals state as smcp:v4:kms blobs (AES-256-GCM data key wrapped by the KMS KEK, opaque kid, key version) with smcp:v3:hkdf-tenant and smcp:v2:scrypt as backward-compatible fallbacks. Two-phase scheduleErasure (immediate disable + scheduled HSM/KMS key destruction) emits a CryptoErasureReceipt; rotateKey/disableKey/auditLog complete the lifecycle and receipts persist through FileAuditStore.",
    limitation: "AWS KMS Phase-2 key destruction lags Phase-1 disable by a mandatory 7-day minimum pending-deletion window (Vault/GCP destroy on schedule); LocalKeyRegistry is dev/test only and gives no real erasure guarantee.",
    resolutionTrigger: "A deployment needs a KMS provider beyond Vault/AWS/GCP, or a zero-window erasure SLA that AWS KMS's 7-day pending-deletion window cannot meet.",
    implementationGate: "Do not claim instant key destruction on AWS KMS (honor the 7-day pending window in receipts) and do not permit KMS_PROVIDER=local for production crypto-erasure. New providers must implement the full ITenantKeyRegistry lifecycle (seal/unseal, 2-phase scheduleErasure, rotate, audit) with round-trip + erasure tests.",
    ownerHint: "storage-security",
    runtimeGuards: [
      "Redis storage requires MCP_ENCRYPTION_KEY.",
      "smcp:v4:kms blobs cannot be decrypted without a wired ITenantKeyRegistry (KMS_PROVIDER).",
      "NODE_ENV=production with MCP_REQUIRE_CRYPTO_ERASURE=true rejects KMS_PROVIDER=local and requires vault/aws-kms/gcp provider config.",
      "Two-phase erasure: Phase 1 disables the key immediately (all decrypt attempts fail), Phase 2 schedules HSM/KMS key destruction.",
      "Legacy SHA-256 KDF decrypts only when MCP_ALLOW_LEGACY_SHA256_KDF=true for migration.",
    ],
    nextAction: "Monitor provider erasure receipts in production; extend only when a new KMS provider or a stricter erasure SLA is required.",
  },
  {
    id: "DEBT-003",
    key: "native-mcp-tasks",
    title: "Native MCP Tasks",
    status: "monitoring",
    urgency: "ready_to_implement",
    currentControl: "Task lifecycle is behind ITaskStore with MemoryTaskStore and RedisTaskStore; native tasks/get, tasks/update, tasks/cancel, input_required, inputRequests, and inputResponses are exposed through the isolated src/mcp/adapter boundary. SDK bumped to @modelcontextprotocol/server@2.0.0-beta.2 (2026-07-08): transport migrated to createMcpHandler/toNodeHandler (legacy:'reject'), which genuinely speaks the 2026-07-28 stateless envelope (verified empirically, replacing the self-declared-only NodeStreamableHTTPServerTransport wiring); the private _createRegisteredTool reach-around is gone (public execution.taskSupport is used instead).",
    limitation: "Private SDK hooks (setRawRequestHandler's _requestHandlers Map access for tasks/get, tasks/update, tasks/cancel, server/discover) are still isolated in src/mcp/adapter, unchanged by the beta.2 bump. Confirmed empirically (2026-07-08) that beta.2's tools/call result codec now strictly validates/re-tags a registerTool handler's return value: declaring execution.taskSupport:\"required\" makes the SDK hard-reject KARMA's raw {resultType:\"task\",taskId} signal (-32602 Invalid tools/call result) instead of passing it through untouched as alpha.2 did. 5 tests in http_tasks_conformance.test.ts are skipped pending this reconciliation (see DEBT-003 references there).",
    resolutionTrigger: "RESOLVED as of 2026-07-08: @modelcontextprotocol/server@2.0.0-beta.2 exposes stable public Tasks APIs for tasks/get, tasks/update, tasks/cancel (GetTaskRequestSchema/CancelTaskRequestSchema present in the schema table; taskSupport is now \"optional\"|\"required\" instead of hard-\"forbidden\"), canonical client capabilities (_meta envelope), and input_required resume semantics (InputRequiredResult, inputRequired/inputResponse, createRequestStateCodec). Remaining work is migrating KARMA's own native task-creation signal onto these primitives, not waiting on the SDK further.",
    implementationGate: "Do not reintroduce check_task_status or isAsync; migration tests must prove native task creation, polling, cancellation, TTL, ownership, and input_required resume behavior without private _requestHandlers or _createRegisteredTool access.",
    ownerHint: "protocol",
    runtimeGuards: [
      "src/mcp/adapter owns the SDK/protocol boundary.",
      "native Tasks preserve task ownership, cancellation, TTL, and terminal result retrieval.",
      "Task IDs and ownership gates are validated before result disclosure.",
      "No bespoke polling endpoint, check_task_status, or isAsync compatibility path is exposed.",
    ],
    nextAction: "Migrate KARMA's task-creation signal and setRawRequestHandler-based tasks/get|update|cancel onto the SDK's native Tasks primitives (InputRequiredResult, GetTaskRequestSchema, CancelTaskRequestSchema) while preserving ADR-006 exactly-once/idempotency guarantees in task_runtime.ts and task_store.ts. Re-enable the 5 skipped tests in http_tasks_conformance.test.ts as the acceptance gate.",
  },
  {
    id: "DEBT-004",
    key: "oauth-resource-indicator",
    title: "OAuth resource indicator enforcement",
    status: "implemented",
    urgency: "resolved",
    currentControl: "KARMA is treated as an OAuth Resource Server: JWT secret mode and OIDC JWKS mode validate issuer/audience as configured, enforce MCP_RESOURCE_URI against aud/resource claims when configured, publish protected resource metadata once, and enforce per-tool requiredScopes downstream.",
    limitation: "PKCE, TokenManager, authorization-code initiation, refresh-token rotation, and client login flows are intentionally absent because they belong to OAuth clients, not this resource server.",
    resolutionTrigger: "A future product explicitly adds a first-party OAuth client component separate from the resource server.",
    implementationGate: "Do not add TokenManager or server-side PKCE to the resource-server path. Any future OAuth client flow must be separate and tested independently.",
    ownerHint: "auth",
    runtimeGuards: [
      "HTTP transport requires explicit auth material.",
      "oidc_jwks over HTTP requires MCP_JWKS_URI plus issuer and audience.",
      "MCP_RESOURCE_URI rejects wrong-resource tokens before request context is returned.",
      "The protected resource metadata route remains /.well-known/oauth-protected-resource and is not duplicated.",
    ],
    nextAction: "Keep resource-server validation tests current; do not add PKCE/TokenManager to this server path.",
  },
  {
    id: "DEBT-005",
    key: "output-firewall-coverage",
    title: "Output firewall coverage",
    status: "partially_resolved",
    urgency: "monitor",
    currentControl: "Output firewall redacts common credentials, Luhn-valid payment cards, validated SSNs, prompt-injection markers, and sensitive values inside structuredContent through recursive non-mutating traversal with depth/node/string/cycle guards; structured-only violations still emit telemetry.",
    limitation: "PII detection remains deterministic and conservative by default; strict email/phone redaction is opt-in and no DLP/classifier backend is wired.",
    resolutionTrigger: "A sensitive deployment defines DLP policy, target entity types, confidence thresholds, latency budget, and audit requirements.",
    implementationGate: "Do not add a fake DLP adapter. Integrate a real backend only behind a measured policy boundary; tests must cover false positives, false negatives, latency timeout/fail-closed behavior, and structured-output redaction.",
    ownerHint: "data-safety",
    runtimeGuards: [
      "scanToolOutput runs before sanitizeResult and idempotency commit.",
      "Detected redactions emit output_firewall_redacted telemetry, including structuredContent-only violations.",
      "structuredContent recursive redaction preserves object/array shape and does not mutate input.",
      "Depth, node-count, per-string, total-string, and circular reference guards cap structured output traversal.",
      "MCP_OUTPUT_FIREWALL_PII_MODE defaults to credentials_only; strict mode redacts email/phone.",
    ],
    nextAction: "Keep deterministic regex/Luhn/structured coverage; add DLP only when a deployment is explicitly classified as sensitive.",
  },
  {
    id: "DEBT-006",
    key: "redis-trauma-registry",
    title: "Redis trauma registry",
    status: "implemented",
    urgency: "resolved",
    currentControl: "Memory and Redis rate limiters use bounded violation records with severity EMA and exponential backoff.",
    limitation: "Backoff policy is deterministic and conservative; it is not tuned from production incident data yet.",
    resolutionTrigger: "Production telemetry calibrates severity EMA/backoff thresholds by tenant risk tier.",
    implementationGate: "Tune only from production telemetry; do not replace bounded records with unbounded request timestamp sets.",
    ownerHint: "reliability",
    runtimeGuards: [
      "Redis rate limiter stores bounded trauma records.",
      "Exponential backoff is derived from violation_count and severity_ema.",
    ],
    nextAction: "Revisit after production traffic provides enough incident data for calibration.",
  },
  {
    id: "DEBT-007",
    key: "agent-key-erasure-boundary",
    title: "KARMA agent signing keys outside the KMS crypto-erasure boundary",
    status: "monitoring",
    urgency: "documented",
    currentControl: "KARMA agent signing keys are operator-provisioned Web3 Secret Storage v3 (scrypt+aes-128-ctr) entries in a keystore file, decrypted in-process by KeystoreManager (D-1, trusted built-in plugin). They are deliberately NOT sealed by EncryptionService / smcp:v4:kms (DEBT-002): those keys are infrastructure credentials shared by a tenant's agents, not per-tenant user state, and the `tenant` field on an entry is an authz binding (assertOwnedBy) — not a data-lifecycle owner. KeystoreManager.unload(agentId)/clear() drop decrypted viem accounts so GC can reclaim them, and graceful shutdown clears the in-memory map.",
    limitation: "The smcp:v4:kms crypto-erasure guarantee (delete a tenant ⇒ its sealed state becomes unrecoverable) does NOT extend to agent private keys: there is no tenant self-deletion flow in KARMA, and the keystore file is on disk outside KMS. viem's privateKeyToAccount also retains the key inside a closure that V8 cannot force-zero, so unload()/clear() shrink but do not provably erase the heap copy.",
    resolutionTrigger: "A deployment promises tenant-deletion crypto-erasure that must cover agent signing keys, OR adds tenant self-service agent provisioning/offboarding, OR requires guaranteed key zeroization (heap-dump / cold-boot threat in scope).",
    implementationGate: "Do not re-route agent keys through EncryptionService (wrong layer — that seals state blobs, not signing keys). True coverage needs an out-of-process signer / HSM / remote-signing KMS so the private key never enters this process, plus an offboarding runbook (remove keystore entry + unload() + rotate/abandon the on-chain key) wired to tenant lifecycle.",
    ownerHint: "key-management",
    runtimeGuards: [
      "Agent keys never leave KeystoreManager — only viem Account objects (which sign internally) are exposed.",
      "KeystoreManager runs in-process only (D-1); the canary assertInProcess blocks out-of-process execution.",
      "unload(agentId)/clear() drop decrypted accounts for offboarding and graceful shutdown.",
      "assertOwnedBy enforces tenant→agent authz before any signing account is handed out (STRIDE-S).",
    ],
    nextAction: "Keep documented until a deployment needs tenant-lifecycle key erasure or an out-of-process/HSM signer; pair any keystore-entry removal with unload() + on-chain key rotation.",
  },
] as const;

export interface PatternDebtQuery {
  includeImplemented?: boolean;
  id?: PatternDebtId;
}

export function getPatternDebtItems(query: PatternDebtQuery = {}): PatternDebtItem[] {
  return ITEMS
    .filter(item => query.includeImplemented || item.status !== "implemented")
    .filter(item => !query.id || item.id === query.id)
    .map(item => ({ ...item, runtimeGuards: [...item.runtimeGuards] }));
}

export function getPatternDebtSummary() {
  const visible = getPatternDebtItems({ includeImplemented: true });
  return {
    open: visible.filter(item => item.status === "open").length,
    monitoring: visible.filter(item => item.status === "monitoring").length,
    partiallyResolved: visible.filter(item => item.status === "partially_resolved").length,
    implemented: visible.filter(item => item.status === "implemented").length,
    activeIds: visible.filter(item => item.status !== "implemented").map(item => item.id),
  };
}

export function assertKnownPatternDebtId(id: string): asserts id is PatternDebtId {
  if (!(PATTERN_DEBT_IDS as readonly string[]).includes(id)) {
    throw new Error(`[KARMA] Unknown pattern debt id: ${id}`);
  }
}
