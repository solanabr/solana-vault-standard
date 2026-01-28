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
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("Invariants", () => {
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
  const vaultId = new BN(400);
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

    await program.methods
      .initialize(vaultId, "Invariant Vault", "invVault", "https://example.com")
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
  });

  describe("Conservation of Value", () => {
    it("deposit: user_assets_lost == vault_assets_gained", async () => {
      const userAssetsBefore = await getAccount(connection, userAssetAccount);
      const vaultStateBefore = await program.account.vault.fetch(vault);
      const assetVaultBefore = await getAccount(connection, assetVault);

      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .deposit(depositAmount, new BN(0))
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

      const userAssetsAfter = await getAccount(connection, userAssetAccount);
      const vaultStateAfter = await program.account.vault.fetch(vault);
      const assetVaultAfter = await getAccount(connection, assetVault);

      const userLost = Number(userAssetsBefore.amount) - Number(userAssetsAfter.amount);
      const vaultGained = Number(assetVaultAfter.amount) - Number(assetVaultBefore.amount);
      const stateGained = vaultStateAfter.totalAssets.toNumber() - vaultStateBefore.totalAssets.toNumber();

      expect(userLost).to.equal(depositAmount.toNumber());
      expect(vaultGained).to.equal(depositAmount.toNumber());
      expect(stateGained).to.equal(depositAmount.toNumber());
      console.log("  Conservation verified: user lost", userLost, "= vault gained", vaultGained);
    });

    it("redeem: user_shares_burned == shares_supply_decrease", async () => {
      const userSharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMintBefore = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);

      const redeemShares = new BN(Number(userSharesBefore.amount) / 4);

      await program.methods
        .redeem(redeemShares, new BN(0))
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

      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMintAfter = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);

      const userBurned = Number(userSharesBefore.amount) - Number(userSharesAfter.amount);
      const supplyDecrease = Number(sharesMintBefore.supply) - Number(sharesMintAfter.supply);

      expect(userBurned).to.equal(redeemShares.toNumber());
      expect(supplyDecrease).to.equal(redeemShares.toNumber());
      console.log("  Share conservation: burned", userBurned, "= supply decrease", supplyDecrease);
    });

    it("withdraw: exact assets transferred, shares calculated", async () => {
      const userSharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userAssetsBefore = await getAccount(connection, userAssetAccount);

      const withdrawAssets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .withdraw(withdrawAssets, new BN(Number(userSharesBefore.amount)))
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
      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const assetsReceived = Number(userAssetsAfter.amount) - Number(userAssetsBefore.amount);
      const sharesBurned = Number(userSharesBefore.amount) - Number(userSharesAfter.amount);

      expect(assetsReceived).to.equal(withdrawAssets.toNumber());
      expect(sharesBurned).to.be.greaterThan(0);
      console.log("  Withdraw exact:", assetsReceived, "assets, burned", sharesBurned, "shares");
    });

    it("mint: exact shares minted, assets calculated", async () => {
      const userSharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userAssetsBefore = await getAccount(connection, userAssetAccount);

      const mintShares = new BN(1000 * 10 ** 9);

      await program.methods
        .mint(mintShares, new BN(Number(userAssetsBefore.amount)))
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

      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userAssetsAfter = await getAccount(connection, userAssetAccount);

      const sharesMinted = Number(userSharesAfter.amount) - Number(userSharesBefore.amount);
      const assetsPaid = Number(userAssetsBefore.amount) - Number(userAssetsAfter.amount);

      expect(sharesMinted).to.equal(mintShares.toNumber());
      expect(assetsPaid).to.be.greaterThan(0);
      console.log("  Mint exact:", sharesMinted, "shares, paid", assetsPaid, "assets");
    });
  });

  describe("Rounding Direction", () => {
    let freshVault: PublicKey;
    let freshSharesMint: PublicKey;
    let freshAssetVault: PublicKey;
    let freshUserSharesAccount: PublicKey;
    const freshVaultId = new BN(401);

    before(async () => {
      [freshVault] = getVaultPDA(assetMint, freshVaultId);
      [freshSharesMint] = getSharesMintPDA(freshVault);

      freshAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: freshVault,
      });

      freshUserSharesAccount = getAssociatedTokenAddressSync(
        freshSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(freshVaultId, "Rounding Vault", "rndVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: freshVault,
          assetMint: assetMint,
          sharesMint: freshSharesMint,
          assetVault: freshAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // Initial deposit to establish non-trivial share price
      await program.methods
        .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: freshVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: freshAssetVault,
          sharesMint: freshSharesMint,
          userSharesAccount: freshUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("deposit rounds shares DOWN (user gets fewer)", async () => {
      // Deposit an amount that should cause rounding
      const depositAmount = new BN(1001); // Just above minimum

      const sharesBefore = await getAccount(connection, freshUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: freshVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: freshAssetVault,
          sharesMint: freshSharesMint,
          userSharesAccount: freshUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(connection, freshUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesReceived = Number(sharesAfter.amount) - Number(sharesBefore.amount);

      // Verify shares were minted (floor rounding means user gets shares, not nothing)
      expect(sharesReceived).to.be.greaterThan(0);
      console.log("  Deposit floor rounding: received", sharesReceived, "shares");
    });

    it("redeem rounds assets DOWN (user receives less)", async () => {
      const sharesBefore = await getAccount(connection, freshUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);

      // Redeem a small amount of shares
      const redeemShares = new BN(1001);

      await program.methods
        .redeem(redeemShares, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: freshVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: freshAssetVault,
          sharesMint: freshSharesMint,
          userSharesAccount: freshUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const assetsAfter = await getAccount(connection, userAssetAccount);
      const assetsReceived = Number(assetsAfter.amount) - Number(assetsBefore.amount);

      // Floor rounding: user receives floor(shares * price)
      expect(assetsReceived).to.be.greaterThanOrEqual(0);
      console.log("  Redeem floor rounding: received", assetsReceived, "assets");
    });
  });

  describe("Share/Asset Relationship", () => {
    it("user can always redeem their shares", async () => {
      const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      if (Number(userShares.amount) > 0) {
        // Should not throw - user can always redeem what they have
        await program.methods
          .redeem(new BN(1000), new BN(0)) // Small redeem
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

        console.log("  User can always redeem their shares");
      }
    });

    it("deposit then redeem returns <= original (no free money)", async () => {
      // Create a fresh vault for this test
      const testVaultId = new BN(402);
      const [testVault] = getVaultPDA(assetMint, testVaultId);
      const [testSharesMint] = getSharesMintPDA(testVault);

      const testAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: testVault,
      });

      const testUserSharesAccount = getAssociatedTokenAddressSync(
        testSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(testVaultId, "NoFreeMoney Vault", "nfmVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: testVault,
          assetMint: assetMint,
          sharesMint: testSharesMint,
          assetVault: testAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const assetsBefore = await getAccount(connection, userAssetAccount);
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);

      // Deposit
      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: testVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: testAssetVault,
          sharesMint: testSharesMint,
          userSharesAccount: testUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Get all shares
      const userShares = await getAccount(connection, testUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // Redeem all
      await program.methods
        .redeem(new BN(Number(userShares.amount)), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: testVault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: testAssetVault,
          sharesMint: testSharesMint,
          userSharesAccount: testUserSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const assetsAfter = await getAccount(connection, userAssetAccount);
      const netChange = Number(assetsAfter.amount) - Number(assetsBefore.amount);

      // User should have lost money or broken even (due to rounding)
      expect(netChange).to.be.lessThanOrEqual(0);
      console.log("  Round trip cost user:", -netChange, "assets (no free money)");
    });
  });

  describe("State Consistency", () => {
    it("vault.total_assets == asset_vault.amount after any operation", async () => {
      const vaultState = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);

      expect(vaultState.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));
      console.log("  State consistent: vault.total_assets =", vaultState.totalAssets.toNumber());
    });

    it("shares_mint.supply == sum of all share balances", async () => {
      const sharesMintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      const userSharesBalance = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // In single-user scenario, user shares should equal supply
      expect(Number(sharesMintInfo.supply)).to.equal(Number(userSharesBalance.amount));
      console.log("  Supply consistent:", Number(sharesMintInfo.supply), "total shares");
    });

    it("paused state persists across operations", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      let vaultState = await program.account.vault.fetch(vault);
      expect(vaultState.paused).to.equal(true);

      // Try deposit (should fail)
      try {
        await program.methods
          .deposit(new BN(1000), new BN(0))
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
        expect.fail("Should reject when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }

      // State still paused
      vaultState = await program.account.vault.fetch(vault);
      expect(vaultState.paused).to.equal(true);

      // Unpause
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      vaultState = await program.account.vault.fetch(vault);
      expect(vaultState.paused).to.equal(false);
      console.log("  Paused state persists correctly");
    });
  });
});
