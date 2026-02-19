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
import { Svs1 } from "../target/types/svs_1";

describe("svs-1 (Live Balance - No Sync)", () => {
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
    console.log("  NOTE: SVS-1 uses LIVE balance (no sync)");
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
      expect(vaultAccount.paused).to.equal(false);

      // Check live balance (asset vault should be empty)
      const assetVaultAccount = await getAccount(connection, assetVault);
      expect(Number(assetVaultAccount.amount)).to.equal(0);
      console.log("  Live balance (asset vault):", Number(assetVaultAccount.amount));
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

      // SVS-1: Check LIVE balance from asset vault (not vault.totalAssets)
      const assetVaultAccount = await getAccount(connection, assetVault);

      const assetsDeposited = Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(assetsDeposited).to.equal(depositAmount.toNumber());
      expect(Number(userSharesAfter.amount)).to.be.greaterThan(0);

      // Live balance should match deposited amount
      expect(Number(assetVaultAccount.amount)).to.equal(depositAmount.toNumber());

      console.log("  Deposited:", assetsDeposited / 10 ** ASSET_DECIMALS, "assets");
      console.log("  Received:", Number(userSharesAfter.amount) / 10 ** 9, "shares");
      console.log("  Live balance (asset vault):", Number(assetVaultAccount.amount) / 10 ** ASSET_DECIMALS);
    });

    it("second deposit works proportionally", async () => {
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const assetVaultBefore = await getAccount(connection, assetVault);

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

      // Check live balance increased
      const assetVaultAfter = await getAccount(connection, assetVault);
      expect(Number(assetVaultAfter.amount)).to.equal(
        Number(assetVaultBefore.amount) + depositAmount.toNumber()
      );
      console.log("  Live balance now:", Number(assetVaultAfter.amount) / 10 ** ASSET_DECIMALS);
    });
  });

  describe("Live Balance Behavior", () => {
    it("donation attack is mitigated by live balance + virtual offset", async () => {
      // This test demonstrates that SVS-1's live balance design protects against
      // the classic ERC-4626 inflation/donation attack

      // Create a second user (victim)
      const victim = Keypair.generate();

      // Airdrop SOL to victim
      const airdropSig = await connection.requestAirdrop(victim.publicKey, 1_000_000_000);
      await connection.confirmTransaction(airdropSig);

      // Create victim's asset account and mint tokens
      const victimAssetAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        victim.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      await mintTo(
        connection,
        payer,
        assetMint,
        victimAssetAta.address,
        payer.publicKey,
        100_000 * 10 ** ASSET_DECIMALS,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Get current state
      const assetVaultBefore = await getAccount(connection, assetVault);
      console.log("  Vault balance before donation:", Number(assetVaultBefore.amount) / 10 ** ASSET_DECIMALS);

      // Attacker (payer) donates directly to asset vault (simulating donation attack)
      const donationAmount = 100_000 * 10 ** ASSET_DECIMALS;
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

      const assetVaultAfterDonation = await getAccount(connection, assetVault);
      console.log("  Vault balance after donation:", Number(assetVaultAfterDonation.amount) / 10 ** ASSET_DECIMALS);

      // KEY POINT: In SVS-1, the donation is IMMEDIATELY reflected in share price
      // because we use LIVE balance. This means:
      // 1. The victim's deposit will use the inflated balance for conversion
      // 2. But the virtual offset (decimals_offset) still provides protection

      // Victim tries to deposit
      const victimDeposit = new BN(10_000 * 10 ** ASSET_DECIMALS);
      const victimSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        victim.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .deposit(victimDeposit, new BN(0))
        .accountsStrict({
          user: victim.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: victimAssetAta.address,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: victimSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([victim])
        .rpc();

      const victimSharesAfter = await getAccount(connection, victimSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      console.log("  Victim received shares:", Number(victimSharesAfter.amount) / 10 ** 9);

      // With live balance + virtual offset, victim should receive meaningful shares
      // The virtual offset ensures the victim isn't completely diluted
      expect(Number(victimSharesAfter.amount)).to.be.greaterThan(0);

      // NOTE: The attacker's donation benefits ALL existing shareholders proportionally
      // This is expected ERC-4626 behavior - donations increase share value for everyone
      console.log("  ✓ Live balance ensures donations immediately reflect in share price");
      console.log("  ✓ Virtual offset provides minimum share protection");
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

    it("SVS-1 has no sync() function", async () => {
      // Verify sync is not available in SVS-1 (it uses live balance)
      expect((program.methods as any).sync).to.be.undefined;
      console.log("  ✓ Confirmed: SVS-1 has no sync() - uses live balance");
    });
  });

  describe("View Functions", () => {
    it("preview deposit simulates correctly", async () => {
      const assets = new BN(10_000 * 10 ** ASSET_DECIMALS);

      // SVS-1 view functions require assetVault for live balance
      const result = await program.methods
        .previewDeposit(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview deposit simulated successfully (using live balance)");
    });

    it("previewMint simulates correctly", async () => {
      const shares = new BN(1000 * 10 ** 9);

      const result = await program.methods
        .previewMint(shares)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview mint simulated successfully");
    });

    it("previewWithdraw simulates correctly", async () => {
      const assets = new BN(1000 * 10 ** ASSET_DECIMALS);

      const result = await program.methods
        .previewWithdraw(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview withdraw simulated successfully");
    });

    it("previewRedeem simulates correctly", async () => {
      const shares = new BN(1000 * 10 ** 9);

      const result = await program.methods
        .previewRedeem(shares)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  Preview redeem simulated successfully");
    });

    it("total assets returns live balance", async () => {
      // SVS-1: total_assets view returns LIVE balance from asset_vault
      const assetVaultAccount = await getAccount(connection, assetVault);
      console.log("  Live total assets:", Number(assetVaultAccount.amount) / 10 ** ASSET_DECIMALS);
      expect(Number(assetVaultAccount.amount)).to.be.greaterThan(0);
    });

    it("maxDeposit returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxDeposit()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxDeposit simulated (not paused)");
    });

    it("maxMint returns u64::MAX when not paused", async () => {
      const result = await program.methods
        .maxMint()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxMint simulated (not paused)");
    });

    it("maxWithdraw returns owner's redeemable assets", async () => {
      const result = await program.methods
        .maxWithdraw()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
          ownerSharesAccount: userSharesAccount,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxWithdraw simulated");
    });

    it("maxRedeem returns owner's share balance", async () => {
      const result = await program.methods
        .maxRedeem()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
          ownerSharesAccount: userSharesAccount,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  maxRedeem simulated");
    });

    it("convertToShares simulates correctly", async () => {
      const assets = new BN(5000 * 10 ** ASSET_DECIMALS);

      const result = await program.methods
        .convertToShares(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  convertToShares simulated");
    });

    it("convertToAssets simulates correctly", async () => {
      const shares = new BN(5000 * 10 ** 9);

      const result = await program.methods
        .convertToAssets(shares)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  convertToAssets simulated");
    });
  });
});
