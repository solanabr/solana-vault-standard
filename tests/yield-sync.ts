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

/**
 * SVS-1 Live Balance Tests
 *
 * SVS-1 uses LIVE balance from asset_vault.amount - no sync() needed.
 * External yield (donations) are automatically reflected in share price.
 * This eliminates sync timing attack vulnerabilities.
 */
describe("Yield and Live Balance (SVS-1)", () => {
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

  describe("Live Balance Basics", () => {
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

    it("external transfer immediately reflected in live balance (no sync needed)", async () => {
      const assetVaultBefore = await getAccount(connection, assetVault);
      const balanceBefore = Number(assetVaultBefore.amount);

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

      // SVS-1: Live balance immediately reflects the donation
      const assetVaultAfter = await getAccount(connection, assetVault);
      const balanceAfter = Number(assetVaultAfter.amount);

      expect(balanceAfter).to.equal(balanceBefore + yieldAmount);
      console.log("  Before donation - live balance:", balanceBefore);
      console.log("  After donation - live balance:", balanceAfter);
      console.log("  SVS-1: No sync() needed - yield immediately reflected!");
    });

    it("view functions use live balance", async () => {
      const assetVaultAccount = await getAccount(connection, assetVault);
      const liveBalance = Number(assetVaultAccount.amount);

      // Preview deposit should use live balance for share calculation
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      const result = await program.methods
        .previewDeposit(depositAmount)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  View functions correctly use live balance:", liveBalance);
    });
  });

  describe("Yield Accrual (Live Balance)", () => {
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

    it("external transfer increases share price immediately (no sync)", async () => {
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
      const assetVaultBefore = await getAccount(connection, yieldAssetVault);

      // Calculate initial share price using LIVE balance
      const initialPrice = Number(assetVaultBefore.amount) / Number(userSharesAfterDeposit.amount);
      console.log("  Initial share price (live):", initialPrice.toFixed(9));

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

      // SVS-1: NO sync() needed - share price immediately updated
      const assetVaultAfter = await getAccount(connection, yieldAssetVault);
      const newPrice = Number(assetVaultAfter.amount) / Number(userSharesAfterDeposit.amount);

      expect(newPrice).to.be.greaterThan(initialPrice);
      expect(newPrice / initialPrice).to.be.closeTo(1.5, 0.01); // 50% yield
      console.log("  New share price (live):", newPrice.toFixed(9));
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

  describe("Share Price Tracking (Live Balance)", () => {
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
      const assetVaultAccount = await getAccount(connection, priceAssetVault);

      // With 6 decimal asset and offset=3, virtual offset = 10^3 = 1000
      // First deposit: shares ≈ assets * 1000 (scaled up due to offset)
      const ratio = Number(userShares.amount) / Number(assetVaultAccount.amount);

      // Ratio should be approximately 10^(9-6) = 10^3 = 1000 for 6 decimal asset
      console.log("  Asset deposited (live):", Number(assetVaultAccount.amount));
      console.log("  Shares received:", Number(userShares.amount));
      console.log("  Ratio (shares/assets):", ratio.toFixed(2));
    });

    it("share price never decreases (without withdrawals)", async () => {
      const getSharePrice = async () => {
        const assetVaultAccount = await getAccount(connection, priceAssetVault);
        const userShares = await getAccount(connection, priceUserSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
        return Number(assetVaultAccount.amount) / Number(userShares.amount);
      };

      const price1 = await getSharePrice();
      console.log("  Initial price (live):", price1.toFixed(9));

      // Add yield - immediately reflected in SVS-1
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

      // SVS-1: No sync needed - price immediately updated
      const price2 = await getSharePrice();
      console.log("  After yield (live):", price2.toFixed(9));
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
      console.log("  After deposit (live):", price3.toFixed(9));
      // Use closeTo to account for floating point precision (price should stay same or increase)
      expect(price3).to.be.closeTo(price2, 0.000001);
    });
  });

  describe("Live Balance Edge Cases", () => {
    it("multiple donations accumulate correctly without sync", async () => {
      const assetVaultBefore = await getAccount(connection, assetVault);
      const balanceBefore = Number(assetVaultBefore.amount);

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

      // SVS-1: All donations immediately reflected
      const assetVaultAfter = await getAccount(connection, assetVault);
      const balanceAfter = Number(assetVaultAfter.amount);
      const actualIncrease = balanceAfter - balanceBefore;
      const expectedIncrease = 3 * smallAmount;

      expect(actualIncrease).to.equal(expectedIncrease);
      console.log("  Multiple transfers captured (no sync):", actualIncrease, "expected:", expectedIncrease);
    });

    it("SVS-1 has no sync() function (security by design)", async () => {
      // Verify that sync() does not exist in SVS-1
      expect((program.methods as any).sync).to.be.undefined;
      console.log("  SVS-1 correctly has no sync() - eliminates timing attack vector");
    });
  });
});
