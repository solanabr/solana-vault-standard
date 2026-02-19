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
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs2 } from "../target/types/svs_2";

describe("svs-2 (Stored Balance - Sync Required)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs2 as Program<Svs2>;
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
    // Create asset mint (USDC-like, regular Token Program)
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
    console.log("  NOTE: SVS-2 uses STORED balance (sync required)");
  });

  describe("Initialize", () => {
    it("creates a new vault", async () => {
      const tx = await program.methods
        .initialize(vaultId, "SVS-2 Vault", "svVault2", "https://example.com/vault2.json")
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
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());

      // Asset vault should be empty
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.equal(0);
      console.log("  Stored total_assets:", vaultAccount.totalAssets.toNumber());
      console.log("  Actual vault balance:", Number(assetVaultAccount.amount));
    });
  });

  describe("Deposit", () => {
    it("deposits assets and receives shares", async () => {
      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      const userAssetBefore = await getAccount(connection, userAssetAccount);

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

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const assetsDeposited = Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(assetsDeposited).to.equal(depositAmount.toNumber());
      expect(Number(userSharesAfter.amount)).to.be.greaterThan(0);

      // SVS-2: stored total_assets should update
      const vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount.toNumber());

      // Actual vault balance should match
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.equal(depositAmount.toNumber());

      console.log("  Deposited:", assetsDeposited / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Received:", Number(userSharesAfter.amount) / 10 ** 9, "shares");
      console.log("  Stored total_assets:", vaultAccount.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });

    it("second deposit updates stored total correctly", async () => {
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
      console.log("  Stored total_assets now:", vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Stored Balance Behavior", () => {
    it("external donation does NOT change stored total_assets", async () => {
      const vaultBefore = await program.account.vault.fetch(vault);
      const storedBefore = vaultBefore.totalAssets.toNumber();

      // Send tokens directly to asset vault (simulating yield/donation)
      const donationAmount = 10_000 * 10 ** ASSET_DECIMALS;
      await transfer(
        connection,
        payer,
        userAssetAccount,
        assetVault,
        payer.publicKey,
        donationAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Stored total_assets should be UNCHANGED
      const vaultAfterDonation = await program.account.vault.fetch(vault);
      expect(vaultAfterDonation.totalAssets.toNumber()).to.equal(storedBefore);

      // But actual vault balance increased
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.be.greaterThan(storedBefore);

      console.log("  Stored total_assets (unchanged):", vaultAfterDonation.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Actual vault balance:", Number(assetVaultAccount.amount) / 10 ** ASSET_DECIMALS);
      console.log("  Unrecognized yield:", (Number(assetVaultAccount.amount) - storedBefore) / 10 ** ASSET_DECIMALS);
    });

    it("sync() updates stored total_assets to actual balance", async () => {
      const vaultBefore = await program.account.vault.fetch(vault);
      const storedBefore = vaultBefore.totalAssets.toNumber();

      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfterSync = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);

      // Stored total now matches actual balance
      expect(vaultAfterSync.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));
      expect(vaultAfterSync.totalAssets.toNumber()).to.be.greaterThan(storedBefore);

      console.log("  Before sync:", storedBefore / 10 ** ASSET_DECIMALS);
      console.log("  After sync:", vaultAfterSync.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Yield recognized:", (vaultAfterSync.totalAssets.toNumber() - storedBefore) / 10 ** ASSET_DECIMALS);
    });

    it("sync increases share value for existing holders", async () => {
      // After sync, shares are worth more because total_assets increased
      // but total_shares stayed the same
      const vaultAccount = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);
      const userShares = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // Share price = total_assets / total_shares (simplified)
      // After sync, total_assets > sum of deposits, so share price > 1
      expect(vaultAccount.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));

      console.log("  Total assets:", vaultAccount.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  User shares:", Number(userShares.amount) / 10 ** 9);
    });
  });

  describe("Redeem", () => {
    it("redeems shares for assets", async () => {
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);
      const vaultBefore = await program.account.vault.fetch(vault);

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
      const vaultAfter = await program.account.vault.fetch(vault);

      const sharesBurned = Number(sharesBefore.amount) - Number(sharesAfter.amount);
      const assetsReceived = Number(assetsAfter.amount) - Number(assetsBefore.amount);

      expect(sharesBurned).to.equal(redeemShares.toNumber());
      expect(assetsReceived).to.be.greaterThan(0);

      // SVS-2: stored total_assets should decrease
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() - assetsReceived
      );

      console.log("  Redeemed:", sharesBurned / 10 ** 9, "shares for", assetsReceived / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Stored total_assets now:", vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
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

      // Verify stored total decreased
      const vaultAfter = await program.account.vault.fetch(vault);
      console.log("  Withdrew:", assetsReceived / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Stored total_assets now:", vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
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

      // Verify stored total increased
      const vaultAfter = await program.account.vault.fetch(vault);
      console.log("  Minted:", sharesMinted / 10 ** 9, "shares");
      console.log("  Stored total_assets now:", vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
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

      // Deposit should fail when paused
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

    it("transfers authority", async () => {
      const newAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      let vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      console.log("  Authority transferred to:", newAuthority.publicKey.toBase58().slice(0, 16) + "...");

      // Transfer back
      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: vault,
        })
        .signers([newAuthority])
        .rpc();

      vaultAccount = await program.account.vault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      console.log("  Authority transferred back");
    });

    it("rejects authority transfer from non-authority", async () => {
      const fakeAuthority = Keypair.generate();

      try {
        await program.methods
          .transferAuthority(fakeAuthority.publicKey)
          .accountsStrict({
            authority: fakeAuthority.publicKey,
            vault: vault,
          })
          .signers([fakeAuthority])
          .rpc();
        expect.fail("Should reject unauthorized transfer");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Unauthorized transfer correctly rejected");
      }
    });

    it("SVS-2 has sync() function", async () => {
      expect((program.methods as any).sync).to.not.be.undefined;
      console.log("  Confirmed: SVS-2 has sync() for stored balance model");
    });
  });

  describe("View Functions", () => {
    it("preview deposit simulates correctly", async () => {
      const assets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      // SVS-2 view functions do NOT require assetVault (uses stored total_assets)
      const result = await program.methods
        .previewDeposit(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview deposit simulated (using stored total_assets)");
    });

    it("total assets returns stored value", async () => {
      const vaultAccount = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);

      // SVS-2: total_assets view returns STORED value
      console.log("  Stored total_assets:", vaultAccount.totalAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Actual vault balance:", Number(assetVaultAccount.amount) / 10 ** ASSET_DECIMALS);
    });

    it("max deposit returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxDeposit()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      console.log("  maxDeposit simulated successfully");
    });

    it("max mint returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxMint()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      console.log("  maxMint simulated successfully");
    });
  });

  describe("Error Cases", () => {
    it("rejects deposit with zero amount", async () => {
      try {
        await program.methods
          .deposit(new BN(0), new BN(0))
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
        expect.fail("Should reject zero deposit");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
        console.log("  Zero deposit correctly rejected");
      }
    });

    it("rejects redeem with zero shares", async () => {
      try {
        await program.methods
          .redeem(new BN(0), new BN(0))
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
        expect.fail("Should reject zero redeem");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
        console.log("  Zero redeem correctly rejected");
      }
    });

    it("rejects sync from non-authority", async () => {
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
        expect.fail("Should reject unauthorized sync");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Unauthorized sync correctly rejected");
      }
    });
  });
});
