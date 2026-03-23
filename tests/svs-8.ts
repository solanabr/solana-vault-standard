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
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs8 } from "../target/types/svs_8";

describe("svs-8 (Multi-Asset Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs8 as Program<Svs8>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Constants matching the program
  const VAULT_SEED = Buffer.from("multi_vault");
  const SHARES_MINT_SEED = Buffer.from("shares");
  const ASSET_ENTRY_SEED = Buffer.from("asset_entry");
  const SHARES_DECIMALS = 9;
  const BASE_DECIMALS = 6;

  // Test state
  const vaultId = new BN(1);
  let vault: PublicKey;
  let sharesMint: PublicKey;

  // Asset mints
  const USDC_DECIMALS = 6;
  const SOL_DECIMALS = 9;
  const BONK_DECIMALS = 5;
  let usdcMint: PublicKey;
  let solMint: PublicKey;
  let bonkMint: PublicKey;

  // Oracle keypairs (mock: [price_u64, updated_at_i64] = 16 bytes)
  let usdcOracle: Keypair;
  let solOracle: Keypair;
  let bonkOracle: Keypair;

  // Asset entries (PDAs)
  let usdcEntry: PublicKey;
  let solEntry: PublicKey;
  let bonkEntry: PublicKey;

  // Asset vault token accounts (ATAs owned by vault PDA)
  let usdcVault: PublicKey;
  let solVault: PublicKey;
  let bonkVault: PublicKey;

  // User token accounts
  let userUsdcAccount: PublicKey;
  let userSolAccount: PublicKey;
  let userBonkAccount: PublicKey;
  let userSharesAccount: PublicKey;

  // Prices in base units (USDC base, 1e6 = $1)
  const USDC_PRICE = 1_000_000;
  const SOL_PRICE = 150_000_000;
  const BONK_PRICE = 2;

  // PDA helpers
  const getVaultPDA = (id: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [VAULT_SEED, id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

  const getSharesMintPDA = (v: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([SHARES_MINT_SEED, v.toBuffer()], program.programId);

  const getAssetEntryPDA = (v: PublicKey, mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [ASSET_ENTRY_SEED, v.toBuffer(), mint.toBuffer()],
      program.programId
    );

  // Create a mock oracle account owned by the SVS-8 program with 16 bytes of space.
  // The data will be zero-initialized. For full integration tests with actual
  // oracle prices, use bankrun or validator fixtures to write oracle data.
  async function createMockOracleAccount(): Promise<Keypair> {
    const kp = Keypair.generate();
    const space = 16;
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports,
        space,
        programId: program.programId,
      })
    );
    await sendAndConfirmTransaction(connection, tx, [payer, kp]);
    return kp;
  }

  async function setOraclePrice(oracle: PublicKey, price: number, timestamp?: number) {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    await program.methods
      .setOracleData(new BN(price), new BN(ts))
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        oracle,
      })
      .rpc();
  }

  // remaining_accounts helpers
  function oracleRemainingAccounts(
    entries: { entry: PublicKey; vault: PublicKey; oracle: PublicKey }[]
  ) {
    return entries.flatMap((e) => [
      { pubkey: e.entry, isSigner: false, isWritable: false },
      { pubkey: e.vault, isSigner: false, isWritable: false },
      { pubkey: e.oracle, isSigner: false, isWritable: false },
    ]);
  }

  function depositProportionalRemaining(
    entries: {
      entry: PublicKey; vault: PublicKey; oracle: PublicKey;
      mint: PublicKey; userAta: PublicKey; tokenProgram: PublicKey;
    }[]
  ) {
    return entries.flatMap((e) => [
      { pubkey: e.entry, isSigner: false, isWritable: false },
      { pubkey: e.vault, isSigner: false, isWritable: true },
      { pubkey: e.oracle, isSigner: false, isWritable: false },
      { pubkey: e.mint, isSigner: false, isWritable: false },
      { pubkey: e.userAta, isSigner: false, isWritable: true },
      { pubkey: e.tokenProgram, isSigner: false, isWritable: false },
    ]);
  }

  function redeemProportionalRemaining(
    entries: {
      entry: PublicKey; vault: PublicKey;
      mint: PublicKey; userAta: PublicKey; tokenProgram: PublicKey;
    }[]
  ) {
    return entries.flatMap((e) => [
      { pubkey: e.entry, isSigner: false, isWritable: false },
      { pubkey: e.vault, isSigner: false, isWritable: true },
      { pubkey: e.mint, isSigner: false, isWritable: false },
      { pubkey: e.userAta, isSigner: false, isWritable: true },
      { pubkey: e.tokenProgram, isSigner: false, isWritable: false },
    ]);
  }

  before(async () => {
    [vault] = getVaultPDA(vaultId);
    [sharesMint] = getSharesMintPDA(vault);

    // Create asset mints
    usdcMint = await createMint(
      connection, payer, payer.publicKey, null, USDC_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );
    solMint = await createMint(
      connection, payer, payer.publicKey, null, SOL_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );
    bonkMint = await createMint(
      connection, payer, payer.publicKey, null, BONK_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );

    // Create user token accounts
    userUsdcAccount = (await getOrCreateAssociatedTokenAccount(
      connection, payer, usdcMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    )).address;
    userSolAccount = (await getOrCreateAssociatedTokenAccount(
      connection, payer, solMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    )).address;
    userBonkAccount = (await getOrCreateAssociatedTokenAccount(
      connection, payer, bonkMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    )).address;

    // Mint tokens to user
    await mintTo(connection, payer, usdcMint, userUsdcAccount, payer, 1_000_000 * 10 ** USDC_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, payer, solMint, userSolAccount, payer, 10_000 * 10 ** SOL_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(connection, payer, bonkMint, userBonkAccount, payer, 1_000_000_000 * 10 ** BONK_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);

    // Create mock oracle accounts
    usdcOracle = await createMockOracleAccount();
    solOracle = await createMockOracleAccount();
    bonkOracle = await createMockOracleAccount();

    // Derive PDAs
    [usdcEntry] = getAssetEntryPDA(vault, usdcMint);
    [solEntry] = getAssetEntryPDA(vault, solMint);
    [bonkEntry] = getAssetEntryPDA(vault, bonkMint);

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Shares Mint:", sharesMint.toBase58());
    console.log("  USDC Mint:", usdcMint.toBase58());
    console.log("  SOL Mint:", solMint.toBase58());
    console.log("  BONK Mint:", bonkMint.toBase58());
  });

  // ============================================================
  // Initialize
  // ============================================================
  describe("Initialize", () => {
    it("creates a new multi-asset vault", async () => {
      const tx = await program.methods
        .initialize(vaultId, BASE_DECIMALS)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          sharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("  Initialize tx:", tx);

      const v = await program.account.multiAssetVault.fetch(vault);
      expect(v.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(v.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(v.paused).to.equal(false);
      expect(v.numAssets).to.equal(0);
      expect(v.baseDecimals).to.equal(BASE_DECIMALS);
      expect(v.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(v.decimalsOffset).to.equal(9 - BASE_DECIMALS);

      const mint = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      expect(mint.decimals).to.equal(SHARES_DECIMALS);
      expect(mint.supply).to.equal(0n);
    });

    it("rejects base_decimals > 9", async () => {
      const badId = new BN(999);
      const [badVault] = getVaultPDA(badId);
      const [badMint] = getSharesMintPDA(badVault);

      try {
        await program.methods
          .initialize(badId, 10)
          .accountsStrict({
            authority: payer.publicKey,
            vault: badVault,
            sharesMint: badMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("InvalidAssetDecimals");
      }
    });
  });

  // ============================================================
  // Add Asset
  // ============================================================
  describe("Add Asset", () => {
    it("adds USDC (50% weight, index 0)", async () => {
      usdcVault = getAssociatedTokenAddressSync(
        usdcMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .addAsset(5000, 2)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint: usdcMint,
          oracle: usdcOracle.publicKey,
          assetEntry: usdcEntry,
          assetVault: usdcVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const v = await program.account.multiAssetVault.fetch(vault);
      expect(v.numAssets).to.equal(1);

      const e = await program.account.assetEntry.fetch(usdcEntry);
      expect(e.targetWeightBps).to.equal(5000);
      expect(e.assetDecimals).to.equal(USDC_DECIMALS);
      expect(e.index).to.equal(0);
    });

    it("adds SOL (30% weight, index 1)", async () => {
      solVault = getAssociatedTokenAddressSync(
        solMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .addAsset(3000, 2)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint: solMint,
          oracle: solOracle.publicKey,
          assetEntry: solEntry,
          assetVault: solVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: usdcEntry, isSigner: false, isWritable: false },
        ])
        .rpc();

      expect((await program.account.multiAssetVault.fetch(vault)).numAssets).to.equal(2);
      expect((await program.account.assetEntry.fetch(solEntry)).index).to.equal(1);
    });

    it("adds BONK (20% weight, index 2)", async () => {
      bonkVault = getAssociatedTokenAddressSync(
        bonkMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .addAsset(2000, 2)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint: bonkMint,
          oracle: bonkOracle.publicKey,
          assetEntry: bonkEntry,
          assetVault: bonkVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: usdcEntry, isSigner: false, isWritable: false },
          { pubkey: solEntry, isSigner: false, isWritable: false },
        ])
        .rpc();

      const v = await program.account.multiAssetVault.fetch(vault);
      expect(v.numAssets).to.equal(3);
      console.log("  Total assets: 3, weights: 5000/3000/2000 (sum=10000)");
    });

    it("rejects weight exceeding 10000 cap", async () => {
      const extraMint = await createMint(
        connection, payer, payer.publicKey, null, 6,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      const [extraEntry] = getAssetEntryPDA(vault, extraMint);
      const extraOracle = await createMockOracleAccount();
      const extraVault = getAssociatedTokenAddressSync(
        extraMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      try {
        await program.methods
          .addAsset(1000, 2) // would make sum = 11000
          .accountsStrict({
            authority: payer.publicKey,
            vault,
            assetMint: extraMint,
            oracle: extraOracle.publicKey,
            assetEntry: extraEntry,
            assetVault: extraVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: usdcEntry, isSigner: false, isWritable: false },
            { pubkey: solEntry, isSigner: false, isWritable: false },
            { pubkey: bonkEntry, isSigner: false, isWritable: false },
          ])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("InvalidWeight");
      }
    });
  });

  // ============================================================
  // Update Weights
  // ============================================================
  describe("Update Weights", () => {
    it("updates weights (4000/4000/2000)", async () => {
      await program.methods
        .updateWeights([4000, 4000, 2000])
        .accountsStrict({ authority: payer.publicKey, vault })
        .remainingAccounts([
          { pubkey: usdcEntry, isSigner: false, isWritable: true },
          { pubkey: solEntry, isSigner: false, isWritable: true },
          { pubkey: bonkEntry, isSigner: false, isWritable: true },
        ])
        .rpc();

      expect((await program.account.assetEntry.fetch(usdcEntry)).targetWeightBps).to.equal(4000);
      expect((await program.account.assetEntry.fetch(solEntry)).targetWeightBps).to.equal(4000);
      expect((await program.account.assetEntry.fetch(bonkEntry)).targetWeightBps).to.equal(2000);
    });

    it("restores weights (5000/3000/2000)", async () => {
      await program.methods
        .updateWeights([5000, 3000, 2000])
        .accountsStrict({ authority: payer.publicKey, vault })
        .remainingAccounts([
          { pubkey: usdcEntry, isSigner: false, isWritable: true },
          { pubkey: solEntry, isSigner: false, isWritable: true },
          { pubkey: bonkEntry, isSigner: false, isWritable: true },
        ])
        .rpc();

      expect((await program.account.assetEntry.fetch(usdcEntry)).targetWeightBps).to.equal(5000);
    });

    it("rejects weights not summing to 10000", async () => {
      try {
        await program.methods
          .updateWeights([5000, 3000, 1000])
          .accountsStrict({ authority: payer.publicKey, vault })
          .remainingAccounts([
            { pubkey: usdcEntry, isSigner: false, isWritable: true },
            { pubkey: solEntry, isSigner: false, isWritable: true },
            { pubkey: bonkEntry, isSigner: false, isWritable: true },
          ])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("WeightsNotFullyAllocated");
      }
    });

    it("rejects wrong number of weights", async () => {
      try {
        await program.methods
          .updateWeights([5000, 5000])
          .accountsStrict({ authority: payer.publicKey, vault })
          .remainingAccounts([
            { pubkey: usdcEntry, isSigner: false, isWritable: true },
            { pubkey: solEntry, isSigner: false, isWritable: true },
            { pubkey: bonkEntry, isSigner: false, isWritable: true },
          ])
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("WeightsLengthMismatch");
      }
    });
  });

  // ============================================================
  // Admin
  // ============================================================
  describe("Admin", () => {
    it("pauses and unpauses", async () => {
      await program.methods.pause()
        .accountsStrict({ authority: payer.publicKey, vault }).rpc();
      expect((await program.account.multiAssetVault.fetch(vault)).paused).to.equal(true);

      await program.methods.unpause()
        .accountsStrict({ authority: payer.publicKey, vault }).rpc();
      expect((await program.account.multiAssetVault.fetch(vault)).paused).to.equal(false);
    });

    it("transfers authority and back", async () => {
      const newAuth = Keypair.generate();
      await program.methods.transferAuthority(newAuth.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault }).rpc();
      expect((await program.account.multiAssetVault.fetch(vault)).authority.toBase58())
        .to.equal(newAuth.publicKey.toBase58());

      await program.methods.transferAuthority(payer.publicKey)
        .accountsStrict({ authority: newAuth.publicKey, vault })
        .signers([newAuth]).rpc();
      expect((await program.account.multiAssetVault.fetch(vault)).authority.toBase58())
        .to.equal(payer.publicKey.toBase58());
    });

    it("rejects transfer to Pubkey::default", async () => {
      try {
        await program.methods.transferAuthority(PublicKey.default)
          .accountsStrict({ authority: payer.publicKey, vault }).rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("InvalidNewAuthority");
      }
    });

    it("rejects non-authority admin action", async () => {
      const rando = Keypair.generate();
      const sig = await connection.requestAirdrop(rando.publicKey, 1_000_000_000);
      await connection.confirmTransaction(sig);

      try {
        await program.methods.pause()
          .accountsStrict({ authority: rando.publicKey, vault })
          .signers([rando]).rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================================
  // Deposit Single — validation tests
  // ============================================================
  describe("Deposit Single (validation)", () => {
    it("rejects zero amount", async () => {
      try {
        await program.methods
          .depositSingle(new BN(0), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            depositAssetMint: usdcMint,
            depositAssetEntry: usdcEntry,
            depositAssetVault: usdcVault,
            userDepositAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(oracleRemainingAccounts([
            { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
            { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
            { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
          ]))
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("ZeroAmount");
      }
    });

    it("rejects deposit below MIN_DEPOSIT_AMOUNT", async () => {
      try {
        await program.methods
          .depositSingle(new BN(999), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            depositAssetMint: usdcMint,
            depositAssetEntry: usdcEntry,
            depositAssetVault: usdcVault,
            userDepositAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(oracleRemainingAccounts([
            { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
            { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
            { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
          ]))
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("DepositTooSmall");
      }
    });

    it("rejects deposit when paused", async () => {
      await program.methods.pause()
        .accountsStrict({ authority: payer.publicKey, vault }).rpc();

      try {
        await program.methods
          .depositSingle(new BN(100_000), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            depositAssetMint: usdcMint,
            depositAssetEntry: usdcEntry,
            depositAssetVault: usdcVault,
            userDepositAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(oracleRemainingAccounts([
            { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
            { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
            { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
          ]))
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.toString()).to.include("VaultPaused");
      }

      await program.methods.unpause()
        .accountsStrict({ authority: payer.publicKey, vault }).rpc();
    });
  });

  // ============================================================
  // Redeem Single — validation tests
  // ============================================================
  describe("Redeem Single (validation)", () => {
    it("rejects zero shares", async () => {
      try {
        await program.methods
          .redeemSingle(new BN(0), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            redeemAssetMint: usdcMint,
            redeemAssetEntry: usdcEntry,
            redeemAssetVault: usdcVault,
            userRedeemAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        // ZeroAmount or AccountNotInitialized (shares account may not exist yet)
        const msg = e.toString();
        expect(msg).to.satisfy(
          (m: string) => m.includes("ZeroAmount") || m.includes("AccountNotInitialized") || m.includes("0x0")
        );
      }
    });
  });

  // ============================================================
  // Remove Asset
  // ============================================================
  describe("Remove Asset", () => {
    it("removes BONK asset (empty vault, index 2)", async () => {
      // BONK vault should be empty since no deposits were made
      const bonkVaultAccount = await getAccount(connection, bonkVault);
      expect(Number(bonkVaultAccount.amount)).to.equal(0);

      const vaultBefore = await program.account.multiAssetVault.fetch(vault);
      const numBefore = vaultBefore.numAssets;

      await program.methods
        .removeAsset()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetEntry: bonkEntry,
          assetVault: bonkVault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await program.account.multiAssetVault.fetch(vault);
      expect(vaultAfter.numAssets).to.equal(numBefore - 1);

      // Verify entry is closed
      const entryInfo = await connection.getAccountInfo(bonkEntry);
      expect(entryInfo).to.be.null;

      console.log("  Removed BONK, num_assets:", vaultAfter.numAssets);
    });

    it("re-adds BONK with a fresh mint to restore 3-asset basket", async () => {
      // The previous BONK vault ATA still exists (remove_asset closes the entry, not the vault ATA).
      // add_asset uses `init` for the ATA, so we need a new mint to create a fresh ATA.
      const bonkMint2 = await createMint(
        connection, payer, payer.publicKey, null, BONK_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );

      const [bonkEntry2] = getAssetEntryPDA(vault, bonkMint2);
      const bonkOracle2 = await createMockOracleAccount();
      const bonkVault2 = getAssociatedTokenAddressSync(
        bonkMint2, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .addAsset(2000, 2)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint: bonkMint2,
          oracle: bonkOracle2.publicKey,
          assetEntry: bonkEntry2,
          assetVault: bonkVault2,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: usdcEntry, isSigner: false, isWritable: false },
          { pubkey: solEntry, isSigner: false, isWritable: false },
        ])
        .rpc();

      expect((await program.account.multiAssetVault.fetch(vault)).numAssets).to.equal(3);

      // Update module-level references for subsequent tests
      bonkMint = bonkMint2;
      bonkEntry = bonkEntry2;
      bonkOracle = bonkOracle2;
      bonkVault = bonkVault2;

      userBonkAccount = (await getOrCreateAssociatedTokenAccount(
        connection, payer, bonkMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
      )).address;
      await mintTo(connection, payer, bonkMint, userBonkAccount, payer, 1_000_000_000 * 10 ** BONK_DECIMALS, [], undefined, TOKEN_PROGRAM_ID);
    });
  });

  // ============================================================
  // Oracle Integration: Deposit + Redeem with oracle prices
  // ============================================================
  describe("Oracle Integration", () => {
    it("sets oracle prices", async () => {
      await setOraclePrice(usdcOracle.publicKey, USDC_PRICE);
      await setOraclePrice(solOracle.publicKey, SOL_PRICE);
      await setOraclePrice(bonkOracle.publicKey, BONK_PRICE);

      // Verify oracle data was written
      const oracleData = await connection.getAccountInfo(usdcOracle.publicKey);
      const price = oracleData!.data.readBigUInt64LE(0);
      expect(Number(price)).to.equal(USDC_PRICE);
    });

    it("deposit_single: deposits USDC and receives shares", async () => {
      const depositAmount = new BN(100_000_000); // 100 USDC (6 decimals)

      const usdcBalanceBefore = (await getAccount(connection, userUsdcAccount)).amount;

      await program.methods
        .depositSingle(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          depositAssetMint: usdcMint,
          depositAssetEntry: usdcEntry,
          depositAssetVault: usdcVault,
          userDepositAccount: userUsdcAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(oracleRemainingAccounts([
          { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
          { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
          { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
        ]))
        .rpc();

      const usdcBalanceAfter = (await getAccount(connection, userUsdcAccount)).amount;
      expect(Number(usdcBalanceBefore - usdcBalanceAfter)).to.equal(100_000_000);

      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
      console.log("  Shares minted:", sharesAccount.amount.toString());
    });

    it("deposit_single: deposits SOL and receives shares", async () => {
      const depositAmount = new BN(1_000_000_000); // 1 SOL (9 decimals)

      const sharesBefore = (await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount;

      await program.methods
        .depositSingle(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          depositAssetMint: solMint,
          depositAssetEntry: solEntry,
          depositAssetVault: solVault,
          userDepositAccount: userSolAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(oracleRemainingAccounts([
          { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
          { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
          { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
        ]))
        .rpc();

      const sharesAfter = (await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID)).amount;
      expect(Number(sharesAfter)).to.be.greaterThan(Number(sharesBefore));
      console.log("  Shares after SOL deposit:", sharesAfter.toString());
    });

    it("redeem_single: redeems shares for USDC", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToRedeem = new BN(Number(sharesAccount.amount) / 2);

      const usdcBefore = (await getAccount(connection, userUsdcAccount)).amount;

      await program.methods
        .redeemSingle(sharesToRedeem, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          redeemAssetMint: usdcMint,
          redeemAssetEntry: usdcEntry,
          redeemAssetVault: usdcVault,
          userRedeemAccount: userUsdcAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const usdcAfter = (await getAccount(connection, userUsdcAccount)).amount;
      expect(Number(usdcAfter)).to.be.greaterThan(Number(usdcBefore));
      console.log("  USDC received:", (usdcAfter - usdcBefore).toString());
    });

    it("redeem_single: slippage check", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      // Try to redeem 1 share with absurdly high min_amount_out
      const smallShares = new BN(1000);
      if (Number(sharesAccount.amount) < 1000) return; // skip if not enough

      try {
        await program.methods
          .redeemSingle(smallShares, new BN("18446744073709551615")) // u64 max
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            redeemAssetMint: usdcMint,
            redeemAssetEntry: usdcEntry,
            redeemAssetVault: usdcVault,
            userRedeemAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("SlippageExceeded");
      }
    });

    it("deposit_single: oracle staleness rejection", async () => {
      // Set oracle timestamp far in the past (10000 seconds ago — beyond 300s staleness)
      await setOraclePrice(usdcOracle.publicKey, USDC_PRICE, 1000);

      try {
        await program.methods
          .depositSingle(new BN(100_000_000), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault,
            sharesMint,
            userSharesAccount,
            depositAssetMint: usdcMint,
            depositAssetEntry: usdcEntry,
            depositAssetVault: usdcVault,
            userDepositAccount: userUsdcAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(oracleRemainingAccounts([
            { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
            { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
            { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
          ]))
          .rpc();
        expect.fail("Should have failed");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.include("OracleStale");
      }

      // Restore oracle
      await setOraclePrice(usdcOracle.publicKey, USDC_PRICE);
    });

    it("multi-user fairness", async () => {
      const user2 = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(user2.publicKey, 5_000_000_000);
      await connection.confirmTransaction(airdropSig);

      // Create USDC ATA for user2 and mint tokens
      const user2UsdcAccount = (await getOrCreateAssociatedTokenAccount(
        connection, payer, usdcMint, user2.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
      )).address;
      await mintTo(connection, payer, usdcMint, user2UsdcAccount, payer, 100_000_000, [], undefined, TOKEN_PROGRAM_ID);

      // User2 shares ATA
      const user2SharesAccount = getAssociatedTokenAddressSync(
        sharesMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // User2 deposits 100 USDC
      await program.methods
        .depositSingle(new BN(100_000_000), new BN(0))
        .accountsStrict({
          user: user2.publicKey,
          vault,
          sharesMint,
          userSharesAccount: user2SharesAccount,
          depositAssetMint: usdcMint,
          depositAssetEntry: usdcEntry,
          depositAssetVault: usdcVault,
          userDepositAccount: user2UsdcAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(oracleRemainingAccounts([
          { entry: usdcEntry, vault: usdcVault, oracle: usdcOracle.publicKey },
          { entry: solEntry, vault: solVault, oracle: solOracle.publicKey },
          { entry: bonkEntry, vault: bonkVault, oracle: bonkOracle.publicKey },
        ]))
        .signers([user2])
        .rpc();

      const user2Shares = await getAccount(connection, user2SharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(user2Shares.amount)).to.be.greaterThan(0);

      // User2 redeems all shares
      await program.methods
        .redeemSingle(new BN(Number(user2Shares.amount)), new BN(0))
        .accountsStrict({
          user: user2.publicKey,
          vault,
          sharesMint,
          userSharesAccount: user2SharesAccount,
          redeemAssetMint: usdcMint,
          redeemAssetEntry: usdcEntry,
          redeemAssetVault: usdcVault,
          userRedeemAccount: user2UsdcAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user2])
        .rpc();

      const user2UsdcAfter = await getAccount(connection, user2UsdcAccount);
      // Due to rounding, user2 may receive slightly less than deposited
      expect(Number(user2UsdcAfter.amount)).to.be.greaterThan(0);
      console.log("  User2 USDC after redeem:", user2UsdcAfter.amount.toString());
    });
  });
});
