/**
 * SVS-10 Devnet Smoke Test
 *
 * Runs a full async vault lifecycle on devnet:
 *   initialize → request_deposit → fulfill_deposit → claim_deposit
 *   → request_redeem → fulfill_redeem → claim_redeem
 *
 * Usage:
 *   npx ts-node scripts/smoke-test-svs10.ts
 *
 * Requirements:
 *   - Solana CLI configured with funded devnet wallet
 *   - SVS-10 deployed to devnet
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Connection,
} from "@solana/web3.js";
import { Svs10 } from "../target/types/svs_10";

const DEVNET_URL = "https://api.devnet.solana.com";
const ASSET_DECIMALS = 6;
const DEPOSIT_AMOUNT = 1_000 * 10 ** ASSET_DECIMALS; // 1000 tokens

interface TxLog {
  step: string;
  sig: string;
}

const txLog: TxLog[] = [];

function log(step: string, sig: string) {
  txLog.push({ step, sig });
  console.log(`  OK  ${step}`);
  console.log(`      tx: ${sig}`);
}

function deriveVault(programId: PublicKey, assetMint: PublicKey, vaultId: BN) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("async_vault"),
      assetMint.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

function deriveSharesMint(programId: PublicKey, vault: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer()],
    programId,
  );
}

function deriveAssetVault(programId: PublicKey, vault: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_vault"), vault.toBuffer()],
    programId,
  );
}

function deriveShareEscrow(programId: PublicKey, vault: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("share_escrow"), vault.toBuffer()],
    programId,
  );
}

function deriveDepositRequest(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_request"), vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

function deriveRedeemRequest(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_request"), vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

function deriveClaimableEscrow(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable"), vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

function deriveClaimableTokens(
  programId: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable_tokens"), vault.toBuffer(), owner.toBuffer()],
    programId,
  );
}

async function main() {
  console.log(`\nSVS-10 Devnet Smoke Test`);
  console.log(`RPC: ${DEVNET_URL}\n`);

  const connection = new Connection(DEVNET_URL, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const payer = wallet.payer;
  const program = anchor.workspace.Svs10 as Program<Svs10>;
  const programId = program.programId;

  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${programId.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 0.5 * 1e9) {
    console.error("Insufficient balance. Need at least 0.5 SOL.");
    process.exit(1);
  }

  const vaultId = new BN(Date.now());

  // --- Step 1: Create test asset mint + fund user ---
  console.log("-- Setup --");
  const assetMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    ASSET_DECIMALS,
    Keypair.generate(),
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(`  Asset mint: ${assetMint.toBase58()}`);

  const userAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    assetMint,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID,
  );

  await mintTo(
    connection,
    payer,
    assetMint,
    userAta.address,
    payer.publicKey,
    DEPOSIT_AMOUNT * 2,
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(`  Minted ${(DEPOSIT_AMOUNT * 2) / 10 ** ASSET_DECIMALS} tokens\n`);

  // Derive all PDAs
  const [vault] = deriveVault(programId, assetMint, vaultId);
  const [sharesMint] = deriveSharesMint(programId, vault);
  const [assetVault] = deriveAssetVault(programId, vault);
  const [shareEscrow] = deriveShareEscrow(programId, vault);
  const [depositRequest] = deriveDepositRequest(
    programId,
    vault,
    payer.publicKey,
  );
  const [redeemRequest] = deriveRedeemRequest(
    programId,
    vault,
    payer.publicKey,
  );
  const [claimableEscrow] = deriveClaimableEscrow(
    programId,
    vault,
    payer.publicKey,
  );
  const [claimableTokens] = deriveClaimableTokens(
    programId,
    vault,
    payer.publicKey,
  );

  // --- Step 2: Initialize vault ---
  console.log("-- 1. Initialize Vault --");
  const initSig = await program.methods
    .initialize(vaultId, new BN(0), new BN(3600))
    .accountsStrict({
      authority: payer.publicKey,
      vault,
      assetMint,
      sharesMint,
      assetVault,
      shareEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  log("initialize", initSig);

  // Set operator to self (authority == operator for smoke test)
  const setOpSig = await program.methods
    .setVaultOperator(payer.publicKey)
    .accountsStrict({
      authority: payer.publicKey,
      vault,
    })
    .rpc();
  log("set_vault_operator", setOpSig);

  // --- Step 3: Request Deposit ---
  console.log("\n-- 2. Deposit Lifecycle --");
  const depositAmount = new BN(DEPOSIT_AMOUNT);

  const reqDepSig = await program.methods
    .requestDeposit(depositAmount, payer.publicKey)
    .accountsStrict({
      user: payer.publicKey,
      vault,
      depositRequest,
      assetMint,
      userAssetAccount: userAta.address,
      assetVault,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log("request_deposit (1000 tokens)", reqDepSig);

  // --- Step 4: Fulfill Deposit (operator = self) ---
  const fulfillDepSig = await program.methods
    .fulfillDeposit()
    .accountsStrict({
      operator: payer.publicKey,
      vault,
      depositRequest,
    })
    .rpc();
  log("fulfill_deposit", fulfillDepSig);

  // --- Step 5: Claim Deposit ---
  // Create receiver's shares ATA (Token-2022) before claiming
  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    sharesMint,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const userSharesAccount = userSharesAta.address;

  const claimDepSig = await program.methods
    .claimDeposit()
    .accountsStrict({
      claimer: payer.publicKey,
      vault,
      depositRequest,
      sharesMint,
      receiverSharesAccount: userSharesAccount,
      operatorApproval: null,
      rentReceiver: payer.publicKey,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  log("claim_deposit", claimDepSig);

  const sharesBalance = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`      shares received: ${sharesBalance.amount}`);

  // --- Step 6: Request Redeem (half of shares) ---
  console.log("\n-- 3. Redeem Lifecycle --");
  const redeemShares = new BN(Number(sharesBalance.amount) / 2);

  const reqRedSig = await program.methods
    .requestRedeem(redeemShares, payer.publicKey)
    .accountsStrict({
      user: payer.publicKey,
      vault,
      redeemRequest,
      sharesMint,
      userSharesAccount,
      shareEscrow,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log(`request_redeem (${redeemShares.toString()} shares)`, reqRedSig);

  // --- Step 7: Fulfill Redeem ---
  const fulfillRedSig = await program.methods
    .fulfillRedeem()
    .accountsStrict({
      operator: payer.publicKey,
      vault,
      redeemRequest,
      sharesMint,
      shareEscrow,
      assetMint,
      assetVault,
      claimableTokens,
      claimableEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  log("fulfill_redeem", fulfillRedSig);

  // --- Step 8: Claim Redeem ---
  const claimRedSig = await program.methods
    .claimRedeem()
    .accountsStrict({
      claimer: payer.publicKey,
      vault,
      redeemRequest,
      claimableEscrow,
      owner: payer.publicKey,
      assetMint,
      claimableTokens,
      receiverAssetAccount: userAta.address,
      operatorApproval: null,
      rentReceiver: payer.publicKey,
      assetTokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  log("claim_redeem", claimRedSig);

  // --- Step 9: Verify final state ---
  console.log("\n-- 4. Final State --");
  const vaultState = await program.account.asyncVault.fetch(vault);
  console.log(`  total_assets: ${vaultState.totalAssets.toString()}`);
  console.log(`  total_shares: ${vaultState.totalShares.toString()}`);
  console.log(`  paused: ${vaultState.paused}`);
  console.log(`  operator: ${vaultState.operator.toBase58()}`);

  const finalShares = await getAccount(
    connection,
    userSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  const finalAssets = await getAccount(
    connection,
    userAta.address,
    undefined,
    TOKEN_PROGRAM_ID,
  );
  console.log(`  user shares: ${finalShares.amount}`);
  console.log(`  user assets: ${finalAssets.amount}`);

  // --- Summary ---
  console.log(`\n========================================`);
  console.log(`  All ${txLog.length} transactions succeeded`);
  console.log(`  Vault: ${vault.toBase58()}`);
  console.log(`  Explorer links (devnet):`);
  for (const tx of txLog) {
    console.log(
      `    ${tx.step}: https://explorer.solana.com/tx/${tx.sig}?cluster=devnet`,
    );
  }
  console.log(`========================================\n`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
