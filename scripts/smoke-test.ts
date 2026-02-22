/**
 * Smoke Test Script
 *
 * Runs a full vault lifecycle against a deployed SVS-1 program on devnet.
 * Creates a test mint, initializes a vault, deposits, previews, redeems, and verifies.
 *
 * Usage:
 *   npx ts-node scripts/smoke-test.ts --cluster devnet
 *   npx ts-node scripts/smoke-test.ts --cluster localnet
 *
 * Requirements:
 *   - Solana CLI configured with a funded wallet
 *   - Program deployed to the target cluster
 *
 * ⚠️  This script creates on-chain accounts and costs SOL. Only run on devnet.
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
  clusterApiUrl,
} from "@solana/web3.js";
import { Svs1 } from "../target/types/svs_1";

const ASSET_DECIMALS = 6;
const DEPOSIT_AMOUNT = 100_000 * 10 ** ASSET_DECIMALS; // 100k tokens
const REDEEM_SHARES = 1000 * 10 ** 9; // 1000 shares (9 decimals)

function parseArgs(): { cluster: string } {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith("--")) {
      flags[args[i].replace("--", "")] = args[i + 1];
    }
  }
  return { cluster: flags.cluster || "devnet" };
}

function getConnectionUrl(cluster: string): string {
  if (cluster === "localnet" || cluster === "localhost") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "mainnet-beta" | "testnet");
}

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
  error?: string;
}

const results: TestResult[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, passed: true, detail });
  console.log(`  ✅ ${name}${detail ? ` (${detail})` : ""}`);
}

function fail(name: string, error: string) {
  results.push({ name, passed: false, error });
  console.log(`  ❌ ${name}: ${error}`);
}

async function main() {
  const { cluster } = parseArgs();

  if (cluster === "mainnet-beta") {
    console.error("❌ Smoke tests should NOT run on mainnet. Use devnet.");
    process.exit(1);
  }

  const url = getConnectionUrl(cluster);

  console.log(`\n🧪 SVS-1 Smoke Test`);
  console.log(`   Cluster: ${cluster}`);
  console.log(`   RPC:     ${url}\n`);

  // Setup provider
  const connection = new Connection(url, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const payer = wallet.payer;
  const program = anchor.workspace.Svs1 as Program<Svs1>;

  console.log(`   Wallet:  ${payer.publicKey.toBase58()}`);

  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`   Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 0.1 * 1e9) {
    console.error("❌ Insufficient balance. Need at least 0.1 SOL.");
    if (cluster === "devnet") {
      console.log("   Run: solana airdrop 2");
    }
    process.exit(1);
  }

  const vaultId = new BN(Date.now()); // Unique vault ID

  // Helper: derive PDAs
  const getVaultPDA = (assetMint: PublicKey, vId: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetMint.toBuffer(), vId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );

  // ─── Step 1: Create test asset mint ───
  console.log("── Step 1: Setup ──────────────────────────────────");
  let assetMint: PublicKey;
  try {
    assetMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      ASSET_DECIMALS,
      Keypair.generate(),
      undefined,
      TOKEN_PROGRAM_ID
    );
    pass("Create asset mint", assetMint.toBase58().slice(0, 12) + "...");
  } catch (err: any) {
    fail("Create asset mint", err.message);
    process.exit(1);
  }

  // Derive accounts
  const [vault] = getVaultPDA(assetMint, vaultId);
  const [sharesMint] = getSharesMintPDA(vault);
  const assetVault = anchor.utils.token.associatedAddress({
    mint: assetMint,
    owner: vault,
  });

  // Create user asset ATA and mint tokens
  let userAssetAccount: PublicKey;
  try {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    userAssetAccount = ata.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      userAssetAccount,
      payer.publicKey,
      DEPOSIT_AMOUNT * 2,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );
    pass("Mint test tokens", `${(DEPOSIT_AMOUNT * 2) / 10 ** ASSET_DECIMALS} tokens`);
  } catch (err: any) {
    fail("Mint test tokens", err.message);
    process.exit(1);
  }

  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // ─── Step 2: Initialize vault ───
  console.log("\n── Step 2: Initialize Vault ────────────────────────");
  try {
    await program.methods
      .initialize(vaultId, "Smoke Test Vault", "sMOKE", "https://smoke.test")
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        assetMint,
        sharesMint,
        assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    pass("Initialize vault", vault.toBase58().slice(0, 12) + "...");
  } catch (err: any) {
    fail("Initialize vault", err.message);
    process.exit(1);
  }

  // ─── Step 3: Deposit ───
  console.log("\n── Step 3: Deposit ────────────────────────────────");
  try {
    await program.methods
      .deposit(new BN(DEPOSIT_AMOUNT), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        assetMint,
        userAssetAccount,
        assetVault,
        sharesMint,
        userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const sharesBalance = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    pass("Deposit", `shares received: ${sharesBalance.amount}`);
  } catch (err: any) {
    fail("Deposit", err.message);
  }

  // ─── Step 4: Preview functions ───
  console.log("\n── Step 4: Preview Functions ───────────────────────");
  try {
    await program.methods
      .previewDeposit(new BN(DEPOSIT_AMOUNT))
      .accountsStrict({ vault, sharesMint, assetVault })
      .simulate();
    pass("previewDeposit");
  } catch (err: any) {
    fail("previewDeposit", err.message);
  }

  try {
    await program.methods
      .previewRedeem(new BN(REDEEM_SHARES))
      .accountsStrict({ vault, sharesMint, assetVault })
      .simulate();
    pass("previewRedeem");
  } catch (err: any) {
    fail("previewRedeem", err.message);
  }

  try {
    await program.methods
      .convertToShares(new BN(DEPOSIT_AMOUNT))
      .accountsStrict({ vault, sharesMint, assetVault })
      .simulate();
    pass("convertToShares");
  } catch (err: any) {
    fail("convertToShares", err.message);
  }

  try {
    await program.methods
      .convertToAssets(new BN(REDEEM_SHARES))
      .accountsStrict({ vault, sharesMint, assetVault })
      .simulate();
    pass("convertToAssets");
  } catch (err: any) {
    fail("convertToAssets", err.message);
  }

  // ─── Step 5: Redeem ───
  console.log("\n── Step 5: Redeem ─────────────────────────────────");
  try {
    const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    const redeemAmount = new BN(Number(sharesBefore.amount) / 2); // Redeem half

    await program.methods
      .redeem(redeemAmount, new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        assetMint,
        userAssetAccount,
        assetVault,
        sharesMint,
        userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    const assetsAfter = await getAccount(connection, userAssetAccount, undefined, TOKEN_PROGRAM_ID);
    pass("Redeem", `shares remaining: ${sharesAfter.amount}, assets: ${assetsAfter.amount}`);
  } catch (err: any) {
    fail("Redeem", err.message);
  }

  // ─── Step 6: Verify vault state ───
  console.log("\n── Step 6: Verify State ────────────────────────────");
  try {
    const vaultState = await program.account.vault.fetch(vault);
    const vaultAssets = await getAccount(connection, assetVault, undefined, TOKEN_PROGRAM_ID);

    if (!vaultState.paused) pass("Vault not paused");
    else fail("Vault not paused", "Vault is paused");

    if (Number(vaultAssets.amount) > 0) pass("Vault has assets", `${vaultAssets.amount}`);
    else fail("Vault has assets", "No assets in vault");

    if (vaultState.authority.equals(payer.publicKey)) pass("Authority matches wallet");
    else fail("Authority matches wallet", "Authority mismatch");
  } catch (err: any) {
    fail("Verify state", err.message);
  }

  // ─── Summary ───
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}`);
  console.log(`  Vault:   ${vault.toBase58()}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
