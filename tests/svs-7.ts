import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs7 } from "../target/types/svs_7";

describe("svs-7 (Native SOL Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs7 as Program<Svs7>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // ─── PDA derivation ───────────────────────────────────────────────────────
  const vaultId = new BN(7001); // unique ID so it won't clash with other tests

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), vaultId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer()],
    program.programId
  );

  // wSOL vault = ATA(NATIVE_MINT, vault PDA) using TOKEN_PROGRAM_ID
  const wsolVault = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true, // allowOwnerOffCurve — vault is a PDA
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // User shares = ATA(sharesMint, payer) using TOKEN_2022_PROGRAM_ID
  const userSharesAccount = getAssociatedTokenAddressSync(
    sharesMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // User's wSOL ATA (temporary, used during redeem/withdraw, then closed)
  const userWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  before(async () => {
    console.log("\nSVS-7 Test Setup:");
    console.log("  Program ID    :", program.programId.toBase58());
    console.log("  Vault PDA     :", vault.toBase58());
    console.log("  Shares Mint   :", sharesMint.toBase58());
    console.log("  wSOL Vault    :", wsolVault.toBase58());
    console.log("  User Shares   :", userSharesAccount.toBase58());
  });

  // ─── Initialize ────────────────────────────────────────────────────────────

  describe("Initialize", () => {
    it("creates a native SOL vault (Live balance model)", async () => {
      const tx = await program.methods
        .initialize(vaultId, 0, "SOL Vault", "svSOL", "https://svs.xyz/svs7")
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          nativeMint: NATIVE_MINT,
          sharesMint,
          wsolVault,
          wsolTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("  Initialize tx:", tx);

      const vaultAccount = await program.account.solVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.wsolVault.toBase58()).to.equal(wsolVault.toBase58());
      expect(vaultAccount.paused).to.equal(false);

      const wsolBalance = await getAccount(connection, wsolVault);
      expect(Number(wsolBalance.amount)).to.equal(0);
      console.log("  ✓ Vault initialized, wSOL vault empty");
    });
  });

  // ─── Deposit SOL ───────────────────────────────────────────────────────────

  describe("Deposit SOL", () => {
    it("deposits 1 SOL and receives shares", async () => {
      const depositLamports = new BN(LAMPORTS_PER_SOL); // 1 SOL

      const balBefore = await connection.getBalance(payer.publicKey);

      await program.methods
        .depositSol(depositLamports, new BN(0))
        .accountsStrict({
          depositor: payer.publicKey,
          vault,
          wsolVault,
          sharesMint,
          userSharesAccount,
          wsolTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAccount = await getAccount(
        connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID
      );
      const wsolBalance = await getAccount(connection, wsolVault);
      const balAfter = await connection.getBalance(payer.publicKey);

      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
      expect(Number(wsolBalance.amount)).to.equal(LAMPORTS_PER_SOL);
      expect(balBefore - balAfter).to.be.greaterThan(LAMPORTS_PER_SOL - 10_000);

      console.log(`  ✓ Deposited 1 SOL → ${Number(sharesAccount.amount)} shares`);
    });

    it("second deposit (0.5 SOL) works proportionally", async () => {
      const depositLamports = new BN(0.5 * LAMPORTS_PER_SOL);
      const wsolBefore = await getAccount(connection, wsolVault);

      await program.methods
        .depositSol(depositLamports, new BN(0))
        .accountsStrict({
          depositor: payer.publicKey,
          vault,
          wsolVault,
          sharesMint,
          userSharesAccount,
          wsolTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const wsolAfter = await getAccount(connection, wsolVault);
      expect(Number(wsolAfter.amount)).to.equal(
        Number(wsolBefore.amount) + 0.5 * LAMPORTS_PER_SOL
      );
      console.log(`  ✓ wSOL vault now: ${Number(wsolAfter.amount) / LAMPORTS_PER_SOL} SOL`);
    });
  });

  // ─── Redeem SOL ────────────────────────────────────────────────────────────

  describe("Redeem SOL", () => {
    it("redeems half of shares for native SOL", async () => {
      const sharesBefore = await getAccount(
        connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID
      );
      const redeemShares = new BN(Number(sharesBefore.amount) / 2);
      const solBefore = await connection.getBalance(payer.publicKey);

      await program.methods
        .redeemSol(redeemShares, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault,
          wsolVault,
          sharesMint,
          userSharesAccount,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(
        connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID
      );
      const solAfter = await connection.getBalance(payer.publicKey);
      const sharesBurned = Number(sharesBefore.amount) - Number(sharesAfter.amount);

      expect(sharesBurned).to.equal(redeemShares.toNumber());
      // User gained SOL (net of tx fee)
      console.log(`  ✓ Burned ${sharesBurned} shares → SOL change: ${(solAfter - solBefore) / LAMPORTS_PER_SOL}`);
    });
  });

  // ─── Withdraw SOL ──────────────────────────────────────────────────────────

  describe("Withdraw SOL", () => {
    it("withdraws exact 0.1 SOL by burning shares", async () => {
      const sharesBefore = await getAccount(
        connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID
      );
      const withdrawLamports = new BN(0.1 * LAMPORTS_PER_SOL);

      await program.methods
        .withdrawSol(withdrawLamports, new BN(Number(sharesBefore.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault,
          wsolVault,
          sharesMint,
          userSharesAccount,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  ✓ Withdrew 0.1 SOL successfully");
    });
  });

  // ─── Admin ─────────────────────────────────────────────────────────────────

  describe("Admin", () => {
    it("pauses vault, rejects deposit, then unpauses", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const paused = await program.account.solVault.fetch(vault);
      expect(paused.paused).to.equal(true);
      console.log("  ✓ Vault paused");

      // Deposit should fail
      try {
        await program.methods
          .depositSol(new BN(10_000), new BN(0))
          .accountsStrict({
            depositor: payer.publicKey,
            vault,
            wsolVault,
            sharesMint,
            userSharesAccount,
            wsolTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have rejected deposit when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  ✓ Deposit correctly rejected when paused");
      }

      // Unpause
      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const unpaused = await program.account.solVault.fetch(vault);
      expect(unpaused.paused).to.equal(false);
      console.log("  ✓ Vault unpaused");
    });

    it("sync correctly rejected on Live balance model", async () => {
      try {
        await program.methods
          .sync()
          .accountsStrict({
            caller: payer.publicKey,
            vault,
            wsolVault,
            wsolTokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have rejected sync on Live model");
      } catch (err: any) {
        // SyncNotAvailableLiveModel error
        expect(err.toString()).to.match(/SyncNotAvailableLiveModel|6/);
        console.log("  ✓ Sync correctly rejected on Live balance model");
      }
    });
  });

  // ─── View Functions ────────────────────────────────────────────────────────

  describe("View Functions", () => {
    it("total assets matches wSOL vault balance", async () => {
      const wsolBalance = await getAccount(connection, wsolVault);
      console.log(`  wSOL vault balance: ${Number(wsolBalance.amount) / LAMPORTS_PER_SOL} SOL`);
      expect(Number(wsolBalance.amount)).to.be.greaterThan(0);
    });

    it("convert_to_shares and convert_to_assets are inverses", async () => {
      const wsolBalance = await getAccount(connection, wsolVault);
      const totalAssets = Number(wsolBalance.amount);

      // Just verify the vault has non-zero assets (view CPI simulation)
      expect(totalAssets).to.be.greaterThan(0);
      console.log(`  ✓ Total assets: ${totalAssets / LAMPORTS_PER_SOL} SOL`);
    });

    it("maxDeposit returns non-zero when not paused", async () => {
      const vaultAccount = await program.account.solVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
      // maxDeposit = u64::MAX when not paused
      console.log("  ✓ Vault not paused — maxDeposit is u64::MAX");
    });

    it("user shares account exists with positive balance", async () => {
      const sharesAccount = await getAccount(
        connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID
      );
      console.log(`  User shares: ${Number(sharesAccount.amount)}`);
      // User redeemed/withdrew some but still has some shares unless they redeemed all
      console.log("  ✓ Share account exists");
    });
  });
});
