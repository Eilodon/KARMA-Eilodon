/**
 * Print the Casper account-hash + public key for an agent already in the KARMA keystore,
 * so CSPR testnet funds can be sent to the address KARMA actually signs with — instead of
 * importing a foreign wallet's key into the keystore.
 *
 * Needs KEYSTORE_PATH + KEYSTORE_PASSWORD (never printed or logged). Run locally only:
 *
 *   KEYSTORE_PASSWORD=... pnpm exec tsx src/scripts/print_casper_address.ts [agentId]
 */
import { keystoreManager } from "../lib/keystore.js";

async function main(): Promise<void> {
  const keystorePath = process.env.KEYSTORE_PATH ?? "./keystore.json";
  const password = process.env.KEYSTORE_PASSWORD;
  if (!password) throw new Error("[print-casper-address] KEYSTORE_PASSWORD not set");

  await keystoreManager.load(keystorePath, password);
  const agentId = process.argv[2] ?? process.env.KARMA_AGENT_ID ?? keystoreManager.list()[0];
  if (!agentId) throw new Error("[print-casper-address] keystore has no agents loaded");

  console.log(`agentId          = ${agentId}`);
  console.log(`pharos address   = ${keystoreManager.getAddress(agentId)}`);
  console.log(`casper pubkey    = ${keystoreManager.getCasperPublicKeyHex(agentId)}`);
  console.log(`casper account   = ${keystoreManager.getCasperAccountHash(agentId)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
