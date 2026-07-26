/**
 * Browser entry point for `docs/media/casper_human_payer.html` (P3 — CSPR.click human-as-x402-payer
 * flow). Bundled to `docs/media/casper_human_payer.bundle.js` via `pnpm run build:human-payer-page`
 * (esbuild, browser target) — see that script in package.json.
 *
 * Deliberately imports the domain/type constants straight from `../plugins/x402_casper.js` (the
 * same module `CasperX402Plugin` itself signs with) instead of re-typing them here — this is the
 * whole point of exporting `SETTLEMENT_TOKEN_NAME`/`DOMAIN_VERSION`/`TRANSFER_WITH_AUTHORIZATION_TYPES`
 * from that file: one source of truth for the EIP-712 struct, not two hand-typed copies that could
 * silently drift (see that file's doc comments on those exports for why this matters).
 *
 * What this does NOT do: sign anything itself, hold any private key, or call any
 * `AgentSkillRegistry` method (governance-gated or otherwise) — it only builds a typed-data object
 * and asks the browser wallet (via CSPR.click's `window.csprclick.signTypedData`) to sign it, then
 * displays the resulting envelope for a human to copy into
 * `src/scripts/relay_casper_x402_envelope.ts`.
 */
import { PublicKey } from "casper-js-sdk";
import {
  SETTLEMENT_TOKEN_NAME,
  DOMAIN_VERSION,
  DEFAULT_DOMAIN_CHAIN_NAME,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  CASPER_TESTNET_CAIP2,
  type CasperX402SignedPayload,
} from "../plugins/x402_casper_shared.js";

interface ClickSignTypedDataResult {
  cancelled?: boolean;
  error?: string;
  publicKey?: string;
  signatureHex?: string;
}
interface ClickAccount {
  public_key: string;
}
interface ClickSDK {
  on(event: string, handler: (evt: { account: ClickAccount }) => void): void;
  off(event: string, handler: (evt: { account: ClickAccount }) => void): void;
  signTypedData(params: unknown, publicKey: string): Promise<ClickSignTypedDataResult>;
  appSettings: { badge_left: unknown };
}
declare global {
  interface Window {
    csprclick?: ClickSDK;
  }
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`[human-payer] missing #${id} in page`);
  return found as T;
}

function randomNonceHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bare 64-hex-char account hash, no `account-hash-` prefix, no tag byte. */
function bareAccountHashHex(publicKeyHex: string): string {
  return PublicKey.fromHex(publicKeyHex).accountHash().toHex().replace("account-hash-", "");
}

/** Bare account-hash hex (accepts `account-hash-...` prefixed or already-bare input). */
function normalizeBareAccountHash(raw: string): string {
  return raw.replace(/^account-hash-/, "");
}

/** `"00" + bareHex` — the exact string shape the official make-software/casper-x402
 *  `csprclick-x402` reference example passes as an EIP-712 "address"-typed field value (its own
 *  `accountHash` variable, and its `paymentRequirement.payTo`). The wallet's `signTypedData` does
 *  the actual KeyTag::Account + keccak256 encoding internally, driven by the "address" field type
 *  declared in `TRANSFER_WITH_AUTHORIZATION_TYPES` — this function only has to produce the same
 *  tagged-hex string shape the reference proves the wallet expects, not repeat that encoding. */
function toEip712AddressField(bareHex: string): string {
  return "00" + bareHex;
}

/** Safe-integer JS `number`, matching the reference example's own `parseAmount` — the official
 *  `csprclick-x402` example passes uint256 message fields as `number`, not `string`/`bigint`
 *  (see its `x402-utils.ts::parseAmount`); settlement-token amounts here are always small enough
 *  (well under 2^53) for that to be exact, and mirroring their proven-working shape beats
 *  guessing at an alternative the wallet SDK hasn't been observed accepting. */
