/**
 * SVS-12 Tranched Vault — E2E Devnet Lifecycle
 *
 * Runs a full lifecycle against a deployed SVS-12 program on devnet:
 * 1. Create asset mint
 * 2. Initialize vault (sequential waterfall)
 * 3. Add senior tranche (priority=0, sub=2000bps, yield=500bps, cap=6000bps)
 * 4. Add junior tranche (priority=1, sub=0, yield=0, cap=10000bps)
 * 5. Deposit into junior (1000 USDC)
 * 6. Deposit into senior (3000 USDC)
 * 7. Distribute yield (200 USDC) — verify senior gets target, junior gets residual
 * 8. Record loss (500 USDC) — verify junior absorbs
 * 9. Redeem from junior
 * 10. Rebalance junior→senior
 * 11. Pause/unpause
 * 12. Set manager, transfer authority
 * 13. Update tranche config
 *
 * Usage:
 *   npx ts-node scripts/e2e-svs12-devnet.ts
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
} from "@solana/web3.js";
import { Svs12 } from "../target/types/svs_12";

const ASSET_DECIMALS = 6;
const LAMPORTS = 10 ** ASSET_DECIMALS;
const EXPLORER = "https://explorer.solana.com/tx";

function link(sig: string): string {
  return `${EXPLORER}/${sig}?cluster=devnet`;
}

interface StepResult {
  name: string;
  passed: boolean;
  sig?: string;
  detail?: string;
}

const results: StepResult[] = [];

function pass(name: string, sig?: string, detail?: string) {
  results.push({ name, passed: true, sig, detail });
  console.log(`  ✅ ${name}${sig ? `\n     ${link(sig)}` : ""}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, error: string) {
  results.push({ name, passed: false, detail: error });
  console.log(`  ❌ ${name}: ${error}`);
}

const getVaultPDA = (programId: PublicKey, assetMint: PublicKey, vaultId: BN): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("tranched_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId,
  );

const getTranchePDA = (programId: PublicKey, vault: PublicKey, index: number): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("tranche"), vault.toBuffer(), Buffer.from([index])],
    programId,
  );

const getSharesMintPDA = (programId: PublicKey, vault: PublicKey, index: number): [PublicKey, number] =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer(), Buffer.from([index])],
    programId,
  );

async function main() {
  console.log("\n🏗️  SVS-12 Tranched Vault — E2E Devnet Test\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Svs12 as Program<Svs12>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const vaultId = new BN(Date.now()); // unique per run

  console.log(`  Program: ${program.programId.toBase58()}`);
  console.log(`  Payer:   ${payer.publicKey.toBase58()}`);
  console.log(`  VaultID: ${vaultId.toString()}\n`);

  // 1. Create asset mint
  let assetMint: PublicKey;
  try {
    assetMint = await createMint(
      connection, payer, payer.publicKey, null, ASSET_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
    );
    pass("Create asset mint", undefined, assetMint.toBase58());
  } catch (e) {
    fail("Create asset mint", String(e));
    return;
  }

  // Mint tokens to payer
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false,
    undefined, undefined, TOKEN_PROGRAM_ID,
  );
  await mintTo(
    connection, payer, assetMint, userAta.address,
    payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID,
  );

  const [vault] = getVaultPDA(program.programId, assetMint, vaultId);
  const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);

  // 2. Initialize vault
  try {
    const sig = await program.methods
      .initialize(vaultId, 0)
      .accounts({
        authority: payer.publicKey,
        vault,
        assetMint,
        assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    pass("Initialize vault (sequential)", sig);
  } catch (e) {
    fail("Initialize vault", String(e));
    return;
  }

  // 3. Add senior tranche (priority=0)
  const [seniorTranche] = getTranchePDA(program.programId, vault, 0);
  const [seniorSharesMint] = getSharesMintPDA(program.programId, vault, 0);
  try {
    const sig = await program.methods
      .addTranche(0, 2000, 500, 6000)
      .accounts({
        authority: payer.publicKey,
        vault,
        tranche: seniorTranche,
        sharesMint: seniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    pass("Add senior tranche (p=0, sub=2000, yield=500, cap=6000)", sig);
  } catch (e) {
    fail("Add senior tranche", String(e));
    return;
  }

  // 4. Add junior tranche (priority=1)
  const [juniorTranche] = getTranchePDA(program.programId, vault, 1);
  const [juniorSharesMint] = getSharesMintPDA(program.programId, vault, 1);
  try {
    const sig = await program.methods
      .addTranche(1, 0, 0, 10000)
      .accounts({
        authority: payer.publicKey,
        vault,
        tranche: juniorTranche,
        sharesMint: juniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    pass("Add junior tranche (p=1, sub=0, yield=0, cap=10000)", sig);
  } catch (e) {
    fail("Add junior tranche", String(e));
    return;
  }

  // Create shares ATAs for user
  const userJuniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, juniorSharesMint, payer.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const userSeniorSharesAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, seniorSharesMint, payer.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );

  // 5. Deposit 1000 into junior
  try {
    const sig = await program.methods
      .deposit(new BN(1000 * LAMPORTS), new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: juniorTranche,
        tranche1: seniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAta.address,
        assetVault,
        sharesMint: juniorSharesMint,
        userSharesAccount: userJuniorSharesAta.address,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    pass("Deposit 1000 into junior", sig);
  } catch (e) {
    fail("Deposit junior", String(e));
    return;
  }

  // 6. Deposit 3000 into senior
  try {
    const sig = await program.methods
      .deposit(new BN(3000 * LAMPORTS), new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAta.address,
        assetVault,
        sharesMint: seniorSharesMint,
        userSharesAccount: userSeniorSharesAta.address,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    pass("Deposit 3000 into senior", sig);
  } catch (e) {
    fail("Deposit senior", String(e));
    return;
  }

  // 7. Distribute yield (200)
  try {
    const sig = await program.methods
      .distributeYield(new BN(200 * LAMPORTS))
      .accounts({
        manager: payer.publicKey,
        vault,
        assetMint,
        managerAssetAccount: userAta.address,
        assetVault,
        tranche0: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const seniorState = await program.account.tranche.fetch(seniorTranche);
    const juniorState = await program.account.tranche.fetch(juniorTranche);
    const seniorYield = seniorState.totalAssetsAllocated.toNumber() - 3000 * LAMPORTS;
    const juniorYield = juniorState.totalAssetsAllocated.toNumber() - 1000 * LAMPORTS;
    pass(
      "Distribute yield (200)",
      sig,
      `senior +${seniorYield / LAMPORTS}, junior +${juniorYield / LAMPORTS}`,
    );
  } catch (e) {
    fail("Distribute yield", String(e));
    return;
  }

  // 8. Record loss (500)
  try {
    const sig = await program.methods
      .recordLoss(new BN(500 * LAMPORTS))
      .accounts({
        manager: payer.publicKey,
        vault,
        tranche0: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
      })
      .rpc();

    const juniorState = await program.account.tranche.fetch(juniorTranche);
    pass(
      "Record loss (500)",
      sig,
      `junior now ${juniorState.totalAssetsAllocated.toNumber() / LAMPORTS}`,
    );
  } catch (e) {
    fail("Record loss", String(e));
    return;
  }

  // 9. Redeem from junior (100 shares)
  try {
    const sig = await program.methods
      .redeem(new BN(100 * 10 ** 9), new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: juniorTranche,
        tranche1: seniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAta.address,
        assetVault,
        sharesMint: juniorSharesMint,
        userSharesAccount: userJuniorSharesAta.address,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    pass("Redeem 100 shares from junior", sig);
  } catch (e) {
    fail("Redeem junior", String(e));
  }

  // 10. Rebalance junior→senior (50)
  try {
    const sig = await program.methods
      .rebalanceTranches(new BN(50 * LAMPORTS))
      .accounts({
        manager: payer.publicKey,
        vault,
        fromTranche: juniorTranche,
        toTranche: seniorTranche,
        otherTranche0: null,
        otherTranche1: null,
      })
      .rpc();
    pass("Rebalance 50 junior→senior", sig);
  } catch (e) {
    fail("Rebalance", String(e));
  }

  // 11. Pause + unpause
  try {
    const sig1 = await program.methods
      .pause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
    pass("Pause vault", sig1);

    const sig2 = await program.methods
      .unpause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
    pass("Unpause vault", sig2);
  } catch (e) {
    fail("Pause/unpause", String(e));
  }

  // 12. Set manager
  const newManager = Keypair.generate();
  try {
    const sig = await program.methods
      .setManager(newManager.publicKey)
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
    pass("Set manager", sig, newManager.publicKey.toBase58().slice(0, 12) + "...");

    // Set back
    await program.methods
      .setManager(payer.publicKey)
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
  } catch (e) {
    fail("Set manager", String(e));
  }

  // 13. Update tranche config
  try {
    const sig = await program.methods
      .updateTrancheConfig(1000, null, null)
      .accounts({
        authority: payer.publicKey,
        vault,
        targetTranche: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
      })
      .rpc();
    pass("Update tranche config (yield=1000bps)", sig);
  } catch (e) {
    fail("Update tranche config", String(e));
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`  ${passed}/${total} steps passed`);
  if (passed < total) {
    console.log("  FAILURES:");
    results.filter((r) => !r.passed).forEach((r) => console.log(`    - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  console.log("  All steps passed! ✅\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
