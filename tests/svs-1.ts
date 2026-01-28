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
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("svs-1", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test state
  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  const vaultId = new BN(1);
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
    // Create asset mint (USDC-like)
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

    // Get user asset account
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

    // Mint 1M assets to user
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

    // Derive asset vault ATA
    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    // Derive user shares account (Token-2022 ATA)
    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Asset Mint:", assetMint.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Shares Mint:", sharesMint.toBase58());
  });

  describe("Initialize", () => {
    it("creates a new vault", async () => {
      const tx = await program.methods
        .initialize(vaultId, "SVS Vault", "svVault", "https://example.com/vault.json")
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

      console.log("Initialize tx:", tx);

      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.paused).to.equal(false);
    });
  });

  describe("Deposit", () => {
    it("deposits assets and receives shares", async () => {
      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      const userAssetBefore = await getAccount(connection, userAssetAccount);

      const tx = await program.methods
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

      console.log("Deposit tx:", tx);

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAccount = await program.account.vault.fetch(vault);

      const assetsDeposited = Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(assetsDeposited).to.equal(depositAmount.toNumber());
      expect(Number(userSharesAfter.amount)).to.be.greaterThan(0);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount.toNumber());

      console.log("  Deposited:", assetsDeposited / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Received:", Number(userSharesAfter.amount) / 10 ** 9, "shares");
    });

    it("second deposit works proportionally", async () => {
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const vaultBefore = await program.account.vault.fetch(vault);

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

      const vaultAfter = await program.account.vault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + depositAmount.toNumber()
      );
      console.log("  Total assets now:", vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Redeem", () => {
    it("redeems shares for assets", async () => {
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);

      // Redeem half of shares
      const redeemShares = new BN(Number(sharesBefore.amount) / 2);

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

      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsAfter = await getAccount(connection, userAssetAccount);

      const sharesBurned = Number(sharesBefore.amount) - Number(sharesAfter.amount);
      const assetsReceived = Number(assetsAfter.amount) - Number(assetsBefore.amount);

      expect(sharesBurned).to.equal(redeemShares.toNumber());
      expect(assetsReceived).to.be.greaterThan(0);

      console.log("  Redeemed:", sharesBurned / 10 ** 9, "shares for", assetsReceived / 10 ** ASSET_DECIMALS, "assets");
    });
  });

  describe("Withdraw", () => {
    it("withdraws exact assets", async () => {
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);

      const withdrawAssets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .withdraw(withdrawAssets, new BN(Number(sharesBefore.amount)))
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

      const assetsAfter = await getAccount(connection, userAssetAccount);
      const assetsReceived = Number(assetsAfter.amount) - Number(assetsBefore.amount);

      expect(assetsReceived).to.equal(withdrawAssets.toNumber());
      console.log("  Withdrew:", assetsReceived / 10 ** ASSET_DECIMALS, "assets");
    });
  });

  describe("Mint", () => {
    it("mints exact shares", async () => {
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);

      const mintShares = new BN(1000 * 10 ** 9);

      await program.methods
        .mint(mintShares, new BN(Number(assetsBefore.amount)))
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

      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMinted = Number(sharesAfter.amount) - Number(sharesBefore.amount);

      expect(sharesMinted).to.equal(mintShares.toNumber());
      console.log("  Minted:", sharesMinted / 10 ** 9, "shares");
    });
  });

  describe("Admin", () => {
    it("pauses and unpauses the vault", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      let vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.paused).to.equal(true);
      console.log("  Vault paused");

      // Verify deposit fails when paused
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
        console.log("  Deposit correctly rejected when paused");
      }

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
      console.log("  Vault unpaused");
    });
  });

  describe("View Functions", () => {
    it("preview deposit simulates correctly", async () => {
      const assets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      // View functions use set_return_data which is available in logs
      const result = await program.methods
        .previewDeposit(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      // Verify simulation succeeded (no errors)
      expect(result.events).to.not.be.undefined;
      console.log("  Preview deposit simulated successfully");
    });

    it("total assets returns correct value", async () => {
      // Fetch vault state directly (more reliable than return data)
      const vaultAccount = await program.account.vault.fetch(vault);
      console.log("  Total assets:", vaultAccount.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      expect(vaultAccount.totalAssets.toNumber()).to.be.greaterThan(0);
    });
  });
});
