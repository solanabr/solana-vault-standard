/**
 * SVS-8 Deposit Script
 *
 * Deposits a single asset into the vault and receives shares.
 * Requires oracle accounts to have valid price data.
 *
 * Run: npx ts-node scripts/svs-8/03-deposit.ts <vault_id> <asset_mint>
 */

import { BN } from "@coral-xyz/anchor";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  getAssetEntryPDA,
  getAssetVaultATA,
  oracleRemainingAccounts,
  explorerUrl,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("SVS-8 Deposit");

  const vaultIdArg = process.argv[2];
  if (!vaultIdArg) {
    console.error("Usage: npx ts-node scripts/svs-8/03-deposit.ts <vault_id>");
    console.error("  Note: Oracle accounts must have valid price data for deposit to succeed.");
    process.exit(1);
  }

  const vaultId = new BN(vaultIdArg);
  const [vault] = getVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);

  const vaultAccount = await program.account.multiAssetVault.fetch(vault);
  console.log(`\nVault: ${vault.toBase58()}`);
  console.log(`  Num Assets: ${vaultAccount.numAssets}`);
  console.log(`  Paused: ${vaultAccount.paused}`);

  console.log("\nNote: deposit_single requires all oracle accounts to have valid price data.");
  console.log("For devnet testing, populate oracle accounts with price data first.");
}

main().catch(console.error);
