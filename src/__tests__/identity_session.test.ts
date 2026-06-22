import { describe, it, expect } from "vitest";
import { MemoryIdentitySessionStore, type IdentitySession } from "../lib/identity_session.js";

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
