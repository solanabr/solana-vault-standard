/**
 * SVS-10 CLI Devnet Verification
 *
 * Creates a fresh vault (vaultId=1), runs the full lifecycle via CLI commands.
 * Tests all 11 async CLI commands against the devnet-deployed program.
 *
 * Usage:
 *   ANCHOR_WALLET=<path> npx ts-node scripts/test-cli-devnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, Connection } from "@solana/web3.js";
import { createCli } from "../sdk/core/src/cli/index";
import { Svs10 } from "../target/types/svs_10";

const DEVNET_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = "149FyatCNUNW8FnfU6D4zBvieANZ7BEyFwDDA2wo96G9";
const VAULT_ID = "1";
const ASSET_DECIMALS = 6;

let passed = 0;
let failed = 0;

async function runCmd(args: string[]): Promise<boolean> {
  const label = args.slice(0, 4).join(" ");
  try {
    const program = createCli();
    // Prevent Commander from calling process.exit on errors
    program.exitOverride();
    await program.parseAsync(["node", "solana-vault", ...args]);
    console.log(`  OK    ${label}`);
    passed++;
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Commander exit override throws on --help etc — filter real failures
    if (msg.includes("(outputHelp)")) {
      console.log(`  OK    ${label}`);
      passed++;
      return true;
    }
    console.log(`  FAIL  ${label}: ${msg.slice(0, 120)}`);
    failed++;
    return false;
  }
}

async function main() {
  console.log("\nSVS-10 CLI Devnet Verification\n");

  // Setup: create a fresh vault with vaultId=1 via SDK (not CLI)
  const connection = new Connection(DEVNET_URL, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const payer = wallet.payer;

  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID}\n`);

  // Create asset mint
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null,
    ASSET_DECIMALS, Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );
  console.log(`Asset mint: ${assetMint.toBase58()}`);

  // Fund user
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey,
    false, undefined, undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection, payer, assetMint, userAta.address, payer.publicKey,
    2_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID,
  );

  // Initialize vault via SDK to get it on-chain
  const program = anchor.workspace.Svs10 as Program<Svs10>;
  const { AsyncVault } = await import("../sdk/core/src/async-vault");
  const vault = await AsyncVault.initialize(program, {
    assetMint,
    vaultId: new BN(VAULT_ID),
    cancelDelay: new BN(0),
    maxStaleness: new BN(3600),
  }, payer);
  console.log(`Vault:     ${vault.address.toBase58()}`);

  // Set operator
  await vault.setVaultOperator(payer, payer.publicKey);
  console.log(`Operator set to self\n`);

  const MINT = assetMint.toBase58();
  const OWNER = payer.publicKey.toBase58();
  const keypairPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const common = [
    "--program-id", PROGRAM_ID,
    "--asset-mint", MINT,
    "--vault-id", VAULT_ID,
    "-u", DEVNET_URL,
    "-k", keypairPath,
    "-y",
  ];
  // Use vault address as the argument (resolveVaultArg will re-derive from programId+assetMint+vaultId)
  const V = vault.address.toBase58();

  // === Test CLI commands ===

  // 1. show-request (no requests yet — should show empty/null)
  console.log("-- Read Commands --");
  await runCmd(["async", "show-request", V, "--owner", OWNER, ...common]);

  // 2. request-deposit (dry-run)
  console.log("\n-- Dry-Run Commands --");
  await runCmd(["async", "request-deposit", V, "-a", "1000000", ...common, "--dry-run"]);
  await runCmd(["async", "cancel-deposit", V, ...common, "--dry-run"]);
  await runCmd(["async", "claim-deposit", V, "--owner", OWNER, ...common, "--dry-run"]);
  await runCmd(["async", "request-redeem", V, "--shares", "500000000000", ...common, "--dry-run"]);
  await runCmd(["async", "cancel-redeem", V, ...common, "--dry-run"]);
  await runCmd(["async", "claim-redeem", V, "--owner", OWNER, ...common, "--dry-run"]);
  await runCmd(["async", "fulfill-deposit", V, "--owner", OWNER, ...common, "--dry-run"]);
  await runCmd(["async", "fulfill-redeem", V, "--owner", OWNER, ...common, "--dry-run"]);
  await runCmd(["async", "init-oracle", V, "--price", "1000000000", ...common, "--dry-run"]);
  await runCmd(["async", "update-oracle", V, "--price", "1050000000", ...common, "--dry-run"]);

  // 3. Real lifecycle via CLI
  console.log("\n-- Live Transaction Commands --");
  await runCmd(["async", "request-deposit", V, "-a", String(1000 * 10 ** ASSET_DECIMALS), ...common]);
  await runCmd(["async", "fulfill-deposit", V, "--owner", OWNER, ...common]);
  await runCmd(["async", "claim-deposit", V, "--owner", OWNER, ...common]);
  await runCmd(["async", "show-request", V, "--owner", OWNER, ...common]);

  // Summary
  const total = passed + failed;
  console.log(`\n========================================`);
  console.log(`  ${passed}/${total} CLI commands verified`);
  if (failed > 0) console.log(`  ${failed} FAILED`);
  console.log(`========================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
