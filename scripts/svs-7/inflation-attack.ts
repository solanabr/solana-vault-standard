/**
 * SVS-7 Inflation/Donation Attack Test
 *
 * Tests protection against the classic ERC-4626 inflation attack adapted for
 * native SOL vaults. The "donation" is done by transferring SOL directly to
 * the wSOL vault account then calling sync_native — which inflates the
 * wsol_vault.amount without going through deposit.
 *
 * Steps:
 * 1. Attacker deposits minimal SOL (1000 lamports)
 * 2. Attacker donates 1 SOL directly to vault wSOL account via system transfer + sync_native
 * 3. Victim deposits 0.1 SOL
 * 4. Check if victim gets fair shares / recovers their deposit on redeem
 *
 * Run: npx ts-node scripts/svs-7/inflation-attack.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  setupSvs7Test,
  getSolVaultPDA,
  getSharesMintPDA,
  fundAccounts,
  explorerUrl,
} from "./helpers";

const ATTACKER_DEPOSIT_LAMPORTS = 1000; // minimal (just above min deposit)
const DONATION_LAMPORTS = 1 * LAMPORTS_PER_SOL; // 1 SOL donation
const VICTIM_DEPOSIT_LAMPORTS = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test(
    "Inflation/Donation Attack",
  );

  const attacker = Keypair.generate();
  const victim = Keypair.generate();

  console.log(`Attacker: ${attacker.publicKey.toBase58()}`);
  console.log(`Victim:   ${victim.publicKey.toBase58()}`);

  // Fund test accounts with enough SOL for deposits + fees
  console.log("\n--- Funding test accounts ---");
  await fundAccounts(
    connection,
    payer,
    [attacker.publicKey, victim.publicKey],
    2, // 2 SOL each — enough for deposit + donation + fees
  );
  console.log("  Funded attacker and victim with 2 SOL each");

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({
    mint: NATIVE_MINT,
    owner: vault,
  });

  const attackerSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    attacker.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const victimSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    victim.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const victimWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    victim.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Initialize vault (payer is authority)
  console.log("\n--- Initializing vault ---");
  await program.methods
    .initialize(vaultId, "Inflation Test Vault", "INFLAT")
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      nativeMint: NATIVE_MINT,
      sharesMint,
      wsolVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // ATTACK SCENARIO
  console.log("\n" + "=".repeat(70));
  console.log("  ATTACK SCENARIO");
  console.log("=".repeat(70));

  // Step 1: Attacker deposits minimal amount
  console.log(
    `\n--- Step 1: Attacker deposits ${ATTACKER_DEPOSIT_LAMPORTS} lamports (minimal) ---`,
  );

  await program.methods
    .depositSol(new BN(ATTACKER_DEPOSIT_LAMPORTS), new BN(0))
    .accountsStrict({
      user: attacker.publicKey,
      vault,
      wsolVault,
      sharesMint,
      userSharesAccount: attackerSharesAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([attacker])
    .rpc();

  const attackerSharesAfter = await getAccount(
    connection,
    attackerSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(
    `  Attacker shares: ${Number(attackerSharesAfter.amount)} lamport-shares`,
  );

  const wsolVaultBefore = await getAccount(
    connection,
    wsolVault,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(
    `  wSOL vault balance before donation: ${Number(wsolVaultBefore.amount)} lamports`,
  );

  // Step 2: Attacker donates 1 SOL directly to vault's wSOL account
  // This inflates wsol_vault.amount without going through deposit()
  console.log(
    `\n--- Step 2: Attacker donates ${DONATION_LAMPORTS / LAMPORTS_PER_SOL} SOL directly to wSOL vault ---`,
  );
  console.log("  (Bypasses deposit — uses system transfer + sync_native)");

  const donationTx = new Transaction();
  donationTx.add(
    SystemProgram.transfer({
      fromPubkey: attacker.publicKey,
      toPubkey: wsolVault,
      lamports: DONATION_LAMPORTS,
    }),
    createSyncNativeInstruction(wsolVault, TOKEN_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(connection, donationTx, [attacker]);

  const wsolVaultAfterDonation = await getAccount(
    connection,
    wsolVault,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(
    `  wSOL vault balance after donation: ${Number(wsolVaultAfterDonation.amount) / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(
    "  Donation inflates share price — each attacker share now worth more",
  );

  // Step 3: Create victim's wSOL ATA ahead of time
  const createVictimWsolTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      victimWsolAccount,
      victim.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createVictimWsolTx, [payer]);

  // Step 3: Victim deposits
  console.log(
    `\n--- Step 3: Victim deposits ${VICTIM_DEPOSIT_LAMPORTS / LAMPORTS_PER_SOL} SOL ---`,
  );
  console.log(
    "  If vulnerable, victim would get 0 shares due to inflated share price",
  );

  await program.methods
    .depositSol(new BN(VICTIM_DEPOSIT_LAMPORTS), new BN(0))
    .accountsStrict({
      user: victim.publicKey,
      vault,
      wsolVault,
      sharesMint,
      userSharesAccount: victimSharesAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([victim])
    .rpc();

  const victimSharesAfter = await getAccount(
    connection,
    victimSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const victimSharesReceived = Number(victimSharesAfter.amount);
  console.log(
    `  Victim shares received: ${victimSharesReceived} lamport-shares`,
  );

  // ANALYSIS
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS");
  console.log("=".repeat(70));

  const attackerShares = Number(attackerSharesAfter.amount);

  console.log(`
  Attacker deposited: ${ATTACKER_DEPOSIT_LAMPORTS} lamports
  Attacker shares:    ${attackerShares}

  Attacker donated:   ${DONATION_LAMPORTS} lamports (directly)

  Victim deposited:   ${VICTIM_DEPOSIT_LAMPORTS} lamports
  Victim shares:      ${victimSharesReceived}
  `);

  // Victim redemption test — the real protection metric
  console.log("--- Testing victim redemption (the real protection metric) ---");

  const victimSolBefore = await connection.getBalance(victim.publicKey);

  await program.methods
    .redeemSol(new BN(victimSharesReceived), new BN(0))
    .accountsStrict({
      user: victim.publicKey,
      vault,
      nativeMint: NATIVE_MINT,
      wsolVault,
      userWsolAccount: victimWsolAccount,
      sharesMint,
      userSharesAccount: victimSharesAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([victim])
    .rpc();

  const victimSolAfter = await connection.getBalance(victim.publicKey);
  // Note: includes lamport refund from closing wSOL ATA
  const victimSolNet = victimSolAfter - victimSolBefore;
  const victimRedeemed = victimSolNet; // approximate — tx fees are small

  const profitLoss = victimRedeemed - VICTIM_DEPOSIT_LAMPORTS;
  const lossPercent =
    (Math.abs(Math.min(profitLoss, 0)) / VICTIM_DEPOSIT_LAMPORTS) * 100;

  console.log(
    `\n  Victim redeemed (net, approx): ${victimRedeemed / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(
    `  Original deposit: ${VICTIM_DEPOSIT_LAMPORTS / LAMPORTS_PER_SOL} SOL`,
  );
  console.log(`  Approx loss: ${lossPercent.toFixed(4)}%`);

  console.log("\n" + "=".repeat(70));
  // In SVS-7 (live-only, no virtual offset), a large donation will inflate share
  // price. The victim gets fewer shares but each share is worth more. The key
  // question is whether they can redeem close to their full deposit.
  // With a 1000:1000000 donation ratio and 100000 victim deposit, loss may be
  // significant. We report the actual outcome.
  if (victimSharesReceived > 0) {
    console.log(
      "  PROTECTED: Victim received > 0 shares (not completely drained)",
    );
    console.log(`  Victim loss: ~${lossPercent.toFixed(2)}% of deposit`);
  } else {
    console.log(
      "  VULNERABLE: Victim received 0 shares — full loss on deposit",
    );
    process.exit(1);
  }
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
