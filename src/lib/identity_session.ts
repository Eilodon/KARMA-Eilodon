import type { Address } from "viem";
import { ENV } from "../config/env.js";

/**
 * Shared Terminal3 DID session store (P0-b).
 *
 * Both Layer 1 (karma.tool.ts → create_job) and Layer 3 (t3.tool.ts → t3_verify_identity) import
 * this module, so create_job can ENFORCE a skill's on-chain identityPolicy without a backwards
 * Layer1→Layer3 dependency. `t3_verify_identity` writes a session here; `create_job` reads it.
 *
 * Identity cannot be verified on-chain (a did:t3n is proven via SIWE/WASM), so the gate is enforced
 * server-side, in-process — the on-chain identityPolicy flag is declarative policy, this store is the
 * enforcement state. A session is bound to the verified `address` so one agent cannot ride another's
 * verified DID (audit FM3). Expiry is fail-closed: an expired or absent session is treated as "not
 * verified" (audit FM2).
 *
 * This in-memory impl is correct for the current single-process deployment and closes the volatile
 * module-level cache (PATTERN-DEBT-T3N-001). A redis-backed impl is required only for multi-replica
 * and travels with that (gated) deploy (audit L2).
 */

export interface IdentitySession {
  did: string; // did:t3n:...
  address: Address; // the verified wallet this session was minted for
  verifiedAt: number; // epoch ms — basis for the policy=2 (FRESH) age check
  expiresAt: number; // epoch ms — hard TTL boundary
}

export interface IdentitySessionStore {
  set(agentId: string, s: IdentitySession): void;
  /** Live (non-expired) session for agentId, else null. Expired entries are evicted on read. */
  get(agentId: string, now?: number): IdentitySession | null;
  delete(agentId: string): void;
  clear(): void;
}

export class MemoryIdentitySessionStore implements IdentitySessionStore {
  private readonly m = new Map<string, IdentitySession>();

  set(agentId: string, s: IdentitySession): void {
    this.m.set(agentId, s);
  }

  get(agentId: string, now: number = Date.now()): IdentitySession | null {
    const s = this.m.get(agentId);
    if (!s) return null;
    if (now >= s.expiresAt) {
      this.m.delete(agentId); // fail-closed: evict the moment it lapses
      return null;
    }
    return s;
  }

  delete(agentId: string): void {
    this.m.delete(agentId);
  }

  clear(): void {
    this.m.clear();
  }
}

/** Process-wide session store. Single-process default (see module note for multi-replica). */
export const identitySessions: IdentitySessionStore = new MemoryIdentitySessionStore();

/** Hard session lifetime — how long a verified DID is honored before re-verification (D3). */
export const SESSION_TTL_MS = ENV.T3N_SESSION_TTL_SECS * 1000;
/** Max session age accepted for a policy=2 (T3N_VERIFIED_FRESH) skill — the high-assurance tier (D3). */
export const SESSION_FRESH_MAX_AGE_MS = ENV.T3N_SESSION_FRESH_MAX_AGE_SECS * 1000;
