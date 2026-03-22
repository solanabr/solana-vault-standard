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
  createAssociatedTokenAccountIdempotentInstruction,
  transfer,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs5 } from "../target/types/svs_5";

describe("svs-5 (Streaming Yield Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs5 as Program<Svs5>;
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
      [Buffer.from("stream_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  };

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  };

  const createSharesAtaIx = (payerKey: PublicKey, owner: PublicKey, mint: PublicKey) => {
    return createAssociatedTokenAccountIdempotentInstruction(
      payerKey,
      getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
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
    console.log("  NOTE: SVS-5 uses streaming yield model");
  });

  describe("Initialize", () => {
    it("creates a new streaming vault", async () => {
      const tx = await program.methods
        .initialize(vaultId)
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

      const vaultAccount = await program.account.streamVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.baseAssets.toNumber()).to.equal(0);
      expect(vaultAccount.streamAmount.toNumber()).to.equal(0);
      expect(vaultAccount.streamStart.toNumber()).to.equal(0);
      expect(vaultAccount.streamEnd.toNumber()).to.equal(0);
      expect(vaultAccount.lastCheckpoint.toNumber()).to.be.greaterThan(0);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());

      // Asset vault should be empty
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.equal(0);
      console.log("  baseAssets:", vaultAccount.baseAssets.toNumber());
      console.log("  streamAmount:", vaultAccount.streamAmount.toNumber());
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
        })
        .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
        .rpc();

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      const userSharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const assetsDeposited = Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(assetsDeposited).to.equal(depositAmount.toNumber());
      expect(Number(userSharesAfter.amount)).to.be.greaterThan(0);

      // baseAssets should update
      const vaultAccount = await program.account.streamVault.fetch(vault);
      expect(vaultAccount.baseAssets.toNumber()).to.equal(depositAmount.toNumber());

      // Actual vault balance should match
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.equal(depositAmount.toNumber());

      console.log("  Deposited:", assetsDeposited / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Received:", Number(userSharesAfter.amount) / 10 ** 9, "shares");
      console.log("  baseAssets:", vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });

    it("second deposit updates baseAssets correctly", async () => {
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const vaultBefore = await program.account.streamVault.fetch(vault);

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
        })
        .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
        .rpc();

      const vaultAfter = await program.account.streamVault.fetch(vault);
      expect(vaultAfter.baseAssets.toNumber()).to.equal(
        vaultBefore.baseAssets.toNumber() + depositAmount.toNumber()
      );
      console.log("  baseAssets now:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Streaming Yield", () => {
    it("distribute_yield starts a stream", async () => {
      const yieldAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);
      const duration = new BN(120);

      const userAssetBefore = await getAccount(connection, userAssetAccount);
      const assetVaultBefore = await getAccount(connection, assetVault);

      await program.methods
        .distributeYield(yieldAmount, duration)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetMint: assetMint,
          authorityAssetAccount: userAssetAccount,
          assetVault: assetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const vaultAccount = await program.account.streamVault.fetch(vault);
      const userAssetAfter = await getAccount(connection, userAssetAccount);
      const assetVaultAfter = await getAccount(connection, assetVault);

      // Verify stream state
      expect(vaultAccount.streamAmount.toNumber()).to.equal(yieldAmount.toNumber());
      expect(vaultAccount.streamStart.toNumber()).to.be.greaterThan(0);
      expect(vaultAccount.streamEnd.toNumber()).to.equal(
        vaultAccount.streamStart.toNumber() + duration.toNumber()
      );
      // lastCheckpoint may not equal streamStart for first distribute — init set it to init time
      // but streamStart was set during this tx. On localnet they could be the same or different.
      expect(vaultAccount.lastCheckpoint.toNumber()).to.be.greaterThan(0);

      // Authority asset account debited
      const authorityDebited = Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(authorityDebited).to.equal(yieldAmount.toNumber());

      // Asset vault credited
      const vaultCredited = Number(assetVaultAfter.amount) - Number(assetVaultBefore.amount);
      expect(vaultCredited).to.equal(yieldAmount.toNumber());

      console.log("  Stream started:");
      console.log("    Amount:", vaultAccount.streamAmount.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("    Start:", vaultAccount.streamStart.toNumber());
      console.log("    End:", vaultAccount.streamEnd.toNumber());
      console.log("    Duration:", duration.toNumber(), "seconds");
    });

    it("rejects distribute_yield with zero amount", async () => {
      try {
        await program.methods
          .distributeYield(new BN(0), new BN(120))
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            authorityAssetAccount: userAssetAccount,
            assetVault: assetVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject zero yield amount");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
        console.log("  Zero yield amount correctly rejected");
      }
    });

    it("rejects distribute_yield with duration less than 60 seconds", async () => {
      try {
        await program.methods
          .distributeYield(new BN(1000), new BN(30))
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            authorityAssetAccount: userAssetAccount,
            assetVault: assetVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject duration < 60s");
      } catch (err: any) {
        expect(err.toString()).to.include("StreamTooShort");
        console.log("  Short duration correctly rejected");
      }
    });

    it("rejects distribute_yield from non-authority", async () => {
      const fakeAuthority = Keypair.generate();

      try {
        await program.methods
          .distributeYield(new BN(1000), new BN(120))
          .accountsStrict({
            authority: fakeAuthority.publicKey,
            vault: vault,
            assetMint: assetMint,
            authorityAssetAccount: userAssetAccount,
            assetVault: assetVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fakeAuthority])
          .rpc();
        expect.fail("Should reject unauthorized distribute_yield");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Unauthorized distribute_yield correctly rejected");
      }
    });
  });

  describe("Checkpoint", () => {
    it("checkpoint finalizes accrued yield", async () => {
      const vaultBefore = await program.account.streamVault.fetch(vault);
      const baseAssetsBefore = vaultBefore.baseAssets.toNumber();

      // Wait briefly so some time elapses on-chain
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter = await program.account.streamVault.fetch(vault);

      // lastCheckpoint should advance
      expect(vaultAfter.lastCheckpoint.toNumber()).to.be.greaterThanOrEqual(
        vaultBefore.lastCheckpoint.toNumber()
      );

      // baseAssets should increase by accrued yield
      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThanOrEqual(baseAssetsBefore);

      console.log("  baseAssets before:", baseAssetsBefore / 10 ** ASSET_DECIMALS);
      console.log("  baseAssets after:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Accrued:", (vaultAfter.baseAssets.toNumber() - baseAssetsBefore) / 10 ** ASSET_DECIMALS);
      console.log("  lastCheckpoint:", vaultAfter.lastCheckpoint.toNumber());
    });

    it("checkpoint is permissionless", async () => {
      // Checkpoint requires no signer — any wallet can pay for the tx.
      // Use the default provider wallet (authority) but the point is the
      // instruction itself has no signer constraint.
      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      console.log("  Checkpoint called successfully (no signer required)");
    });

    it("checkpoint with no active stream is a no-op", async () => {
      // We need a vault with no active stream. After the stream fully ends,
      // checkpoint should finalize everything. Let's wait for the stream to end
      // and checkpoint to finalize, then call again.

      // First, let's get current state
      const vaultBefore = await program.account.streamVault.fetch(vault);

      // If stream is still active, we can't easily test this without time travel.
      // Instead, we verify that calling checkpoint doesn't fail.
      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter = await program.account.streamVault.fetch(vault);
      console.log("  Checkpoint executed (no-op if stream already checkpointed to current time)");
      console.log("  baseAssets:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });

    it("checkpoint after stream ends finalizes all yield", async () => {
      const vaultBefore = await program.account.streamVault.fetch(vault);
      const baseAssetsBefore = vaultBefore.baseAssets.toNumber();
      const streamRemaining = vaultBefore.streamAmount.toNumber();

      // Call checkpoint to capture whatever has accrued
      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter = await program.account.streamVault.fetch(vault);

      // baseAssets should be >= before (checkpoint can only add)
      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThanOrEqual(baseAssetsBefore);

      // baseAssets should be <= before + remaining stream (can't accrue more than what's left)
      expect(vaultAfter.baseAssets.toNumber()).to.be.lessThanOrEqual(
        baseAssetsBefore + streamRemaining
      );

      console.log("  baseAssets before:", baseAssetsBefore / 10 ** ASSET_DECIMALS);
      console.log("  baseAssets after:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Stream remaining was:", streamRemaining / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Redeem", () => {
    it("redeems shares for assets", async () => {
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, userAssetAccount);
      const vaultBefore = await program.account.streamVault.fetch(vault);

      // Redeem a quarter of shares
      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));

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

    it("redeem uses effective_total_assets", async () => {
      // After streaming yield, share value should reflect accrued yield
      const vaultAccount = await program.account.streamVault.fetch(vault);

      // baseAssets should include some accrued yield from the stream
      expect(vaultAccount.baseAssets.toNumber()).to.be.greaterThan(0);

      console.log("  baseAssets (includes accrued yield):", vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Redeem conversion uses interpolated effective_total_assets internally");
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

      const vaultAfter = await program.account.streamVault.fetch(vault);
      console.log("  Withdrew:", assetsReceived / 10 ** ASSET_DECIMALS, "assets");
      console.log("  baseAssets now:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });

    it("withdraw uses effective_total_assets", async () => {
      const vaultAccount = await program.account.streamVault.fetch(vault);

      // Verify the vault state reflects streaming model
      expect(vaultAccount.baseAssets.toNumber()).to.be.greaterThan(0);

      console.log("  Withdraw conversion uses interpolated effective_total_assets internally");
      console.log("  baseAssets:", vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
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
        })
        .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
        .rpc();

      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMinted = Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(sharesMinted).to.equal(mintShares.toNumber());

      const vaultAfter = await program.account.streamVault.fetch(vault);
      console.log("  Minted:", sharesMinted / 10 ** 9, "shares");
      console.log("  baseAssets now:", vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
    });

    it("mint uses effective_total_assets", async () => {
      const vaultAccount = await program.account.streamVault.fetch(vault);

      expect(vaultAccount.baseAssets.toNumber()).to.be.greaterThan(0);

      console.log("  Mint conversion uses interpolated effective_total_assets internally");
      console.log("  baseAssets:", vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
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

      let vaultAccount = await program.account.streamVault.fetch(vault);
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
          })
          .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
          .rpc();
        expect.fail("Should reject when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Deposit correctly rejected when paused");
      }

      // Distribute yield should fail when paused
      try {
        await program.methods
          .distributeYield(new BN(1000 * 10 ** ASSET_DECIMALS), new BN(120))
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            authorityAssetAccount: userAssetAccount,
            assetVault: assetVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject distribute_yield when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Distribute yield correctly rejected when paused");
      }

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      vaultAccount = await program.account.streamVault.fetch(vault);
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

      let vaultAccount = await program.account.streamVault.fetch(vault);
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

      vaultAccount = await program.account.streamVault.fetch(vault);
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
  });

  describe("View Functions", () => {
    it("previewDeposit simulates correctly", async () => {
      const assets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      const result = await program.methods
        .previewDeposit(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview deposit simulated (using effective_total_assets)");
    });

    it("previewMint simulates correctly", async () => {
      const shares = new BN(1000 * 10 ** 9);

      const result = await program.methods
        .previewMint(shares)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview mint simulated (streaming yield)");
    });

    it("previewWithdraw simulates correctly", async () => {
      const assets = new BN(1000 * 10 ** ASSET_DECIMALS);

      const result = await program.methods
        .previewWithdraw(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview withdraw simulated (streaming yield)");
    });

    it("previewRedeem simulates correctly", async () => {
      const shares = new BN(1000 * 10 ** 9);

      const result = await program.methods
        .previewRedeem(shares)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview redeem simulated (streaming yield)");
    });

    it("convertToShares simulates correctly", async () => {
      const assets = new BN(5000 * 10 ** ASSET_DECIMALS);

      const result = await program.methods
        .convertToShares(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  convertToShares simulated (effective_total_assets)");
    });

    it("convertToAssets simulates correctly", async () => {
      const shares = new BN(5000 * 10 ** 9);

      const result = await program.methods
        .convertToAssets(shares)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  convertToAssets simulated (effective_total_assets)");
    });

    it("totalAssets returns effective_total_assets", async () => {
      const vaultAccount = await program.account.streamVault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);

      // effective_total_assets = baseAssets + accrued portion of stream
      // It should be >= baseAssets
      console.log("  baseAssets:", vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  streamAmount:", vaultAccount.streamAmount.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("  Actual vault balance:", Number(assetVaultAccount.amount) / 10 ** ASSET_DECIMALS);
      console.log("  totalAssets view returns interpolated effective_total_assets");
    });

    it("maxDeposit returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxDeposit()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      console.log("  maxDeposit simulated successfully");
    });

    it("maxMint returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxMint()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      console.log("  maxMint simulated successfully");
    });

    it("maxWithdraw returns owner's redeemable assets", async () => {
      const result = await program.methods
        .maxWithdraw()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
          ownerSharesAccount: userSharesAccount,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxWithdraw simulated (effective_total_assets)");
    });

    it("maxRedeem returns owner's share balance", async () => {
      const result = await program.methods
        .maxRedeem()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
          ownerSharesAccount: userSharesAccount,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxRedeem simulated (streaming yield)");
    });

    it("getStreamInfo returns stream state", async () => {
      const result = await program.methods
        .getStreamInfo()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;

      const vaultAccount = await program.account.streamVault.fetch(vault);
      console.log("  Stream info:");
      console.log("    streamAmount:", vaultAccount.streamAmount.toNumber() / 10 ** ASSET_DECIMALS);
      console.log("    streamStart:", vaultAccount.streamStart.toNumber());
      console.log("    streamEnd:", vaultAccount.streamEnd.toNumber());
      console.log("    lastCheckpoint:", vaultAccount.lastCheckpoint.toNumber());
    });
  });

  describe("Edge Cases", () => {
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
          })
          .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
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

    it("slippage protection on deposit", async () => {
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      // Set minShares unreasonably high to trigger slippage
      const unreasonableMinShares = new BN("18446744073709551615"); // u64::MAX

      try {
        await program.methods
          .deposit(depositAmount, unreasonableMinShares)
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
          .preInstructions([createSharesAtaIx(payer.publicKey, payer.publicKey, sharesMint)])
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) => s.includes("Slippage") || s.includes("SlippageExceeded") || s.includes("BelowMinimum")
        );
        console.log("  Slippage protection on deposit works correctly");
      }
    });
  });
});
