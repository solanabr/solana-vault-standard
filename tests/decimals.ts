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

describe("Different Decimals", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

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

  const setupVault = async (decimals: number, vaultId: BN) => {
    const assetMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      decimals,
      Keypair.generate(),
      undefined,
      TOKEN_PROGRAM_ID
    );

    const [vault] = getVaultPDA(assetMint, vaultId);
    const [sharesMint] = getSharesMintPDA(vault);

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

    // Mint 1M base units
    await mintTo(
      connection,
      payer,
      assetMint,
      userAssetAta.address,
      payer.publicKey,
      1_000_000 * 10 ** decimals,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    const assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .initialize(vaultId, `Vault ${decimals}d`, `v${decimals}d`, "https://example.com")
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

    return {
      assetMint,
      vault,
      sharesMint,
      assetVault,
      userAssetAccount: userAssetAta.address,
      userSharesAccount,
      decimals,
    };
  };

  describe("0 Decimal Token", () => {
    let ctx: Awaited<ReturnType<typeof setupVault>>;
    const vaultId = new BN(100);

    before(async () => {
      ctx = await setupVault(0, vaultId);
    });

    it("initializes vault with 0 decimal token", async () => {
      const vaultAccount = await program.account.vault.fetch(ctx.vault);
      expect(vaultAccount.decimalsOffset).to.equal(9); // 9 - 0 = 9
      console.log("  0 decimal token: decimals_offset = 9");
    });

    it("deposits whole units only", async () => {
      const depositAmount = new BN(1001); // Above MIN_DEPOSIT_AMOUNT (1000)

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAccount = await program.account.vault.fetch(ctx.vault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(1001);
      console.log("  Deposited 1001 whole units successfully");
    });

    it("share price calculation correct for 0 decimals", async () => {
      const userShares = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAccount = await program.account.vault.fetch(ctx.vault);

      // With offset of 9, shares should be scaled up significantly
      // shares = assets * (total_shares + 10^9) / (total_assets + 1)
      // For first deposit: shares ≈ assets * 10^9
      expect(Number(userShares.amount)).to.be.greaterThan(vaultAccount.totalAssets.toNumber());
      console.log("  Shares:", Number(userShares.amount), "Assets:", vaultAccount.totalAssets.toNumber());
    });

    it("redeem works with 0 decimal token", async () => {
      const sharesBefore = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, ctx.userAssetAccount);

      // Redeem 10% of shares
      const redeemShares = new BN(Number(sharesBefore.amount) / 10);

      await program.methods
        .redeem(redeemShares, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const assetsAfter = await getAccount(connection, ctx.userAssetAccount);
      const assetsReceived = Number(assetsAfter.amount) - Number(assetsBefore.amount);
      expect(assetsReceived).to.be.greaterThan(0);
      console.log("  Redeemed for", assetsReceived, "whole units");
    });
  });

  describe("6 Decimal Token (USDC-like)", () => {
    let ctx: Awaited<ReturnType<typeof setupVault>>;
    const vaultId = new BN(101);

    before(async () => {
      ctx = await setupVault(6, vaultId);
    });

    it("initializes correctly with decimals_offset = 3", async () => {
      const vaultAccount = await program.account.vault.fetch(ctx.vault);
      expect(vaultAccount.decimalsOffset).to.equal(3); // 9 - 6 = 3
      console.log("  6 decimal token: decimals_offset = 3");
    });

    it("standard deposit/redeem operations work", async () => {
      const depositAmount = new BN(1000 * 10 ** 6); // 1000 USDC

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userShares = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(userShares.amount)).to.be.greaterThan(0);
      console.log("  Deposited 1000 USDC, received", Number(userShares.amount) / 10 ** 9, "shares");
    });

    it("proportional second deposit", async () => {
      const vaultBefore = await program.account.vault.fetch(ctx.vault);
      const sharesBefore = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const depositAmount = new BN(500 * 10 ** 6); // 500 USDC (half of first deposit)

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const newShares = Number(sharesAfter.amount) - Number(sharesBefore.amount);

      // New shares should be roughly half of original (proportional)
      const firstShares = Number(sharesBefore.amount);
      const ratio = newShares / firstShares;
      expect(ratio).to.be.closeTo(0.5, 0.01);
      console.log("  Second deposit ratio:", ratio.toFixed(4));
    });
  });

  describe("9 Decimal Token (SOL-like)", () => {
    let ctx: Awaited<ReturnType<typeof setupVault>>;
    const vaultId = new BN(102);

    before(async () => {
      ctx = await setupVault(9, vaultId);
    });

    it("initializes correctly with decimals_offset = 0", async () => {
      const vaultAccount = await program.account.vault.fetch(ctx.vault);
      expect(vaultAccount.decimalsOffset).to.equal(0); // 9 - 9 = 0
      console.log("  9 decimal token: decimals_offset = 0");
    });

    it("1:1 share ratio in empty vault (approximately)", async () => {
      const depositAmount = new BN(1 * 10 ** 9); // 1 SOL

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userShares = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAccount = await program.account.vault.fetch(ctx.vault);

      // With offset=0, virtual_shares = total_shares + 1, virtual_assets = total_assets + 1
      // First deposit: shares ≈ assets (close to 1:1)
      const ratio = Number(userShares.amount) / vaultAccount.totalAssets.toNumber();
      expect(ratio).to.be.closeTo(1.0, 0.01);
      console.log("  9-decimal share/asset ratio:", ratio.toFixed(6));
    });

    it("mint works correctly with 9 decimals", async () => {
      const sharesBefore = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const assetsBefore = await getAccount(connection, ctx.userAssetAccount);

      const mintShares = new BN(0.5 * 10 ** 9); // 0.5 shares

      await program.methods
        .mint(mintShares, new BN(Number(assetsBefore.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          assetMint: ctx.assetMint,
          userAssetAccount: ctx.userAssetAccount,
          assetVault: ctx.assetVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount: ctx.userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMinted = Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(sharesMinted).to.equal(mintShares.toNumber());
      console.log("  Minted exactly", sharesMinted / 10 ** 9, "shares");
    });
  });

  describe("Cross-Decimal Consistency", () => {
    it("rounding protection works at all decimal levels", async () => {
      // Test that small deposits still work and don't cause issues
      const testDecimals = [0, 6, 9];
      const results: { decimals: number; shares: number; assets: number }[] = [];

      for (let i = 0; i < testDecimals.length; i++) {
        const decimals = testDecimals[i];
        const vaultId = new BN(200 + i);
        const ctx = await setupVault(decimals, vaultId);

        // Deposit minimum amount (just above MIN_DEPOSIT_AMOUNT = 1000)
        const depositAmount = new BN(1001);

        await program.methods
          .deposit(depositAmount, new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            assetMint: ctx.assetMint,
            userAssetAccount: ctx.userAssetAccount,
            assetVault: ctx.assetVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount: ctx.userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        const userShares = await getAccount(connection, ctx.userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
        results.push({
          decimals,
          shares: Number(userShares.amount),
          assets: 1001,
        });
      }

      // All should have received shares
      for (const result of results) {
        expect(result.shares).to.be.greaterThan(0);
        console.log(`  ${result.decimals} decimals: ${result.assets} assets → ${result.shares} shares`);
      }
    });

    it("share decimals always 9 regardless of asset decimals", async () => {
      // Verify shares mint always has 9 decimals
      const testDecimals = [0, 6, 9];

      for (let i = 0; i < testDecimals.length; i++) {
        const decimals = testDecimals[i];
        const vaultId = new BN(300 + i);
        const ctx = await setupVault(decimals, vaultId);

        const sharesMintInfo = await getMint(connection, ctx.sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
        expect(sharesMintInfo.decimals).to.equal(9);
      }

      console.log("  All share mints have 9 decimals");
    });
  });
});
