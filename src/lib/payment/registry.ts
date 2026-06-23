import type { IPaymentPlugin, SettlementRail } from "./plugin.js";

/**
 * In-process registry of `IPaymentPlugin` implementations (Phase 0).
 *
 * Single-process default — matches the existing `identitySessions` pattern (`src/lib/identity_session.ts`).
 * A redis-backed parity is out of scope until multi-replica deployment lands. Registrations are
 * fail-loud on duplicate id (a silent overwrite would let a later boot-order swap the active plugin).
 */
export class PaymentPluginRegistry {
  private readonly byId = new Map<string, IPaymentPlugin>();

  /** Register a plugin. Throws on a duplicate id (no silent overwrite). */
  register(p: IPaymentPlugin): void {
    if (this.byId.has(p.id)) {
      throw new Error(`[KARMA] payment plugin '${p.id}' already registered`);
    }
    this.byId.set(p.id, p);
  }

  /** All plugins implementing a given rail (e.g. every x402 implementation across chains). */
  byRail(rail: SettlementRail): IPaymentPlugin[] {
    return [...this.byId.values()].filter((p) => p.rail === rail);
  }

  /** Unique plugin matching a (rail, network) pair, or null. Exact-match on the network string. */
  resolve(rail: SettlementRail, network: string): IPaymentPlugin | null {
    for (const p of this.byId.values()) {
      if (p.rail === rail && p.networks.includes(network)) return p;
    }
    return null;
  }

  /** All registered plugins — used by `discover_skills` to surface `payment_options` per skill. */
  list(): IPaymentPlugin[] {
    return [...this.byId.values()];
  }

  /** Reset state (tests + boot-time re-init). */
  clear(): void {
    this.byId.clear();
  }
}

/** Process-wide registry. Plugins are registered at boot (see `src/index.ts`). */
export const paymentPlugins = new PaymentPluginRegistry();
