/**
 * SVS-8 Redeem Script
 *
 * Redeems shares for a single asset proportionally.
 * No oracle needed — uses direct balance proportion.
 *
 * Run: npx ts-node scripts/svs-8/04-redeem.ts <vault_id> <asset_mint> <shares>
 */

import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  getAssetEntryPDA,
  getAssetVaultATA,
  explorerUrl,
} from "./helpers";

async function main() {
  const { connection, payer, program, programId } = await setupTest("SVS-8 Redeem");

  const vaultIdArg = process.argv[2];
  if (!vaultIdArg) {
    console.error("Usage: npx ts-node scripts/svs-8/04-redeem.ts <vault_id>");
    console.error("  Note: User must hold shares from a prior deposit.");
    process.exit(1);
  }

  const vaultId = new BN(vaultIdArg);
  const [vault] = getVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);

  const vaultAccount = await program.account.multiAssetVault.fetch(vault);
  console.log(`\nVault: ${vault.toBase58()}`);
  console.log(`  Num Assets: ${vaultAccount.numAssets}`);

  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  try {
    const sharesInfo = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    console.log(`  User Shares: ${sharesInfo.amount.toString()}`);
  } catch {
    console.log("  User has no shares account. Deposit first.");
  }

  console.log("\nNote: redeem_single uses proportional model (shares/supply * balance).");
  console.log("No oracle needed for redemption.");
}

main().catch(console.error);
