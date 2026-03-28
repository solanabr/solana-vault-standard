import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { Svs1 } from "../target/types/svs_1";
import { Svs9 } from "../target/types/svs_9";
import { SolanaVault, AllocatorVaultClient, getChildAllocationAddress } from "../sdk/core/src/index";

describe("SVS-9 E2E CPI CPI Test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const svs1Program = anchor.workspace.Svs1 as Program<Svs1>;
  const svs9Program = anchor.workspace.Svs9 as Program<Svs9>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // --- Core Accounts ---
  let assetMint: PublicKey;
  let userAssetAccount: PublicKey;
  const ASSET_DECIMALS = 6;

  // --- SVS-1 (Child Vault) ---
  let childVaultClient: SolanaVault;
  const childVaultId = new BN(1);

  // --- SVS-9 (Allocator Vault) ---
  let allocatorClient: AllocatorVaultClient;
  const allocatorVaultId = new BN(1);
  const sharesMintKeypair = Keypair.generate();
  let allocatorSharesMint: PublicKey;
  let userAllocatorSharesAccount: PublicKey;

  before(async () => {
    // 1. Setup Asset (USDC Mock)
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

    // 2. Setup User Asset Account & Mint Tokens
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
    userAssetAccount = userAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      userAssetAccount,
      payer.publicKey,
      1_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // 3. Initialize SVS-1 Vault (Child)
    childVaultClient = await SolanaVault.create(svs1Program, {
      assetMint,
      vaultId: childVaultId,
      name: "Strategy 1",
      symbol: "svS1",
      uri: "https://example.com/s1.json",
    });

    console.log("SVS-1 Vault initialized at:", childVaultClient.vault.toBase58());

    // 4. Initialize SVS-9 Allocator Vault
    // Use raw instruction since SDK create() doesn't pass the sharesMintKeypair signer
    const allocatorPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("allocator_vault"), assetMint.toBuffer(), allocatorVaultId.toArrayLike(Buffer, "le", 8)],
      svs9Program.programId
    )[0];

    [allocatorSharesMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("shares_mint"), allocatorPDA.toBuffer()],
      svs9Program.programId
    );

    const idleVault = getAssociatedTokenAddressSync(
      assetMint,
      allocatorPDA,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await (svs9Program.methods as any)
      .initialize(allocatorVaultId, 1000) // 10% idle buffer
      .accountsPartial({
        authority: payer.publicKey,
        curator: payer.publicKey,
        allocatorVault: allocatorPDA,
        assetMint: assetMint,
        sharesMint: allocatorSharesMint,
        idleVault: idleVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([])
      .rpc();

    // Load client
    allocatorClient = await AllocatorVaultClient.load(svs9Program, assetMint, allocatorVaultId);
    console.log("SVS-9 Allocator initialized at:", allocatorClient.allocatorVault.toBase58());

    // User's allocator shares account
    const userSharesAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      allocatorSharesMint,
      payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    userAllocatorSharesAccount = userSharesAta.address;
  });

  it("1. Adds SVS-1 child to SVS-9 allocator", async () => {
    await allocatorClient.addChild({
      childVault: childVaultClient.vault,
      childProgram: svs1Program.programId,
      maxWeightBps: 5000, // 50% max weight
    });

    await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      childVaultClient.sharesMint,
      allocatorClient.allocatorVault,
      true, // allowOwnerOffCurve
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const state = await allocatorClient.refresh();
    expect(state.numChildren).to.equal(1);
  });

  it("2. Deposits into SVS-9", async () => {
    const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
    
    await allocatorClient.deposit({
      assets: depositAmount,
      minSharesOut: new BN(0),
      callerAssetAccount: userAssetAccount,
      ownerSharesAccount: userAllocatorSharesAccount,
      owner: payer.publicKey,
    });

    const idleBalance = await allocatorClient.getIdleBalance();
    expect(idleBalance.toString()).to.equal(depositAmount.toString());
  });

  it("3. Rejects allocation exceeding max_weight_bps", async () => {
    // idle is 10k. Max weight is 50% = 5k. Try to allocate 6k.
    const excessAllocateAmount = new BN(6_000 * 10 ** ASSET_DECIMALS);
    
    try {
      await allocatorClient.allocate({
        assets: excessAllocateAmount,
        minSharesOut: new BN(0),
        childVault: childVaultClient.vault,
        childProgram: svs1Program.programId,
        childAssetMint: assetMint,
        childAssetVault: childVaultClient.assetVault,
        childSharesMint: childVaultClient.sharesMint,
      });
      expect.fail("Should have thrown MaxWeightExceeded");
    } catch (e: any) {
      expect(e.toString()).to.include("MaxWeightExceeded", "Expected max weight exceeded error");
    }
  });

  it("3.5 Rejects allocation violating idle buffer", async () => {
    // Temporarily increase max_weight_bps so we don't hit the weight limit
    await svs9Program.methods
      .updateWeights(10000)
      .accountsPartial({
        authority: payer.publicKey,
        allocatorVault: allocatorClient.allocatorVault,
        childAllocation: getChildAllocationAddress(svs9Program.programId, allocatorClient.allocatorVault, childVaultClient.vault)[0],
        childVault: childVaultClient.vault,
      })
      .rpc();

    // idle is 10k, total is 10k. Buffer is 10% (1k).
    // Allocate 9.5k leaves 0.5k < 1k
    const excessAllocateAmount = new BN(9_500 * 10 ** ASSET_DECIMALS);
    try {
      await allocatorClient.allocate({
        assets: excessAllocateAmount,
        minSharesOut: new BN(0),
        childVault: childVaultClient.vault,
        childProgram: svs1Program.programId,
        childAssetMint: assetMint,
        childAssetVault: childVaultClient.assetVault,
        childSharesMint: childVaultClient.sharesMint,
      });
      expect.fail("Should have thrown InsufficientBuffer");
    } catch (e: any) {
      expect(e.toString()).to.include("InsufficientBuffer", "Expected insufficient buffer error");
    }

    // Restore max weight back to 5000 for test 4
    await svs9Program.methods
      .updateWeights(5000)
      .accountsPartial({
        authority: payer.publicKey,
        allocatorVault: allocatorClient.allocatorVault,
        childAllocation: getChildAllocationAddress(svs9Program.programId, allocatorClient.allocatorVault, childVaultClient.vault)[0],
        childVault: childVaultClient.vault,
      })
      .rpc();
  });

  it("4. Allocates assets to SVS-1 via CPI", async () => {
    // Allocate 4k. 4k / 10k = 40% (under 50% max).
    const allocateAmount = new BN(4_000 * 10 ** ASSET_DECIMALS);
    const idleBefore = await allocatorClient.getIdleBalance();
    const childAssetVaultBefore = await connection.getTokenAccountBalance(childVaultClient.assetVault);

    await allocatorClient.allocate({
      assets: allocateAmount,
      minSharesOut: new BN(0),
      childVault: childVaultClient.vault,
      childProgram: svs1Program.programId,
      childAssetMint: assetMint,
      childAssetVault: childVaultClient.assetVault,
      childSharesMint: childVaultClient.sharesMint,
    });

    const idleAfter = await allocatorClient.getIdleBalance();
    const childAssetVaultAfter = await connection.getTokenAccountBalance(childVaultClient.assetVault);

    // Verify balances shifted correctly via CPI
    expect(idleAfter.toNumber()).to.equal(idleBefore.toNumber() - allocateAmount.toNumber());
    expect(Number(childAssetVaultAfter.value.amount)).to.equal(
      Number(childAssetVaultBefore.value.amount) + allocateAmount.toNumber()
    );
  });

  it("5. Harvests yield correctly after simulating profit", async () => {
    // We simulate profit by directly dropping assets into the child asset vault.
    const profitAmount = 1_000 * 10 ** ASSET_DECIMALS;
    await mintTo(
      connection,
      payer,
      assetMint,
      childVaultClient.assetVault,
      payer.publicKey,
      profitAmount,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    const idleBefore = await allocatorClient.getIdleBalance();
    const childAssetVaultBefore = await connection.getTokenAccountBalance(childVaultClient.assetVault);

    // Harvest should pull out exactly the profit.
    await allocatorClient.harvest({
      minAssetsOut: new BN(0),
      childVault: childVaultClient.vault,
      childProgram: svs1Program.programId,
      childAssetMint: assetMint,
      childAssetVault: childVaultClient.assetVault,
      childSharesMint: childVaultClient.sharesMint,
    });

    const idleAfter = await allocatorClient.getIdleBalance();
    
    // The allocator should have received the yield
    const pulledYield = idleAfter.toNumber() - idleBefore.toNumber();
    
    // Because of standard share math and SVS-1 live balance, pulled yield might have tiny rounding,
    // but should be practically equal to profitAmount.
    expect(pulledYield).to.be.closeTo(profitAmount, 10);
  });

  it("6. Rejects cross-vault ChildAllocation substitution (P1-1)", async () => {
    // Setup: initialize a second SVS-9 vault (vaultB) that shares the same SVS-1 child vault.
    // Attack: call deposit on vaultA but supply vaultB's ChildAllocation PDA in remaining_accounts.
    // Expected: InvalidRemainingAccounts, because allocation.allocator_vault != vaultA.

    const vaultBId = new BN(99);
    const vaultBPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("allocator_vault"), assetMint.toBuffer(), vaultBId.toArrayLike(Buffer, "le", 8)],
      svs9Program.programId
    )[0];
    const vaultBSharesMint = PublicKey.findProgramAddressSync(
      [Buffer.from("shares_mint"), vaultBPDA.toBuffer()],
      svs9Program.programId
    )[0];
    const vaultBIdleVault = getAssociatedTokenAddressSync(
      assetMint,
      vaultBPDA,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Initialize vaultB
    await (svs9Program.methods as any)
      .initialize(vaultBId, 1000)
      .accountsPartial({
        authority: payer.publicKey,
        curator: payer.publicKey,
        allocatorVault: vaultBPDA,
        assetMint,
        sharesMint: vaultBSharesMint,
        idleVault: vaultBIdleVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Add the same SVS-1 child to vaultB so its ChildAllocation PDA exists on-chain
    const vaultBChildAlloc = getChildAllocationAddress(
      svs9Program.programId,
      vaultBPDA,
      childVaultClient.vault
    )[0];
    const vaultBChildSharesAta = getAssociatedTokenAddressSync(
      childVaultClient.sharesMint,
      vaultBPDA,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await (svs9Program.methods as any)
      .addChild(5000)
      .accounts({
        authority: payer.publicKey,
        allocatorVault: vaultBPDA,
        childAllocation: vaultBChildAlloc,
        childVault: childVaultClient.vault,
        childProgram: svs1Program.programId,
        childSharesMint: childVaultClient.sharesMint,
        allocatorChildSharesAccount: vaultBChildSharesAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Build forged remaining_accounts: vaultB's ChildAllocation PDA where vaultA's is expected.
    // vaultA has num_children=1, so the program expects exactly 5 accounts.
    const forgedRemainingAccounts = [
      { pubkey: vaultBChildAlloc, isSigner: false, isWritable: false },
      { pubkey: childVaultClient.vault, isSigner: false, isWritable: false },
      { pubkey: vaultBChildSharesAta, isSigner: false, isWritable: false },
      { pubkey: childVaultClient.assetVault, isSigner: false, isWritable: false },
      { pubkey: childVaultClient.sharesMint, isSigner: false, isWritable: false },
    ];

    try {
      await (svs9Program.methods as any)
        .deposit(new BN(1_000_000), new BN(0))
        .accountsPartial({
          caller: payer.publicKey,
          owner: payer.publicKey,
          allocatorVault: allocatorClient.allocatorVault,
          idleVault: allocatorClient.idleVault,
          sharesMint: allocatorSharesMint,
          callerAssetAccount: userAssetAccount,
          ownerSharesAccount: userAllocatorSharesAccount,
          assetMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(forgedRemainingAccounts)
        .rpc();
      expect.fail("Should have rejected cross-vault ChildAllocation substitution");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidRemainingAccounts");
    }
  });
});
