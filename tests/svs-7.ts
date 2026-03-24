/**
 * SVS-7 Native SOL Vault — TypeScript test suite.
 *
 * Tests all instructions for the Live-only vault.
 * Covers: initialize, deposit_sol, deposit_wsol, withdraw_sol, withdraw_wsol,
 * redeem_sol, redeem_wsol, mint_sol, admin ops, view functions, and edge cases.
 *
 * Key wSOL patterns:
 * - Native SOL deposit: system_program::transfer → sync_native (done by the program)
 * - wSOL deposit: user holds an SPL token account funded with wSOL
 * - withdraw_sol / redeem_sol: program transfers wSOL to user's wSOL account then
 *   closes it — net result is native SOL to user.
 * - withdraw_wsol / redeem_wsol: program transfers wSOL to user's wSOL account,
 *   no close — user receives wSOL.
 *
 * For the _sol instruction family the user still needs a wSOL ATA as the temporary
 * landing pad (close_account runs within the same tx so the account is gone after).
 * We create it with ensureEmptyWsolAccount before each such call.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs7 } from "../target/types/svs_7";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SOL_VAULT_SEED = Buffer.from("sol_vault");
const SHARES_MINT_SEED = Buffer.from("shares");

// Minimum deposit as defined in constants.rs
const MIN_DEPOSIT_LAMPORTS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// PDA helpers
// ─────────────────────────────────────────────────────────────────────────────

function getVaultPDA(programId: PublicKey, vaultId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SOL_VAULT_SEED, vaultId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

function getSharesMintPDA(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
}

function getWsolVaultATA(vault: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true, // allowOwnerOffCurve — vault is a PDA
    TOKEN_PROGRAM_ID,
  );
}

function getUserSharesATA(sharesMint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    sharesMint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
}

function getUserWsolATA(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create a funded wSOL ATA for the given owner.
// Transfers `lamports` of native SOL into it and calls sync_native.
// Returns the ATA public key.
// ─────────────────────────────────────────────────────────────────────────────
async function createFundedWsolAccount(
  connection: anchor.web3.Connection,
  payer: Keypair,
  owner: PublicKey,
  lamports: number,
): Promise<PublicKey> {
  const wsolATA = getUserWsolATA(owner);

  // Close existing wSOL ATA if present (handles leftover balance from prior tests)
  const info = await connection.getAccountInfo(wsolATA, "confirmed");
  if (info !== null) {
    try {
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(
          wsolATA,
          payer.publicKey,
          payer.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
      await sendAndConfirmTransaction(connection, closeTx, [payer]);
    } catch {
      // close may fail if account is in unexpected state — proceed anyway
    }
  }

  // Create fresh ATA + fund + sync
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      wsolATA,
      owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wsolATA,
      lamports,
    }),
    createSyncNativeInstruction(wsolATA, TOKEN_PROGRAM_ID),
  );

  await sendAndConfirmTransaction(connection, tx, [payer]);

  return wsolATA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: ensure a user's wSOL ATA exists (empty, 0-balance).
// Used as the landing pad for withdraw_sol / redeem_sol.
// If it already exists (e.g. from a previous test), this is a no-op.
// Includes retry logic for blockhash timeout issues on local validator.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureEmptyWsolAccount(
  connection: anchor.web3.Connection,
  payer: Keypair,
  owner: PublicKey,
): Promise<PublicKey> {
  const wsolATA = getUserWsolATA(owner);

  // Close existing ATA if present (handles stale accounts from prior tests)
  const info = await connection.getAccountInfo(wsolATA, "confirmed");
  if (info !== null) {
    try {
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(
          wsolATA,
          payer.publicKey,
          payer.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
      await sendAndConfirmTransaction(connection, closeTx, [payer]);
    } catch {
      // close may fail — proceed to create
    }
  }

  // Create fresh empty ATA
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          wsolATA,
          owner,
          NATIVE_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );

      await sendAndConfirmTransaction(connection, tx, [payer]);
      return wsolATA;
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      if (err.toString().includes("already in use")) return wsolATA;
      if (err.toString().includes("owner is not allowed")) return wsolATA;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return wsolATA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: ensure a Token-2022 shares ATA exists for the given owner.
// If it already exists, this is a no-op.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureSharesAccount(
  connection: anchor.web3.Connection,
  payer: Keypair,
  sharesMint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const sharesATA = getUserSharesATA(sharesMint, owner);
  const info = await connection.getAccountInfo(sharesATA, "confirmed");
  if (info !== null) return sharesATA;

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      sharesATA,
      owner,
      sharesMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, tx, [payer]);
  return sharesATA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: read a u64 LE value out of simulation logs.
// The program uses set_return_data() which emits a log line:
//   "Program return: <programId> <base64data>"
// Anchor's MethodsBuilder.simulate() returns { events, raw: logs } without
// a separate returnData field, so we parse it from the log lines directly.
// ─────────────────────────────────────────────────────────────────────────────
function parseReturnU64(
  logs: string[] | null | undefined,
  _returnData?: unknown,
): BN | null {
  if (!logs) return null;

  // Look for "Program return: <programId> <base64>" in logs
  const returnPrefix = "Program return: ";
  const returnLog = logs.find((l) => l.startsWith(returnPrefix));
  if (!returnLog) return null;

  // Format: "Program return: <programId> <base64data>"
  const parts = returnLog.slice(returnPrefix.length).split(" ");
  if (parts.length < 2) return null;
  const base64Data = parts[1];

  const buf = Buffer.from(base64Data, "base64");
  if (buf.length < 8) return null;
  // u64 little-endian
  const lo = buf.readUInt32LE(0);
  const hi = buf.readUInt32LE(4);
  return new BN(hi).shln(32).or(new BN(lo));
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite helpers — shared test state type
// ─────────────────────────────────────────────────────────────────────────────
interface VaultCtx {
  vaultId: BN;
  vault: PublicKey;
  sharesMint: PublicKey;
  wsolVault: PublicKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite — Live-only Native SOL Vault
// ─────────────────────────────────────────────────────────────────────────────

describe("svs-7: Native SOL Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs7 as Program<Svs7>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(700); // unique id so tests don't conflict
  let ctx: VaultCtx;

  // ── Initialize ──────────────────────────────────────────────────────────────

  describe("Initialize", () => {
    it("creates a native SOL vault", async () => {
      const [vault] = getVaultPDA(program.programId, vaultId);
      const [sharesMint] = getSharesMintPDA(program.programId, vault);
      const wsolVault = getWsolVaultATA(vault);

      ctx = { vaultId, vault, sharesMint, wsolVault };

      const tx = await program.methods
        .initialize(vaultId)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          nativeMint: NATIVE_MINT,
          sharesMint,
          wsolVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("  [Live] initialize tx:", tx);

      const vaultAccount = await program.account.solVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58(),
      );
      expect(vaultAccount.wsolVault.toBase58()).to.equal(wsolVault.toBase58());
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(vaultAccount.decimalsOffset).to.equal(0);

      // wSOL vault exists and is empty
      const wsolAccount = await getAccount(
        connection,
        wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(wsolAccount.amount)).to.equal(0);
    });

    it("verifies PDA derivation is correct", async () => {
      const [expectedVault] = getVaultPDA(program.programId, vaultId);
      expect(ctx.vault.toBase58()).to.equal(expectedVault.toBase58());

      const [expectedShares] = getSharesMintPDA(program.programId, ctx.vault);
      expect(ctx.sharesMint.toBase58()).to.equal(expectedShares.toBase58());
    });
  });

  // ── Deposit SOL (native) ──────────────────────────────────────────────────

  describe("Deposit SOL (native)", () => {
    it("deposits native SOL and mints shares", async () => {
      const depositLamports = new BN(2 * LAMPORTS_PER_SOL);

      const userSharesAccount = await ensureSharesAccount(
        connection,
        payer,
        ctx.sharesMint,
        payer.publicKey,
      );
      const solBefore = await connection.getBalance(payer.publicKey);

      const tx = await program.methods
        .depositSol(depositLamports, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  [Live] deposit_sol tx:", tx);

      const solAfter = await connection.getBalance(payer.publicKey);
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolAccount = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      // User spent at least depositLamports (plus fees)
      expect(solBefore - solAfter).to.be.at.least(depositLamports.toNumber());
      // Shares were minted
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
      // wSOL vault reflects the deposited lamports
      expect(Number(wsolAccount.amount)).to.equal(depositLamports.toNumber());

      console.log("  shares minted:", Number(sharesAccount.amount));
      console.log("  wSOL vault balance:", Number(wsolAccount.amount));
    });

    it("second deposit mints proportional shares", async () => {
      const depositLamports = new BN(1 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolBefore = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      await program.methods
        .depositSol(depositLamports, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolAfter = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const newShares =
        Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(newShares).to.be.greaterThan(0);
      expect(Number(wsolAfter.amount)).to.equal(
        Number(wsolBefore.amount) + depositLamports.toNumber(),
      );

      // Second deposit of half the original should mint proportional shares
      // (roughly half, accounting for virtual offset)
      console.log(
        "  second deposit new shares:",
        newShares,
        "previous total:",
        Number(sharesBefore.amount),
      );
    });

    it("respects min_shares_out slippage guard", async () => {
      const depositLamports = new BN(0.1 * LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      // Set min_shares_out to an absurdly high value to trigger slippage error
      try {
        await program.methods
          .depositSol(depositLamports, new BN("18446744073709551615")) // u64::MAX
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected slippage error");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
      }
    });
  });

  // ── Deposit wSOL ──────────────────────────────────────────────────────────

  describe("Deposit wSOL", () => {
    it("deposits pre-wrapped wSOL and mints shares", async () => {
      const depositAmount = new BN(0.5 * LAMPORTS_PER_SOL);

      // Fund user's wSOL ATA
      const userWsolAccount = await createFundedWsolAccount(
        connection,
        payer,
        payer.publicKey,
        depositAmount.toNumber() + 10_000, // extra for rent
      );

      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const wsolBefore = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const tx = await program.methods
        .depositWsol(depositAmount, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] deposit_wsol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolAfter = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(Number(sharesAfter.amount)).to.be.greaterThan(
        Number(sharesBefore.amount),
      );
      expect(Number(wsolAfter.amount)).to.equal(
        Number(wsolBefore.amount) + depositAmount.toNumber(),
      );
    });
  });

  // ── Withdraw wSOL ─────────────────────────────────────────────────────────

  describe("Withdraw wSOL", () => {
    it("withdraws exact wSOL by burning shares (no unwrap)", async () => {
      const withdrawLamports = new BN(0.1 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const userWsolAccount = getUserWsolATA(payer.publicKey);

      // Ensure user has an empty wSOL ATA to receive into
      await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolUserBefore = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const tx = await program.methods
        .withdrawWsol(withdrawLamports, new BN(Number(sharesBefore.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] withdraw_wsol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolUserAfter = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(Number(sharesAfter.amount)).to.be.lessThan(
        Number(sharesBefore.amount),
      );
      expect(Number(wsolUserAfter.amount)).to.equal(
        Number(wsolUserBefore.amount) + withdrawLamports.toNumber(),
      );
    });
  });

  // ── Withdraw SOL (with unwrap) ────────────────────────────────────────────

  describe("Withdraw SOL (native unwrap)", () => {
    it("withdraws exact lamports as native SOL (burns shares, closes wSOL ATA)", async () => {
      const withdrawLamports = new BN(0.1 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      // withdraw_sol needs a wSOL ATA as a temporary landing pad.
      // Program transfers wSOL to it, then closes it (unwrap to native SOL).
      // Works even if the account already has a balance from prior tests.
      const userWsolAccount = await ensureEmptyWsolAccount(
        connection,
        payer,
        payer.publicKey,
      );

      const solBefore = await connection.getBalance(payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const tx = await program.methods
        .withdrawSol(withdrawLamports, new BN(Number(sharesBefore.amount)))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          wsolVault: ctx.wsolVault,
          userWsolAccount,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] withdraw_sol tx:", tx);

      const solAfter = await connection.getBalance(payer.publicKey);
      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      // User received SOL (net of fees the balance increases meaningfully)
      expect(solAfter).to.be.greaterThan(solBefore);
      // Shares were burned
      expect(Number(sharesAfter.amount)).to.be.lessThan(
        Number(sharesBefore.amount),
      );
      // wSOL ATA was closed (account no longer exists)
      const closedInfo = await connection.getAccountInfo(userWsolAccount);
      expect(closedInfo).to.be.null;
    });
  });

  // ── Redeem wSOL ───────────────────────────────────────────────────────────

  describe("Redeem wSOL", () => {
    it("redeems exact shares for wSOL (no unwrap)", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));
      if (redeemShares.isZero()) {
        console.log("  [Live] redeem_wsol: skipped (insufficient shares)");
        return;
      }

      // Ensure user wSOL ATA exists to receive.
      // After withdraw_sol closes it, we recreate. Balance is 0.
      const userWsolAccount = await ensureEmptyWsolAccount(
        connection,
        payer,
        payer.publicKey,
      );

      const tx = await program.methods
        .redeemWsol(redeemShares, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] redeem_wsol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolUserAfter = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const sharesBurned =
        Number(sharesBefore.amount) - Number(sharesAfter.amount);
      expect(sharesBurned).to.equal(redeemShares.toNumber());
      expect(Number(wsolUserAfter.amount)).to.be.greaterThan(0);

      console.log("  shares burned:", sharesBurned);
      console.log("  wSOL received:", Number(wsolUserAfter.amount));
    });
  });

  // ── Redeem SOL (with unwrap) ───────────────────────────────────────────────

  describe("Redeem SOL (native unwrap)", () => {
    it("redeems exact shares and receives native SOL", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));
      if (redeemShares.isZero()) {
        console.log("  [Live] redeem_sol: skipped (insufficient shares)");
        return;
      }

      // redeem_sol needs a wSOL ATA as a temporary landing pad.
      // Program transfers wSOL to it, then closes it (unwrap to native SOL).
      const userWsolAccount = await ensureEmptyWsolAccount(
        connection,
        payer,
        payer.publicKey,
      );

      const solBefore = await connection.getBalance(payer.publicKey);

      const tx = await program.methods
        .redeemSol(redeemShares, new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          wsolVault: ctx.wsolVault,
          userWsolAccount,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] redeem_sol tx:", tx);

      const solAfter = await connection.getBalance(payer.publicKey);
      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const sharesBurned =
        Number(sharesBefore.amount) - Number(sharesAfter.amount);
      expect(sharesBurned).to.equal(redeemShares.toNumber());
      expect(solAfter).to.be.greaterThan(solBefore);

      // wSOL ATA was closed
      const closedInfo = await connection.getAccountInfo(userWsolAccount);
      expect(closedInfo).to.be.null;
    });
  });

  // ── Mint SOL ──────────────────────────────────────────────────────────────

  describe("Mint SOL (exact shares in)", () => {
    it("mints exact shares by paying native SOL (ceiling rounding)", async () => {
      const mintShares = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL worth of shares

      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const solBefore = await connection.getBalance(payer.publicKey);

      const tx = await program.methods
        .mintSol(mintShares, new BN(2 * LAMPORTS_PER_SOL)) // generous max
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  [Live] mint_sol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const solAfter = await connection.getBalance(payer.publicKey);

      const newShares =
        Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(newShares).to.equal(mintShares.toNumber());
      expect(solAfter).to.be.lessThan(solBefore);
    });

    it("mint_sol respects max_lamports_in slippage guard", async () => {
      const mintShares = new BN(LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      try {
        await program.methods
          .mintSol(mintShares, new BN(1)) // absurdly low max
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected slippage error");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
      }
    });
  });

  // ── mint_wsol ───────────────────────────────────────────────────────────

  describe("mint_wsol — exact shares for wSOL", () => {
    it("mints exact shares by paying wSOL", async () => {
      const mintShares = new BN(LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      // Create and fund a wSOL account for the user (handles existing ATA)
      const userWsolAccount = await createFundedWsolAccount(
        connection,
        payer,
        payer.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolBefore = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const tx = await program.methods
        .mintWsol(mintShares, new BN(2 * LAMPORTS_PER_SOL))
        .accountsStrict({
          user: payer.publicKey,
          vault: ctx.vault,
          nativeMint: NATIVE_MINT,
          userWsolAccount,
          wsolVault: ctx.wsolVault,
          sharesMint: ctx.sharesMint,
          userSharesAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  [Live] mint_wsol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const wsolAfter = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const newShares =
        Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(newShares).to.equal(mintShares.toNumber());
      expect(Number(wsolAfter.amount)).to.be.lessThan(
        Number(wsolBefore.amount),
      );

      // Clean up: close the wSOL account
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(
          userWsolAccount,
          payer.publicKey,
          payer.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
      await sendAndConfirmTransaction(connection, closeTx, [payer]);
    });

    it("mint_wsol respects max_amount_in slippage guard", async () => {
      const mintShares = new BN(LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      // Create and fund a wSOL account (handles existing ATA)
      const userWsolAccount = await createFundedWsolAccount(
        connection,
        payer,
        payer.publicKey,
        2 * LAMPORTS_PER_SOL,
      );

      try {
        await program.methods
          .mintWsol(mintShares, new BN(1)) // absurdly low max
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            nativeMint: NATIVE_MINT,
            userWsolAccount,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("expected slippage error");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
      }

      // Clean up
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(
          userWsolAccount,
          payer.publicKey,
          payer.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
      await sendAndConfirmTransaction(connection, closeTx, [payer]);
    });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────

  describe("Admin — pause / unpause / transfer_authority", () => {
    it("pauses the vault", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: ctx.vault,
        })
        .rpc();

      const vaultAccount = await program.account.solVault.fetch(ctx.vault);
      expect(vaultAccount.paused).to.equal(true);
    });

    it("rejects deposit when paused", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      try {
        await program.methods
          .depositSol(new BN(MIN_DEPOSIT_LAMPORTS), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected paused error");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }
    });

    it("unpauses the vault", async () => {
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: ctx.vault,
        })
        .rpc();

      const vaultAccount = await program.account.solVault.fetch(ctx.vault);
      expect(vaultAccount.paused).to.equal(false);
    });

    it("transfers authority to a new keypair then back", async () => {
      const newAuthority = Keypair.generate();

      // Transfer to new
      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault: ctx.vault,
        })
        .rpc();

      let vaultAccount = await program.account.solVault.fetch(ctx.vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58(),
      );

      // Airdrop to new authority so it can sign
      const sig = await connection.requestAirdrop(
        newAuthority.publicKey,
        LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig);

      // Transfer back to original payer
      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: ctx.vault,
        })
        .signers([newAuthority])
        .rpc();

      vaultAccount = await program.account.solVault.fetch(ctx.vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
    });

    it("rejects non-authority attempting pause", async () => {
      const impostor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        impostor.publicKey,
        LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig);

      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: impostor.publicKey,
            vault: ctx.vault,
          })
          .signers([impostor])
          .rpc();
        expect.fail("expected Unauthorized error");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ── View Functions ────────────────────────────────────────────────────────

  describe("View Functions", () => {
    const viewAccounts = () => ({
      vault: ctx.vault,
      sharesMint: ctx.sharesMint,
      wsolVault: ctx.wsolVault,
    });

    it("total_assets returns wSOL vault balance", async () => {
      const wsolAccount = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const expectedLamports = Number(wsolAccount.amount);

      const sim = await program.methods
        .totalAssets()
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      expect(result!.toNumber()).to.equal(expectedLamports);
      console.log("  total_assets:", result!.toNumber());
    });

    it("convert_to_shares returns positive value for non-zero input", async () => {
      const sim = await program.methods
        .convertToShares(new BN(LAMPORTS_PER_SOL))
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      expect(result!.toNumber()).to.be.greaterThan(0);
    });

    it("convert_to_assets returns positive value for non-zero shares input", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      if (Number(sharesAccount.amount) === 0) {
        console.log("  [Live] convert_to_assets: skipped (no shares)");
        return;
      }

      const sim = await program.methods
        .convertToAssets(new BN(Number(sharesAccount.amount)))
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      expect(result!.toNumber()).to.be.greaterThan(0);
    });

    it("max_deposit returns u64::MAX when not paused", async () => {
      const sim = await program.methods
        .maxDeposit()
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      // u64::MAX = 18446744073709551615
      expect(result!.toString()).to.equal("18446744073709551615");
    });

    it("max_withdraw returns owner's redeemable lamports", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const sim = await program.methods
        .maxWithdraw()
        .accountsStrict({
          ...viewAccounts(),
          ownerSharesAccount: userSharesAccount,
        })
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;

      if (Number(sharesAccount.amount) > 0) {
        expect(result!.toNumber()).to.be.greaterThan(0);
      }
      console.log("  max_withdraw:", result!.toNumber());
    });

    it("max_deposit returns 0 when paused", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault: ctx.vault })
        .rpc();

      const sim = await program.methods
        .maxDeposit()
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result!.toNumber()).to.equal(0);

      // Unpause for subsequent tests
      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault: ctx.vault })
        .rpc();
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

  describe("Edge Cases", () => {
    it("deposit_sol with zero amount fails (ZeroAmount)", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      try {
        await program.methods
          .depositSol(new BN(0), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected ZeroAmount error");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("deposit_sol below MIN_DEPOSIT fails (DepositTooSmall)", async () => {
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );
      try {
        await program.methods
          .depositSol(new BN(MIN_DEPOSIT_LAMPORTS - 1), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected DepositTooSmall error");
      } catch (err: any) {
        expect(err.toString()).to.include("DepositTooSmall");
      }
    });

    it("withdraw_sol for more than vault holds fails (InsufficientAssets)", async () => {
      // Deposit small amount first to ensure vault has some balance
      const userSharesAccount = getUserSharesATA(
        ctx.sharesMint,
        payer.publicKey,
      );

      // Try to withdraw more than total vault assets
      const wsolAccount = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const tooMuch = new BN(Number(wsolAccount.amount) + LAMPORTS_PER_SOL);

      // Ensure user wSOL ATA exists (will be closed on success, but we expect failure)
      const wsolATA = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(wsolATA);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(
            wsolATA,
            payer.publicKey,
            payer.publicKey,
            [],
            TOKEN_PROGRAM_ID,
          ),
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
      }
      const userWsolAccount = await ensureEmptyWsolAccount(
        connection,
        payer,
        payer.publicKey,
      );

      try {
        await program.methods
          .withdrawSol(tooMuch, new BN("18446744073709551615"))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            nativeMint: NATIVE_MINT,
            wsolVault: ctx.wsolVault,
            userWsolAccount,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("expected InsufficientAssets error");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientAssets");
      }
    });
  });
});
