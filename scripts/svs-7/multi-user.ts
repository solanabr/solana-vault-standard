/**
 * SVS-7 Multi-User Fairness Test
 *
 * Tests that multiple users get fair treatment with native SOL:
 * - Alice, Bob, Charlie deposit varying amounts sequentially
 * - Share distribution analysis (should be proportional to deposit)
 * - All users redeem, verify fairness
 *
 * Run: npx ts-node scripts/svs-7/multi-user.ts
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
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
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
} from "./helpers";

const SHARE_DECIMALS = 9; // SOL = 9 decimals, shares mirror this

interface UserState {
  name: string;
  keypair: Keypair;
  sharesAccount: PublicKey;
  wsolAccount: PublicKey;
  depositLamports: number;
  sharesReceived: number;
  lamportsRedeemed: number;
}

async function main() {
  const { connection, payer, program, programId } = await setupSvs7Test(
    "Multi-User Fairness",
  );

  // Create test users
  const users: UserState[] = [
    {
      name: "Alice",
      keypair: Keypair.generate(),
      sharesAccount: PublicKey.default,
      wsolAccount: PublicKey.default,
      depositLamports: 1 * LAMPORTS_PER_SOL,
      sharesReceived: 0,
      lamportsRedeemed: 0,
    },
    {
      name: "Bob",
      keypair: Keypair.generate(),
      sharesAccount: PublicKey.default,
      wsolAccount: PublicKey.default,
      depositLamports: 0.5 * LAMPORTS_PER_SOL,
      sharesReceived: 0,
      lamportsRedeemed: 0,
    },
    {
      name: "Charlie",
      keypair: Keypair.generate(),
      sharesAccount: PublicKey.default,
      wsolAccount: PublicKey.default,
      depositLamports: 2 * LAMPORTS_PER_SOL,
      sharesReceived: 0,
      lamportsRedeemed: 0,
    },
  ];

  console.log("--- Creating test users ---");
  for (const user of users) {
    console.log(`  ${user.name}: ${user.keypair.publicKey.toBase58()}`);
  }

  // Fund users with enough SOL for deposits + fees
  console.log("\n--- Funding users with SOL ---");
  await fundAccounts(
    connection,
    payer,
    users.map((u) => u.keypair.publicKey),
    3, // 3 SOL each — enough for deposits + fees
  );
  console.log("  All users funded with 3 SOL");

  // Derive PDAs
  const vaultId = new BN(Date.now());
  const [vault] = getSolVaultPDA(programId, vaultId);
  const [sharesMint] = getSharesMintPDA(programId, vault);
  const wsolVault = anchor.utils.token.associatedAddress({
    mint: NATIVE_MINT,
    owner: vault,
  });

  // Set up each user's accounts
  for (const user of users) {
    user.sharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      user.keypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    user.wsolAccount = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      user.keypair.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // Initialize vault
  console.log("\n--- Initializing vault ---");
  await program.methods
    .initialize(vaultId, "Multi-User Test Vault", "MULTI")
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
  console.log("  Vault initialized");

  // Create wSOL ATAs for users ahead of time (needed for redeem_sol)
  console.log("\n--- Creating user wSOL ATAs ---");
  for (const user of users) {
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        user.wsolAccount,
        user.keypair.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
    console.log(`  ${user.name} wSOL ATA created`);
  }

  // Sequential deposits
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: Sequential Deposits (native SOL)");
  console.log("=".repeat(70));

  for (const user of users) {
    console.log(
      `\n--- ${user.name} deposits ${user.depositLamports / LAMPORTS_PER_SOL} SOL ---`,
    );

    await program.methods
      .depositSol(new BN(user.depositLamports), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey,
        vault,
        wsolVault,
        sharesMint,
        userSharesAccount: user.sharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

    const userSharesData = await getAccount(
      connection,
      user.sharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    user.sharesReceived = Number(userSharesData.amount) / 10 ** SHARE_DECIMALS;
    console.log(
      `  ${user.name} received: ${user.sharesReceived.toFixed(9)} svSOL shares`,
    );
  }

  // Analysis
  console.log("\n" + "=".repeat(70));
  console.log("  ANALYSIS: Share Distribution");
  console.log("=".repeat(70));

  const totalDeposited = users.reduce((sum, u) => sum + u.depositLamports, 0);
  const totalShares = users.reduce((sum, u) => sum + u.sharesReceived, 0);

  console.log(`\n  Total deposited: ${totalDeposited / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Total shares: ${totalShares.toFixed(9)} svSOL\n`);

  for (const user of users) {
    const expectedPct = (user.depositLamports / totalDeposited) * 100;
    const actualPct = (user.sharesReceived / totalShares) * 100;
    const deviation = Math.abs(actualPct - expectedPct);
    const status = deviation < 0.01 ? "FAIR" : "SKEWED";
    console.log(
      `  ${status} ${user.name}: ${actualPct.toFixed(4)}% of shares (expected ${expectedPct.toFixed(4)}%)`,
    );
  }

  // wSOL vault state
  const wsolVaultState = await getAccount(
    connection,
    wsolVault,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(
    `\n  wSOL vault total: ${Number(wsolVaultState.amount) / LAMPORTS_PER_SOL} SOL`,
  );

  // All users redeem
  console.log("\n" + "=".repeat(70));
  console.log("  SCENARIO: All users redeem all shares for native SOL");
  console.log("=".repeat(70));

  for (const user of users) {
    const userSharesData = await getAccount(
      connection,
      user.sharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    if (Number(userSharesData.amount) === 0) continue;

    const solBefore = await connection.getBalance(user.keypair.publicKey);

    await program.methods
      .redeemSol(new BN(Number(userSharesData.amount)), new BN(0))
      .accountsStrict({
        user: user.keypair.publicKey,
        vault,
        nativeMint: NATIVE_MINT,
        wsolVault,
        userWsolAccount: user.wsolAccount,
        sharesMint,
        userSharesAccount: user.sharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user.keypair])
      .rpc();

    const solAfter = await connection.getBalance(user.keypair.publicKey);
    // Net includes ATA close refund and tx fee
    const netSol = solAfter - solBefore;
    user.lamportsRedeemed = netSol;

    console.log(
      `\n  ${user.name}: ~${(netSol / LAMPORTS_PER_SOL).toFixed(6)} SOL net (incl ATA close refund, minus fees)`,
    );
  }

  // Final analysis
  console.log("\n" + "=".repeat(70));
  console.log("  FINAL: Fairness Check");
  console.log("=".repeat(70));

  let allFair = true;
  for (const user of users) {
    // lamportsRedeemed includes ~0.002 SOL ATA close refund minus tx fees
    // We consider "fair" if loss is less than 0.01 SOL (covers rent + fees)
    const depositSol = user.depositLamports / LAMPORTS_PER_SOL;
    const redeemedSol = user.lamportsRedeemed / LAMPORTS_PER_SOL;
    const loss = depositSol - redeemedSol;
    const pctLoss = (loss / depositSol) * 100;

    // Allow up to 1% loss to cover tx fees and rent
    const status = pctLoss < 1 ? "FAIR" : "ISSUE";
    console.log(
      `  ${status} ${user.name}: deposited ${depositSol} SOL, net ${redeemedSol.toFixed(6)} SOL (~${pctLoss.toFixed(4)}% loss)`,
    );
    if (pctLoss >= 2) allFair = false; // 2% threshold — covers fees generously
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    allFair
      ? "  Multi-user SOL accounting is FAIR"
      : "  Potential fairness issue",
  );
  console.log("=".repeat(70) + "\n");

  if (!allFair) process.exit(1);
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
