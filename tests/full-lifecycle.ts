import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  transfer,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("Full Lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const donor = Keypair.generate();

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  let donorAssetAccount: PublicKey;

  const vaultId = new BN(800);
  const ASSET_DECIMALS = 6;

  const getVaultPDA = (assetMint: PublicKey, vaultId: BN): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  };

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  };

  before(async () => {
    // Fund donor via SOL transfer from payer (more reliable than airdrop)
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: donor.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, fundTx, [payer]);

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

    [vault] = getVaultPDA(assetMint, vaultId);
    [sharesMint] = getSharesMintPDA(vault);

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
      100_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Donor account
    const donorAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      donor.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    donorAssetAccount = donorAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      donorAssetAccount,
      payer.publicKey,
      10_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Initialize vault
    await program.methods
      .initialize(vaultId, "Lifecycle Vault", "lcVault", "https://example.com")
      .accountsStrict({
        authority: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        sharesMint: sharesMint,
        assetVault: assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("Setup complete");
    console.log("  Vault:", vault.toBase58());
  });

  it("complete flow: init → deposit → yield → sync → redeem", async () => {
    console.log("\n--- Complete Flow Test ---");

    // 1. Initial deposit
    const depositAmount = 100_000 * 10 ** ASSET_DECIMALS;
    await program.methods
      .deposit(new BN(depositAmount), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let vaultState = await program.account.vault.fetch(vault);
    let userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    console.log("1. Deposited:", depositAmount / 10 ** ASSET_DECIMALS, "assets");
    console.log("   Shares received:", Number(userShares.amount) / 10 ** 9);

    // 2. Simulate yield (external transfer)
    const yieldAmount = 50_000 * 10 ** ASSET_DECIMALS;
    await transfer(
      connection,
      donor,
      donorAssetAccount,
      assetVault,
      donor.publicKey,
      yieldAmount,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );
    console.log("2. Yield added:", yieldAmount / 10 ** ASSET_DECIMALS, "assets");

    // 3. Sync to recognize yield
    await program.methods
      .sync()
      .accountsStrict({
        authority: payer.publicKey,
        vault: vault,
        assetVault: assetVault,
      })
      .rpc();

    vaultState = await program.account.vault.fetch(vault);
    console.log("3. After sync - total_assets:", vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);

    // 4. Redeem all shares
    userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    const userAssetsBefore = await getAccount(connection, userAssetAccount);

    await program.methods
      .redeem(new BN(Number(userShares.amount)), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const userAssetsAfter = await getAccount(connection, userAssetAccount);
    const assetsReceived = Number(userAssetsAfter.amount) - Number(userAssetsBefore.amount);

    console.log("4. Redeemed all shares");
    console.log("   Assets received:", assetsReceived / 10 ** ASSET_DECIMALS);
    console.log("   Profit:", (assetsReceived - depositAmount) / 10 ** ASSET_DECIMALS);

    expect(assetsReceived).to.be.greaterThan(depositAmount);

    // 5. Verify vault is nearly empty (may have minimal dust due to rounding)
    vaultState = await program.account.vault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.be.lessThan(10); // Allow minimal rounding dust
    console.log("5. Vault empty - total_assets:", vaultState.totalAssets.toNumber());
  });

  it("vault survives complete exit and new deposits", async () => {
    console.log("\n--- Vault Survival Test ---");

    // Vault should be nearly empty from previous test (may have minimal dust)
    let vaultState = await program.account.vault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.be.lessThan(10); // Allow minimal rounding dust
    console.log("1. Starting with nearly empty vault, dust:", vaultState.totalAssets.toNumber());

    // New deposit after complete exit
    const newDeposit = 50_000 * 10 ** ASSET_DECIMALS;
    await program.methods
      .deposit(new BN(newDeposit), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    vaultState = await program.account.vault.fetch(vault);
    // Account for minimal rounding dust from previous test
    expect(vaultState.totalAssets.toNumber()).to.be.closeTo(newDeposit, 10);
    console.log("2. New deposit successful:", newDeposit / 10 ** ASSET_DECIMALS, "assets");
    console.log("   Vault total_assets:", vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
  });

  it("sequential: deposit → mint → withdraw → redeem", async () => {
    console.log("\n--- Sequential Operations Test ---");

    // 1. Deposit
    await program.methods
      .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("1. Deposit: 10,000 assets");

    // 2. Mint
    const userAssets = await getAccount(connection, userAssetAccount);
    await program.methods
      .mint(new BN(5000 * 10 ** 9), new BN(Number(userAssets.amount)))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("2. Mint: 5,000 shares");

    // 3. Withdraw
    let userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .withdraw(new BN(1_000 * 10 ** ASSET_DECIMALS), new BN(Number(userShares.amount)))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("3. Withdraw: 1,000 assets");

    // 4. Redeem
    userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .redeem(new BN(1000 * 10 ** 9), new BN(0))
      .accountsStrict({
        user: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        userAssetAccount: userAssetAccount,
        assetVault: assetVault,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log("4. Redeem: 1,000 shares");

    // Verify state is consistent
    const vaultState = await program.account.vault.fetch(vault);
    const assetVaultAccount = await getAccount(connection, assetVault);
    expect(vaultState.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));
    console.log("5. State consistent - total_assets:", vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
  });

  it("stress: 10 deposits, 5 redeems, 3 withdraws, 2 mints", async () => {
    console.log("\n--- Stress Test ---");

    // Create fresh vault for stress test
    const stressVaultId = new BN(801);
    const [stressVault] = getVaultPDA(assetMint, stressVaultId);
    const [stressSharesMint] = getSharesMintPDA(stressVault);

    const stressAssetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: stressVault,
    });

    const stressUserSharesAccount = getAssociatedTokenAddressSync(
      stressSharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .initialize(stressVaultId, "Stress Vault", "strVault", "https://example.com")
      .accountsStrict({
        authority: payer.publicKey,
        vault: stressVault,
        assetMint: assetMint,
        sharesMint: stressSharesMint,
        assetVault: stressAssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // 10 deposits
    console.log("1. Performing 10 deposits...");
    for (let i = 0; i < 10; i++) {
      await program.methods
        .deposit(new BN((10_000 + i * 1000) * 10 ** ASSET_DECIMALS), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: stressVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: stressAssetVault,
          sharesMint: stressSharesMint,
          userSharesAccount: stressUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    console.log("   10 deposits complete");

    // 5 redeems
    console.log("2. Performing 5 redeems...");
    for (let i = 0; i < 5; i++) {
      await program.methods
        .redeem(new BN(1000 * 10 ** 9), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: stressVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: stressAssetVault,
          sharesMint: stressSharesMint,
          userSharesAccount: stressUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    }
    console.log("   5 redeems complete");

    // 3 withdraws
    console.log("3. Performing 3 withdraws...");
    let shares = await getAccount(connection, stressUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    for (let i = 0; i < 3; i++) {
      await program.methods
        .withdraw(new BN(500 * 10 ** ASSET_DECIMALS), new BN(Number(shares.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault: stressVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: stressAssetVault,
          sharesMint: stressSharesMint,
          userSharesAccount: stressUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      shares = await getAccount(connection, stressUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
    }
    console.log("   3 withdraws complete");

    // 2 mints
    console.log("4. Performing 2 mints...");
    const userAssets = await getAccount(connection, userAssetAccount);
    for (let i = 0; i < 2; i++) {
      await program.methods
        .mint(new BN(500 * 10 ** 9), new BN(Number(userAssets.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault: stressVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: stressAssetVault,
          sharesMint: stressSharesMint,
          userSharesAccount: stressUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    console.log("   2 mints complete");

    // Verify final state consistency
    const finalVaultState = await program.account.vault.fetch(stressVault);
    const finalAssetVault = await getAccount(connection, stressAssetVault);
    const finalSharesMint = await getMint(connection, stressSharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    const finalUserShares = await getAccount(connection, stressUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

    expect(finalVaultState.totalAssets.toNumber()).to.equal(Number(finalAssetVault.amount));
    expect(Number(finalSharesMint.supply)).to.equal(Number(finalUserShares.amount));

    console.log("5. Final state:");
    console.log("   Total assets:", finalVaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
    console.log("   Total shares:", Number(finalSharesMint.supply) / 10 ** 9);
    console.log("   State consistent: true");
  });

  describe("Exit Scenarios", () => {
    let exitVault: PublicKey;
    let exitSharesMint: PublicKey;
    let exitAssetVault: PublicKey;
    let exitUserSharesAccount: PublicKey;
    const exitVaultId = new BN(802);

    before(async () => {
      [exitVault] = getVaultPDA(assetMint, exitVaultId);
      [exitSharesMint] = getSharesMintPDA(exitVault);

      exitAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: exitVault,
      });

      exitUserSharesAccount = getAssociatedTokenAddressSync(
        exitSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(exitVaultId, "Exit Vault", "extVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: exitVault,
          assetMint: assetMint,
          sharesMint: exitSharesMint,
          assetVault: exitAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("single user complete exit", async () => {
      // Deposit
      await program.methods
        .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: exitVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: exitAssetVault,
          sharesMint: exitSharesMint,
          userSharesAccount: exitUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Get all shares
      const userShares = await getAccount(connection, exitUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // Redeem all
      await program.methods
        .redeem(new BN(Number(userShares.amount)), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: exitVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: exitAssetVault,
          sharesMint: exitSharesMint,
          userSharesAccount: exitUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const vaultState = await program.account.vault.fetch(exitVault);
      const sharesAfter = await getAccount(connection, exitUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      expect(vaultState.totalAssets.toNumber()).to.equal(0);
      expect(Number(sharesAfter.amount)).to.equal(0);
      console.log("  Single user complete exit successful");
    });

    it("vault state correct after all users exit", async () => {
      const vaultState = await program.account.vault.fetch(exitVault);
      const assetVaultAccount = await getAccount(connection, exitAssetVault);
      const sharesMintInfo = await getMint(connection, exitSharesMint, undefined, TOKEN_2022_PROGRAM_ID);

      expect(vaultState.totalAssets.toNumber()).to.equal(0);
      expect(Number(assetVaultAccount.amount)).to.equal(0);
      expect(Number(sharesMintInfo.supply)).to.equal(0);
      console.log("  Vault state correct after exit:");
      console.log("    total_assets: 0");
      console.log("    actual balance: 0");
      console.log("    total shares: 0");
    });

    it("new user can deposit after complete exit", async () => {
      // Deposit into empty vault
      await program.methods
        .deposit(new BN(50_000 * 10 ** ASSET_DECIMALS), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: exitVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: exitAssetVault,
          sharesMint: exitSharesMint,
          userSharesAccount: exitUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultState = await program.account.vault.fetch(exitVault);
      const userShares = await getAccount(connection, exitUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      expect(vaultState.totalAssets.toNumber()).to.equal(50_000 * 10 ** ASSET_DECIMALS);
      expect(Number(userShares.amount)).to.be.greaterThan(0);
      console.log("  New deposit after exit successful");
      console.log("    New total_assets:", vaultState.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("    New shares:", Number(userShares.amount) / 10 ** 9);
    });
  });
});
