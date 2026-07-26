import { describe, it, expect } from "vitest";
import { MemoryIdentitySessionStore, checkIdentityGate, SESSION_FRESH_MAX_AGE_MS, type IdentitySession } from "../lib/identity_session.js";

const ADDR = "0x1111111111111111111111111111111111111111" as const;

function session(over: Partial<IdentitySession> = {}): IdentitySession {
  const now = 1_000_000;
  return { did: "did:t3n:abc", address: ADDR, verifiedAt: now, expiresAt: now + 600_000, ...over };
}

describe("MemoryIdentitySessionStore", () => {
  it("roundtrips a live session", () => {
    const s = new MemoryIdentitySessionStore();
    const sess = session();
    s.set("agent-alpha", sess);
    expect(s.get("agent-alpha", sess.verifiedAt + 1)).toEqual(sess);
  });

  it("returns null and evicts an expired session (fail-closed)", () => {
    const s = new MemoryIdentitySessionStore();
    const sess = session({ verifiedAt: 0, expiresAt: 100 });
    s.set("agent-alpha", sess);
    // at exactly expiresAt → expired (>= boundary)
    expect(s.get("agent-alpha", 100)).toBeNull();
    // evicted: a later read with a fresh clock still null (entry removed, not just filtered)
    expect(s.get("agent-alpha", 50)).toBeNull();
  });

  it("returns null for an unknown agent", () => {
    const s = new MemoryIdentitySessionStore();
    expect(s.get("nobody")).toBeNull();
  });

  it("delete removes a live session", () => {
    const s = new MemoryIdentitySessionStore();
    const sess = session();
    s.set("a", sess);
    s.delete("a");
    expect(s.get("a", sess.verifiedAt + 1)).toBeNull();
  });

  it("clear wipes all sessions", () => {
    const s = new MemoryIdentitySessionStore();
    s.set("a", session());
    s.set("b", session());
    s.clear();
    expect(s.get("a")).toBeNull();
    expect(s.get("b")).toBeNull();
  });
});

describe("checkIdentityGate (P0-2, shared across chains)", () => {
  const NOW = 1_000_000;

  it("policy 0: always allowed, even with no session", () => {
    expect(checkIdentityGate(0, null, ADDR, NOW)).toEqual({ ok: true });
  });

  it("policy 1: rejects identity_required when no session exists", () => {
    expect(checkIdentityGate(1, null, ADDR, NOW)).toEqual({ ok: false, reason: "identity_required" });
  });

  it("policy 1: rejects identity_required when the session's address doesn't match boundAddress", () => {
    const sess = session({ address: "0x2222222222222222222222222222222222222222" });
    expect(checkIdentityGate(1, sess, ADDR, NOW)).toEqual({ ok: false, reason: "identity_required" });
  });

  it("policy 1: accepts a session bound to the same address (case-insensitive)", () => {
    const sess = session({ address: ADDR.toUpperCase() as typeof ADDR });
    expect(checkIdentityGate(1, sess, ADDR, NOW)).toEqual({ ok: true });
  });

  it("policy 2: rejects identity_stale once the session is older than SESSION_FRESH_MAX_AGE_MS", () => {
    const sess = session({ verifiedAt: NOW - SESSION_FRESH_MAX_AGE_MS - 1 });
    expect(checkIdentityGate(2, sess, ADDR, NOW)).toEqual({ ok: false, reason: "identity_stale" });
  });

  it("policy 2: accepts a session within SESSION_FRESH_MAX_AGE_MS", () => {
    const sess = session({ verifiedAt: NOW - SESSION_FRESH_MAX_AGE_MS + 1 });
    expect(checkIdentityGate(2, sess, ADDR, NOW)).toEqual({ ok: true });
  });

  it("policy >2: fails closed to identity_policy_unknown even with a perfectly fresh session", () => {
    const sess = session({ verifiedAt: NOW });
    expect(checkIdentityGate(3, sess, ADDR, NOW)).toEqual({ ok: false, reason: "identity_policy_unknown" });
  });

  it("cross-chain binding: boundAddress must be the agent's EVM address, never a chain-specific representation — a Casper account-hash string never matches session.address, so it would always reject", () => {
    const sess = session({ address: ADDR });
    const casperAccountHashString = "account-hash-" + "aa".repeat(32);
    expect(checkIdentityGate(1, sess, casperAccountHashString as typeof ADDR, NOW)).toEqual({
      ok: false,
      reason: "identity_required",
    });
    // The correct binding (the same EVM address the session was minted for) passes.
    expect(checkIdentityGate(1, sess, ADDR, NOW)).toEqual({ ok: true });
  });
});