function parseMotesAmount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid motes amount: ${value}`);
  }
  return parsed;
}

function setStatus(text: string): void {
  el<HTMLPreElement>("status").textContent = text;
}

let activePublicKeyHex: string | null = null;

function onSignedIn(evt: { account: ClickAccount }): void {
  activePublicKeyHex = evt.account.public_key;
  el<HTMLDivElement>("connected").textContent = `Connected: ${activePublicKeyHex}`;
  el<HTMLButtonElement>("sign-btn").disabled = false;
}
function onSignedOut(): void {
  activePublicKeyHex = null;
  el<HTMLDivElement>("connected").textContent = "Not connected.";
  el<HTMLButtonElement>("sign-btn").disabled = true;
}

function addClickListeners(): void {
  window.csprclick?.on("csprclick:signed_in", onSignedIn);
  window.csprclick?.on("csprclick:switched_account", onSignedIn);
  window.csprclick?.on("csprclick:signed_out", onSignedOut);
  window.csprclick?.on("csprclick:disconnected", onSignedOut);
}

async function handleSign(): Promise<void> {
  if (!activePublicKeyHex || !window.csprclick) {
    setStatus("Connect a wallet first.");
    return;
  }
  try {
    const payTo = el<HTMLInputElement>("pay-to").value.trim();
    const valueMotes = el<HTMLInputElement>("value-motes").value.trim();
    const settlementTokenPackageHash = el<HTMLInputElement>("token-hash").value.trim().replace(/^hash-/, "");
    if (!payTo || !valueMotes || !settlementTokenPackageHash) {
      setStatus("Fill in payTo, value (motes), and the settlement token hash first.");
      return;
    }

    const fromBareHex = bareAccountHashHex(activePublicKeyHex);
    const toBareHex = normalizeBareAccountHash(payTo);
    const value = parseMotesAmount(valueMotes);
    const validAfter = Math.floor(Date.now() / 1000) - 60;
    const validBefore = validAfter + 15 * 60;
    const nonce = randomNonceHex();

    const typedData = {
      domain: {
        name: SETTLEMENT_TOKEN_NAME,
        version: DOMAIN_VERSION,
        chain_name: DEFAULT_DOMAIN_CHAIN_NAME,
        contract_package_hash: settlementTokenPackageHash,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: toEip712AddressField(fromBareHex),
        to: toEip712AddressField(toBareHex),
        value,
        validAfter,
        validBefore,
        nonce,
      },
    };

    setStatus("Requesting signature from your wallet...");
    const res = await window.csprclick.signTypedData({ typedData, options: { returnHashArtifacts: true } }, activePublicKeyHex);
    if (res.cancelled || res.error || !res.signatureHex || !res.publicKey) {
      setStatus(`Signing failed or was cancelled: ${res.error ?? "no signature returned"}`);
      return;
    }

    const envelope: CasperX402SignedPayload = {
      x402Version: 2,
      scheme: "exact",
      network: CASPER_TESTNET_CAIP2,
      payload: {
        from: "account-hash-" + fromBareHex,
        to: "account-hash-" + toBareHex,
        value: valueMotes,
        validAfter,
        validBefore,
        nonce,
      },
      publicKeyHex: res.publicKey,
      signature: res.signatureHex,
    };

    el<HTMLTextAreaElement>("envelope-output").value = JSON.stringify(envelope, null, 2);
    setStatus("Signed. Copy the envelope below and relay it with: pnpm exec tsx src/scripts/relay_casper_x402_envelope.ts --envelope-file <file> --live");
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function main(): void {
  el<HTMLButtonElement>("sign-btn").disabled = true;
  el<HTMLButtonElement>("sign-btn").addEventListener("click", () => void handleSign());
  el<HTMLButtonElement>("copy-btn").addEventListener("click", () => {
    void navigator.clipboard.writeText(el<HTMLTextAreaElement>("envelope-output").value);
  });

  window.addEventListener("csprclick:loaded", () => {
    addClickListeners();
    if (window.csprclick) window.csprclick.appSettings.badge_left = null;
  });
}

main();
