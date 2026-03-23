/**
 * SVS-10 Inflation/Donation Attack Test
 *
 * Tests virtual offset protection (1e6 virtual shares/assets) against the
 * classic ERC-4626 inflation attack adapted for async lifecycle:
 * 1. Attacker requests deposit of 1 token, operator fulfills, attacker claims
 * 2. Attacker donates large amount directly to vault ATA (bypassing deposit)
 * 3. Victim requests deposit — should NOT be diluted
 *
 * Run: npx ts-node scripts/svs-10/inflation-attack.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
} from "../../sdk/core/src/async-vault-pda";
import {
  baseSetup,
  fundAccounts,
  explorerUrl,
} from "../shared/common-helpers";
import * as path from "path";
import * as fs from "fs";

const ASSET_DECIMALS = 6;
const SHARE_DECIMALS = 9;

async function main() {
  const { connection, payer, provider, programId } = await baseSetup({
    testName: "Inflation/Donation Attack",
    moduleName: "SVS-10",
    idlPath: path.join(__dirname, "../../target/idl/svs_10.json"),
    programKeypairPath: path.join(__dirname, "../../target/deploy/svs_10-keypair.json"),
    minBalanceSol: 1,
  });

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../../target/idl/svs_10.json"), "utf-8"));
  const program = new Program(idl, provider);

  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  console.log(`Attacker: ${attacker.publicKey.toBase58()}`);
  console.log(`Victim: ${victim.publicKey.toBase58()}`);

  console.log("\n--- Funding test accounts ---");
  await fundAccounts(connection, payer, [attacker.publicKey, victim.publicKey], 0.05);
  console.log("  Funded attacker and victim with 0.05 SOL each");

  console.log("\n--- Creating test token ---");
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  const attackerAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, attacker.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );
  const victimAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, victim.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  const ATTACKER_DEPOSIT = 1;
  const DONATION_AMOUNT = 1_000_000;
  const VICTIM_DEPOSIT = 1_000;

  await mintTo(connection, payer, assetMint, attackerAta.address, payer,
    (ATTACKER_DEPOSIT + DONATION_AMOUNT) * 10 ** ASSET_DECIMALS);
  await mintTo(connection, payer, assetMint, victimAta.address, payer,
    VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);

  console.log(`  Attacker tokens: ${(ATTACKER_DEPOSIT + DONATION_AMOUNT).toLocaleString()}`);
  console.log(`  Victim tokens: ${VICTIM_DEPOSIT.toLocaleString()}`);

  // Initialize vault (payer is authority+operator)
  console.log("\n--- Initializing async vault ---");
  const vaultId = new BN(Date.now());
  const [vault] = getAsyncVaultAddress(programId, assetMint, vaultId);
  const [sharesMint] = getAsyncSharesMintAddress(programId, vault);
  const [shareEscrow] = getShareEscrowAddress(programId, vault);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  await program.methods
    .initialize(vaultId, "Inflation Test Vault", "INFLAT")
    .accounts({
      authority: payer.publicKey, operator: payer.publicKey, vault, assetMint,
      sharesMint, assetVault, shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // ATTACK SCENARIO
  console.log("\n" + "=".repeat(70));
  console.log("  ATTACK SCENARIO");
  console.log("=".repeat(70));

  // Step 1: Attacker deposits 1 token through full lifecycle
  console.log("\n--- Step 1: Attacker deposits 1 token ---");

  const attackerDepositAmount = new BN(ATTACKER_DEPOSIT * 10 ** ASSET_DECIMALS);
  const [attackerDepositRequest] = getDepositRequestAddress(programId, vault, attacker.publicKey);

  await program.methods
    .requestDeposit(attackerDepositAmount, attacker.publicKey)
    .accounts({
      user: attacker.publicKey, vault, assetMint,
      userAssetAccount: attackerAta.address, assetVault,
      depositRequest: attackerDepositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([attacker])
    .rpc();

  console.log("  Request deposit: OK");

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: attackerDepositRequest,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  console.log("  Fulfill deposit: OK");

  const attackerSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, attacker.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: attacker.publicKey, vault,
      depositRequest: attackerDepositRequest,
      owner: attacker.publicKey, sharesMint,
      receiverSharesAccount: attackerSharesAccount,
      receiver: attacker.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([attacker])
    .rpc();

  const attackerSharesAfterDeposit = await getAccount(connection, attackerSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const attackerShares = Number(attackerSharesAfterDeposit.amount) / 10 ** SHARE_DECIMALS;
  console.log(`  Attacker shares: ${attackerShares}`);

  // Step 2: Attacker donates directly to vault ATA
  console.log("\n--- Step 2: Attacker donates 1M tokens directly to vault ---");
  console.log("  (This bypasses the request flow — direct transfer to asset vault)");

  await transfer(
    connection, attacker, attackerAta.address, assetVault, attacker,
    BigInt(DONATION_AMOUNT * 10 ** ASSET_DECIMALS), [], undefined, TOKEN_PROGRAM_ID,
  );

  const vaultBalanceAfterDonation = await getAccount(connection, assetVault);
  const vaultState = await (program.account as any).asyncVault.fetch(vault);
  console.log(`  Asset vault balance: ${Number(vaultBalanceAfterDonation.amount) / 10 ** ASSET_DECIMALS}`);
  console.log(`  Vault total_assets: ${vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS}`);
  console.log(`  Mismatch! This is the attack vector.`);

  // Step 3: Victim deposits through full lifecycle
  console.log("\n--- Step 3: Victim deposits 1000 tokens ---");
  console.log("  If vulnerable, victim would get almost 0 shares");

  const victimDepositAmount = new BN(VICTIM_DEPOSIT * 10 ** ASSET_DECIMALS);
  const [victimDepositRequest] = getDepositRequestAddress(programId, vault, victim.publicKey);

  await program.methods
    .requestDeposit(victimDepositAmount, victim.publicKey)
    .accounts({
      user: victim.publicKey, vault, assetMint,
      userAssetAccount: victimAta.address, assetVault,
      depositRequest: victimDepositRequest,
      assetTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .signers([victim])
    .rpc();

  console.log("  Request deposit: OK");

  await program.methods
    .fulfillDeposit(null)
    .accountsStrict({
      operator: payer.publicKey, vault,
      depositRequest: victimDepositRequest,
      operatorApproval: programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .rpc();

  console.log("  Fulfill deposit: OK (vault-priced, uses total_assets not balance)");

  const victimSharesAccount = getAssociatedTokenAddressSync(
    sharesMint, victim.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .claimDeposit()
    .accountsStrict({
      claimant: victim.publicKey, vault,
      depositRequest: victimDepositRequest,
      owner: victim.publicKey, sharesMint,
      receiverSharesAccount: victimSharesAccount,
      receiver: victim.publicKey,
      operatorApproval: programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([victim])
    .rpc();

  const victimSharesAfter = await getAccount(connection, victimSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
  const victimSharesReceived = Number(victimSharesAfter.amount) / 10 ** SHARE_DECIMALS;
  console.log(`  Victim deposited: ${VICTIM_DEPOSIT} tokens`);
  console.log(`  Victim received: ${victimSharesReceived} shares`);

  // ANALYSIS
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS");
  console.log("=".repeat(70));

  const shareRatio = victimSharesReceived / attackerShares;
  const expectedRatio = VICTIM_DEPOSIT / ATTACKER_DEPOSIT;

  console.log(`
  Attacker deposited: ${ATTACKER_DEPOSIT} token
  Attacker shares:    ${attackerShares}

  Attacker donated:   ${DONATION_AMOUNT.toLocaleString()} tokens (directly to vault ATA)

  Victim deposited:   ${VICTIM_DEPOSIT} tokens
  Victim shares:      ${victimSharesReceived}

  Share ratio (victim/attacker): ${shareRatio.toFixed(2)}x
  Expected fair ratio:           ${expectedRatio}x
  `);

  // In async vault, fulfill uses total_assets (not vault balance) for pricing.
  // The donation goes to vault ATA but total_assets is NOT updated, so the
  // victim's shares are calculated from the un-manipulated accounting.
  if (shareRatio >= expectedRatio * 0.9) {
    console.log("  PROTECTED: Victim received fair shares!");
    console.log("     Async vault accounting ignores direct donations.");
    console.log("     total_assets is only updated via fulfill, not vault ATA balance.");
  } else if (shareRatio < expectedRatio * 0.5) {
    console.log("  VULNERABLE: Victim got significantly fewer shares!");
    console.log("     Donation attack was successful.");
  } else {
    console.log("  PARTIAL: Some impact, but not catastrophic.");
  }

  console.log("\n" + "=".repeat(70));
  console.log("  TEST COMPLETE");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
