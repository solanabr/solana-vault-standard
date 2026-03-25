/**
 * SVS-9 Deallocate Script
 *
 * Executes a full end-to-end deallocation flow:
 * 1. Initialize a child SVS-1 vault
 * 2. Initialize an SVS-9 allocator
 * 3. Add the child vault
 * 4. Deposit into the allocator
 * 5. Allocate principal to the child
 * 6. Deallocate part of the position back into idle liquidity
 *
 * Run: npx ts-node scripts/svs-9/deallocate.ts
 */

import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { SolanaVault, AllocatorVaultClient } from "../../sdk/core/src/index";
import {
  setupAllocatorWithChildPrograms,
  explorerUrl,
  ASSET_DECIMALS,
} from "./helpers";

const INITIAL_MINT_AMOUNT = 1_000_000;
const DEPOSIT_AMOUNT = 500_000;
const ALLOCATE_AMOUNT = 200_000;

async function main() {
  const { connection, payer, svs9Program, svs1Program } =
    await setupAllocatorWithChildPrograms("Deallocate");

  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Creating asset mint (Mock USDC)");
  console.log("-".repeat(70));

  const assetMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    ASSET_DECIMALS,
    Keypair.generate(),
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`  Asset Mint: ${assetMint.toBase58()}`);

  const userAssetAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    assetMint,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  await mintTo(
    connection,
    payer,
    assetMint,
    userAssetAta.address,
    payer.publicKey,
    INITIAL_MINT_AMOUNT * 10 ** ASSET_DECIMALS,
    [],
    undefined,
    TOKEN_PROGRAM_ID
  );

  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Initializing child SVS-1 vault");
  console.log("-".repeat(70));

  const childVaultClient = await SolanaVault.create(
    svs1Program as unknown as Program,
    {
      assetMint,
      vaultId: new BN(Date.now()),
      name: "Deallocate Child Vault",
      symbol: "DALL",
      uri: "https://example.com/svs9-deallocate-child.json",
    }
  );
  console.log(`  Child Vault: ${childVaultClient.vault.toBase58()}`);
  console.log(`  Child Shares Mint: ${childVaultClient.sharesMint.toBase58()}`);

  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Initializing SVS-9 allocator");
  console.log("-".repeat(70));

  const allocatorClient = await AllocatorVaultClient.create(
    svs9Program as unknown as Program,
    {
      vaultId: new BN(Date.now() + 1),
      idleBufferBps: 1000,
      assetMint,
      curator: payer.publicKey,
    }
  );
  const allocatorState = await allocatorClient.getState();
  console.log(`  Allocator Vault: ${allocatorClient.allocatorVault.toBase58()}`);
  console.log(`  Idle Vault: ${allocatorClient.idleVault.toBase58()}`);
  console.log(`  Shares Mint: ${allocatorState.sharesMint.toBase58()}`);

  const userSharesAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    allocatorState.sharesMint,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  console.log("\n" + "-".repeat(70));
  console.log("Step 4: Registering the SVS-1 child");
  console.log("-".repeat(70));

  const addChildTx = await allocatorClient.addChild({
    childVault: childVaultClient.vault,
    childProgram: svs1Program.programId,
    maxWeightBps: 5000,
    childDecimalsOffset: 0,
  });
  console.log(`  Tx: ${explorerUrl(addChildTx)}`);

  console.log("\n" + "-".repeat(70));
  console.log("Step 5: Depositing into the allocator");
  console.log("-".repeat(70));

  const depositTx = await allocatorClient.deposit({
    assets: new BN(DEPOSIT_AMOUNT * 10 ** ASSET_DECIMALS),
    minSharesOut: new BN(0),
    callerAssetAccount: userAssetAta.address,
    ownerSharesAccount: userSharesAta.address,
    owner: payer.publicKey,
  });
  console.log(`  Tx: ${explorerUrl(depositTx)}`);

  console.log("\n" + "-".repeat(70));
  console.log("Step 6: Allocating principal to the child");
  console.log("-".repeat(70));

  const allocateTx = await allocatorClient.allocate({
    assets: new BN(ALLOCATE_AMOUNT * 10 ** ASSET_DECIMALS),
    minSharesOut: new BN(0),
    childVault: childVaultClient.vault,
    childProgram: svs1Program.programId,
    childAssetMint: assetMint,
    childAssetVault: childVaultClient.assetVault,
    childSharesMint: childVaultClient.sharesMint,
  });
  console.log(`  Tx: ${explorerUrl(allocateTx)}`);

  const allocatorChildSharesAccount = getAssociatedTokenAddressSync(
    childVaultClient.sharesMint,
    allocatorClient.allocatorVault,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const childSharesBefore = await getAccount(
    connection,
    allocatorChildSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  const sharesToWithdraw = new BN((childSharesBefore.amount / 2n).toString());

  if (sharesToWithdraw.isZero()) {
    throw new Error("Allocator received zero child shares; cannot deallocate.");
  }

  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Deallocating principal back to idle liquidity");
  console.log("-".repeat(70));

  const idleBefore = await allocatorClient.getIdleBalance();
  const allocationBefore = await allocatorClient.getChildAllocation(
    childVaultClient.vault
  );

  const deallocateTx = await allocatorClient.deallocate({
    sharesToWithdraw,
    minAssetsOut: new BN(0),
    childVault: childVaultClient.vault,
    childProgram: svs1Program.programId,
    childAssetMint: assetMint,
    childAssetVault: childVaultClient.assetVault,
    childSharesMint: childVaultClient.sharesMint,
  });

  const idleAfter = await allocatorClient.getIdleBalance();
  const allocationAfter = await allocatorClient.getChildAllocation(
    childVaultClient.vault
  );
  const childSharesAfter = await getAccount(
    connection,
    allocatorChildSharesAccount,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  console.log(`  Tx: ${explorerUrl(deallocateTx)}`);
  console.log(`  Shares Burned: ${sharesToWithdraw.toString()}`);
  console.log(`  Idle Before: ${idleBefore.toString()}`);
  console.log(`  Idle After:  ${idleAfter.toString()}`);
  console.log(
    `  Cost Basis Before: ${allocationBefore.depositedAssets.toString()}`
  );
  console.log(
    `  Cost Basis After:  ${allocationAfter.depositedAssets.toString()}`
  );
  console.log(`  Child Shares Before: ${childSharesBefore.amount.toString()}`);
  console.log(`  Child Shares After:  ${childSharesAfter.amount.toString()}`);

  if (idleAfter.lte(idleBefore)) {
    throw new Error("Deallocate did not increase idle liquidity.");
  }

  if (allocationAfter.depositedAssets.gte(allocationBefore.depositedAssets)) {
    throw new Error("Deallocate did not reduce the tracked child cost basis.");
  }

  console.log("=".repeat(70));
  console.log("  ✅ SVS-9 Deallocate completed successfully!");
  console.log("  Real child-vault CPI redeem path executed end-to-end.");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
