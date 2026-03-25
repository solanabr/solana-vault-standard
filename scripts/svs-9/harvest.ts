/**
 * SVS-9 Harvest Script
 *
 * Executes a full end-to-end harvest flow:
 * 1. Initialize a child SVS-1 vault
 * 2. Initialize an SVS-9 allocator
 * 3. Add the child vault
 * 4. Deposit into the allocator
 * 5. Allocate idle capital to the child
 * 6. Simulate profit in the child vault
 * 7. Harvest the yield back into allocator idle liquidity
 *
 * Run: npx ts-node scripts/svs-9/harvest.ts
 */

import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
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
const PROFIT_AMOUNT = 25_000;

async function main() {
  const { connection, payer, svs9Program, svs1Program } =
    await setupAllocatorWithChildPrograms("Harvest");

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
      name: "Harvest Child Vault",
      symbol: "HVST",
      uri: "https://example.com/svs9-harvest-child.json",
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
  console.log("Step 6: Allocating idle capital to the child");
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

  console.log("\n" + "-".repeat(70));
  console.log("Step 7: Simulating child-vault profit");
  console.log("-".repeat(70));

  await mintTo(
    connection,
    payer,
    assetMint,
    childVaultClient.assetVault,
    payer.publicKey,
    PROFIT_AMOUNT * 10 ** ASSET_DECIMALS,
    [],
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`  Simulated Profit: ${PROFIT_AMOUNT.toLocaleString()} tokens`);

  console.log("\n" + "-".repeat(70));
  console.log("Step 8: Harvesting realized yield");
  console.log("-".repeat(70));

  const idleBefore = await allocatorClient.getIdleBalance();
  const allocationBefore = await allocatorClient.getChildAllocation(
    childVaultClient.vault
  );

  const harvestTx = await allocatorClient.harvest({
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
  const pulledYield = idleAfter.toNumber() - idleBefore.toNumber();
  const expectedYield = PROFIT_AMOUNT * 10 ** ASSET_DECIMALS;

  console.log(`  Tx: ${explorerUrl(harvestTx)}`);
  console.log(`  Idle Before: ${idleBefore.toString()}`);
  console.log(`  Idle After:  ${idleAfter.toString()}`);
  console.log(`  Yield Pulled: ${pulledYield}`);
  console.log(
    `  Cost Basis Before: ${allocationBefore.depositedAssets.toString()}`
  );
  console.log(
    `  Cost Basis After:  ${allocationAfter.depositedAssets.toString()}`
  );

  if (Math.abs(pulledYield - expectedYield) > 50) {
    throw new Error(
      `Harvested yield ${pulledYield} deviates too much from expected ${expectedYield}`
    );
  }

  console.log("=".repeat(70));
  console.log("  ✅ SVS-9 Harvest completed successfully!");
  console.log("  Real child-vault CPI path executed end-to-end.");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});
