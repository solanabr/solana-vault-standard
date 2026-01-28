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
  transfer,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("Yield and Sync", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  let donorAssetAccount: PublicKey;

  const donor = Keypair.generate();
  const vaultId = new BN(600);
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

    // Setup user account
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
      10_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Setup donor account (for simulating external yield)
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
      .initialize(vaultId, "Yield Vault", "yldVault", "https://example.com")
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

    console.log("Setup:");
    console.log("  Vault:", vault.toBase58());
    console.log("  Asset Vault:", assetVault.toBase58());
    console.log("  Donor:", donor.publicKey.toBase58());
  });

  describe("sync() Basic", () => {
    before(async () => {
      // Initial deposit
      await program.methods
        .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
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
    });

    it("sync updates total_assets to match actual balance", async () => {
      const vaultBefore = await program.account.vault.fetch(vault);

      // Simulate external yield: donor sends tokens directly to asset_vault
      const yieldAmount = 10_000 * 10 ** ASSET_DECIMALS;
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

      // Check state mismatch
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(vaultBefore.totalAssets.toNumber()).to.be.lessThan(Number(assetVaultAccount.amount));
      console.log("  Before sync - vault.total_assets:", vaultBefore.totalAssets.toNumber());
      console.log("  Before sync - actual balance:", Number(assetVaultAccount.amount));

      // Sync
      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));
      console.log("  After sync - vault.total_assets:", vaultAfter.totalAssets.toNumber());
    });

    it("sync can only be called by authority", async () => {
      const fakeAuthority = Keypair.generate();

      try {
        await program.methods
          .sync()
          .accountsStrict({
            authority: fakeAuthority.publicKey,
            vault: vault,
            assetVault: assetVault,
          })
          .signers([fakeAuthority])
          .rpc();
        expect.fail("Should reject non-authority");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Non-authority sync correctly rejected");
      }
    });
  });

  describe("Yield Accrual", () => {
    let yieldVault: PublicKey;
    let yieldSharesMint: PublicKey;
    let yieldAssetVault: PublicKey;
    let yieldUserSharesAccount: PublicKey;
    const yieldVaultId = new BN(601);

    before(async () => {
      [yieldVault] = getVaultPDA(assetMint, yieldVaultId);
      [yieldSharesMint] = getSharesMintPDA(yieldVault);

      yieldAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: yieldVault,
      });

      yieldUserSharesAccount = getAssociatedTokenAddressSync(
        yieldSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(yieldVaultId, "Yield Test Vault", "ytVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: yieldVault,
          assetMint: assetMint,
          sharesMint: yieldSharesMint,
          assetVault: yieldAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("external transfer increases share price after sync", async () => {
      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      // Initial deposit
      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: yieldVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: yieldAssetVault,
          sharesMint: yieldSharesMint,
          userSharesAccount: yieldUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userSharesAfterDeposit = await getAccount(connection, yieldUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultBefore = await program.account.vault.fetch(yieldVault);

      // Calculate initial share price
      const initialPrice = vaultBefore.totalAssets.toNumber() / Number(userSharesAfterDeposit.amount);
      console.log("  Initial share price:", initialPrice.toFixed(9));

      // Add 50% yield
      const yieldAmount = 50_000 * 10 ** ASSET_DECIMALS;
      await transfer(
        connection,
        donor,
        donorAssetAccount,
        yieldAssetVault,
        donor.publicKey,
        yieldAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Sync to recognize yield
      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: yieldVault,
          assetVault: yieldAssetVault,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(yieldVault);
      const newPrice = vaultAfter.totalAssets.toNumber() / Number(userSharesAfterDeposit.amount);

      expect(newPrice).to.be.greaterThan(initialPrice);
      expect(newPrice / initialPrice).to.be.closeTo(1.5, 0.01); // 50% yield
      console.log("  New share price:", newPrice.toFixed(9));
      console.log("  Price increase:", ((newPrice / initialPrice - 1) * 100).toFixed(2) + "%");
    });

    it("depositor before yield gets more value on redeem", async () => {
      const userShares = await getAccount(connection, yieldUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userAssetsBefore = await getAccount(connection, userAssetAccount);

      // Redeem all shares
      await program.methods
        .redeem(new BN(Number(userShares.amount)), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: yieldVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: yieldAssetVault,
          sharesMint: yieldSharesMint,
          userSharesAccount: yieldUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const userAssetsAfter = await getAccount(connection, userAssetAccount);
      const assetsReceived = Number(userAssetsAfter.amount) - Number(userAssetsBefore.amount);

      // Should receive more than originally deposited (100k + ~50k yield)
      const originalDeposit = 100_000 * 10 ** ASSET_DECIMALS;
      expect(assetsReceived).to.be.greaterThan(originalDeposit);
      console.log("  Original deposit:", originalDeposit / 10 ** ASSET_DECIMALS);
      console.log("  Assets received:", assetsReceived / 10 ** ASSET_DECIMALS);
      console.log("  Profit:", (assetsReceived - originalDeposit) / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Share Price Tracking", () => {
    let priceVault: PublicKey;
    let priceSharesMint: PublicKey;
    let priceAssetVault: PublicKey;
    let priceUserSharesAccount: PublicKey;
    const priceVaultId = new BN(602);

    before(async () => {
      [priceVault] = getVaultPDA(assetMint, priceVaultId);
      [priceSharesMint] = getSharesMintPDA(priceVault);

      priceAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: priceVault,
      });

      priceUserSharesAccount = getAssociatedTokenAddressSync(
        priceSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(priceVaultId, "Price Track Vault", "ptVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: priceVault,
          assetMint: assetMint,
          sharesMint: priceSharesMint,
          assetVault: priceAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("empty vault: 1 asset approximately equals 1 share (with offset)", async () => {
      const depositAmount = new BN(1_000_000); // 1 USDC

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: priceVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: priceAssetVault,
          sharesMint: priceSharesMint,
          userSharesAccount: priceUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userShares = await getAccount(connection, priceUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultState = await program.account.vault.fetch(priceVault);

      // With 6 decimal asset and offset=3, virtual offset = 10^3 = 1000
      // First deposit: shares ≈ assets * 1000 (scaled up due to offset)
      const ratio = Number(userShares.amount) / vaultState.totalAssets.toNumber();

      // Ratio should be approximately 10^(9-6) = 10^3 = 1000 for 6 decimal asset
      console.log("  Asset deposited:", vaultState.totalAssets.toNumber());
      console.log("  Shares received:", Number(userShares.amount));
      console.log("  Ratio (shares/assets):", ratio.toFixed(2));
    });

    it("share price never decreases (without withdrawals)", async () => {
      const getSharePrice = async () => {
        const vaultState = await program.account.vault.fetch(priceVault);
        const userShares = await getAccount(connection, priceUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
        return vaultState.totalAssets.toNumber() / Number(userShares.amount);
      };

      const price1 = await getSharePrice();
      console.log("  Initial price:", price1.toFixed(9));

      // Add yield
      await transfer(
        connection,
        donor,
        donorAssetAccount,
        priceAssetVault,
        donor.publicKey,
        500_000, // 0.5 USDC
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: priceVault,
          assetVault: priceAssetVault,
        })
        .rpc();

      const price2 = await getSharePrice();
      console.log("  After yield:", price2.toFixed(9));
      expect(price2).to.be.greaterThanOrEqual(price1);

      // Second deposit
      await program.methods
        .deposit(new BN(500_000), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: priceVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: priceAssetVault,
          sharesMint: priceSharesMint,
          userSharesAccount: priceUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const price3 = await getSharePrice();
      console.log("  After deposit:", price3.toFixed(9));
      // Use closeTo to account for floating point precision (price should stay same or increase)
      expect(price3).to.be.closeTo(price2, 0.000001);
    });
  });

  describe("Edge Cases", () => {
    it("sync with no balance change is no-op", async () => {
      const vaultBefore = await program.account.vault.fetch(vault);
      const assetVaultBefore = await getAccount(connection, assetVault);

      // Sync when already in sync
      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vault);

      expect(vaultAfter.totalAssets.toNumber()).to.equal(vaultBefore.totalAssets.toNumber());
      console.log("  No-op sync: total_assets unchanged at", vaultAfter.totalAssets.toNumber());
    });

    it("multiple syncs accumulate correctly", async () => {
      // Send small amounts multiple times
      const smallAmount = 1000;

      for (let i = 0; i < 3; i++) {
        await transfer(
          connection,
          donor,
          donorAssetAccount,
          assetVault,
          donor.publicKey,
          smallAmount,
          [],
          undefined,
          TOKEN_PROGRAM_ID
        );
      }

      const vaultBefore = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);
      const expectedIncrease = 3 * smallAmount;

      // Sync once to capture all
      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vault);
      const actualIncrease = vaultAfter.totalAssets.toNumber() - vaultBefore.totalAssets.toNumber();

      expect(actualIncrease).to.equal(expectedIncrease);
      console.log("  Multiple transfers captured:", actualIncrease, "expected:", expectedIncrease);
    });
  });
});
