/**
 * SVS-8 Initialize Script
 *
 * Creates a multi-asset vault with 6-decimal base (USD).
 *
 * Run: npx ts-node scripts/svs-8/01-initialize.ts
 */

import { BN } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  setupTest,
  getVaultPDA,
  getSharesMintPDA,
  explorerUrl,
  accountUrl,
} from "./helpers";

const BASE_DECIMALS = 6;

async function main() {
  const { connection, payer, program, programId } = await setupTest("SVS-8 Initialize");

  const vaultId = new BN(Date.now());
  const [vault] = getVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);

  console.log("\n" + "-".repeat(70));
  console.log("Initializing Multi-Asset Vault");
  console.log("-".repeat(70));
  console.log(`  Vault ID: ${vaultId.toString()}`);
  console.log(`  Vault PDA: ${vault.toBase58()}`);
  console.log(`  Shares Mint: ${sharesMint.toBase58()}`);
  console.log(`  Base Decimals: ${BASE_DECIMALS}`);

  const tx = await program.methods
    .initialize(vaultId, BASE_DECIMALS)
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      sharesMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  console.log(`\n  TX: ${explorerUrl(tx)}`);

  const vaultAccount = await program.account.multiAssetVault.fetch(vault);
  console.log(`  Authority: ${vaultAccount.authority.toBase58()}`);
  console.log(`  Num Assets: ${vaultAccount.numAssets}`);
  console.log(`  Paused: ${vaultAccount.paused}`);
  console.log(`  Decimals Offset: ${vaultAccount.decimalsOffset}`);

  console.log("\nDone. Use vault_id and vault PDA for subsequent scripts.");
}

main().catch(console.error);
