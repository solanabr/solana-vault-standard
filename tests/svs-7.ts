/**
 * SVS-7 Native SOL Vault — TypeScript test suite.
 *
 * Tests all instructions across both BalanceModel variants (Live and Stored).
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
 * We create it with getOrCreateAssociatedTokenAccount before each such call.
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
  syncNative,
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
    programId
  );
}

function getSharesMintPDA(programId: PublicKey, vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId
  );
}

function getWsolVaultATA(vault: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true, // allowOwnerOffCurve — vault is a PDA
    TOKEN_PROGRAM_ID
  );
}

function getUserSharesATA(sharesMint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    sharesMint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID
  );
}

function getUserWsolATA(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID
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
  lamports: number
): Promise<PublicKey> {
  const wsolATA = getUserWsolATA(owner);

  const tx = new Transaction();

  // Create the ATA if it doesn't already exist
  tx.add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey, // fee payer
      wsolATA,         // ATA address
      owner,           // owner
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );

  // Fund with native SOL
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wsolATA,
      lamports,
    })
  );

  // Sync the lamport balance → wSOL amount
  tx.add(createSyncNativeInstruction(wsolATA, TOKEN_PROGRAM_ID));

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
  owner: PublicKey
): Promise<PublicKey> {
  const wsolATA = getUserWsolATA(owner);

  // Check if it already exists
  const info = await connection.getAccountInfo(wsolATA, "confirmed");
  if (info !== null) {
    return wsolATA;
  }

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
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );

      await sendAndConfirmTransaction(connection, tx, [payer]);
      return wsolATA;
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      // If "already in use", the ATA was created between our check and creation
      if (err.toString().includes("already in use")) return wsolATA;
      // Blockhash timeout — wait briefly and retry
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return wsolATA;
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
  _returnData?: unknown
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
// SUITE 1 — Live Balance Model
// ─────────────────────────────────────────────────────────────────────────────

describe("svs-7: Live Balance Model", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs7 as Program<Svs7>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(700); // unique id so tests don't conflict
  let ctx: VaultCtx;

  // ── Initialize ──────────────────────────────────────────────────────────────

  describe("Initialize", () => {
    it("creates a Live-model vault", async () => {
      const [vault] = getVaultPDA(program.programId, vaultId);
      const [sharesMint] = getSharesMintPDA(program.programId, vault);
      const wsolVault = getWsolVaultATA(vault);

      ctx = { vaultId, vault, sharesMint, wsolVault };

      const tx = await program.methods
        .initialize(
          vaultId,
          { live: {} },
          "SVS-7 Live Vault",
          "svSOL-L",
          "https://example.com/svs7-live.json"
        )
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
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.wsolVault.toBase58()).to.equal(wsolVault.toBase58());
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.decimalsOffset).to.equal(0);
      // balance_model discriminant — Live is the default (index 0)
      expect(vaultAccount.balanceModel).to.deep.equal({ live: {} });

      // wSOL vault exists and is empty
      const wsolAccount = await getAccount(connection, wsolVault, undefined, TOKEN_PROGRAM_ID);
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

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  [Live] deposit_sol tx:", tx);

      const solAfter = await connection.getBalance(payer.publicKey);
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const wsolAccount = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);

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

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const wsolBefore = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);

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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const wsolAfter = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);

      const newShares = Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(newShares).to.be.greaterThan(0);
      expect(Number(wsolAfter.amount)).to.equal(
        Number(wsolBefore.amount) + depositLamports.toNumber()
      );

      // Second deposit of half the original should mint proportional shares
      // (roughly half, accounting for virtual offset)
      console.log(
        "  second deposit new shares:",
        newShares,
        "previous total:",
        Number(sharesBefore.amount)
      );
    });

    it("respects min_shares_out slippage guard", async () => {
      const depositLamports = new BN(0.1 * LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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
        depositAmount.toNumber() + 10_000 // extra for rent
      );

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const wsolBefore = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);

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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  [Live] deposit_wsol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const wsolAfter = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);

      expect(Number(sharesAfter.amount)).to.be.greaterThan(Number(sharesBefore.amount));
      expect(Number(wsolAfter.amount)).to.equal(
        Number(wsolBefore.amount) + depositAmount.toNumber()
      );
    });
  });

  // ── Withdraw wSOL ─────────────────────────────────────────────────────────

  describe("Withdraw wSOL", () => {
    it("withdraws exact wSOL by burning shares (no unwrap)", async () => {
      const withdrawLamports = new BN(0.1 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const userWsolAccount = getUserWsolATA(payer.publicKey);

      // Ensure user has an empty wSOL ATA to receive into
      await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const wsolUserBefore = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID
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
        TOKEN_2022_PROGRAM_ID
      );
      const wsolUserAfter = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID
      );

      expect(Number(sharesAfter.amount)).to.be.lessThan(Number(sharesBefore.amount));
      expect(Number(wsolUserAfter.amount)).to.equal(
        Number(wsolUserBefore.amount) + withdrawLamports.toNumber()
      );
    });
  });

  // ── Withdraw SOL (with unwrap) ────────────────────────────────────────────

  describe("Withdraw SOL (native unwrap)", () => {
    it("withdraws exact lamports as native SOL (burns shares, closes wSOL ATA)", async () => {
      const withdrawLamports = new BN(0.1 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

      // withdraw_sol needs a wSOL ATA owned by user as a temporary landing pad.
      // The ATA must not exist before the call (program closes it in the same tx).
      // Close any existing one first so we can recreate it.
      const existingWsol = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(existingWsol);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(
            existingWsol,
            payer.publicKey,
            payer.publicKey,
            [],
            TOKEN_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
      }

      // Create a fresh empty wSOL ATA
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      const solBefore = await connection.getBalance(payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
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
        TOKEN_2022_PROGRAM_ID
      );

      // User received SOL (net of fees the balance increases meaningfully)
      expect(solAfter).to.be.greaterThan(solBefore);
      // Shares were burned
      expect(Number(sharesAfter.amount)).to.be.lessThan(Number(sharesBefore.amount));
      // wSOL ATA was closed (account no longer exists)
      const closedInfo = await connection.getAccountInfo(userWsolAccount);
      expect(closedInfo).to.be.null;
    });
  });

  // ── Redeem wSOL ───────────────────────────────────────────────────────────

  describe("Redeem wSOL", () => {
    it("redeems exact shares for wSOL (no unwrap)", async () => {
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));
      if (redeemShares.isZero()) {
        console.log("  [Live] redeem_wsol: skipped (insufficient shares)");
        return;
      }

      // Ensure user wSOL ATA exists to receive
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      const wsolUserBefore = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID
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
        TOKEN_2022_PROGRAM_ID
      );
      const wsolUserAfter = await getAccount(
        connection,
        userWsolAccount,
        undefined,
        TOKEN_PROGRAM_ID
      );

      const sharesBurned = Number(sharesBefore.amount) - Number(sharesAfter.amount);
      expect(sharesBurned).to.equal(redeemShares.toNumber());
      expect(Number(wsolUserAfter.amount)).to.be.greaterThan(Number(wsolUserBefore.amount));

      console.log("  shares burned:", sharesBurned);
      console.log("  wSOL received:", Number(wsolUserAfter.amount) - Number(wsolUserBefore.amount));
    });
  });

  // ── Redeem SOL (with unwrap) ───────────────────────────────────────────────

  describe("Redeem SOL (native unwrap)", () => {
    it("redeems exact shares and receives native SOL", async () => {
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));
      if (redeemShares.isZero()) {
        console.log("  [Live] redeem_sol: skipped (insufficient shares)");
        return;
      }

      // Close existing wSOL ATA if present, then create fresh empty one
      const wsolATA = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(wsolATA);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(
            wsolATA,
            payer.publicKey,
            payer.publicKey,
            [],
            TOKEN_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
        // Wait for close to propagate so ensureEmptyWsolAccount sees null
        for (let i = 0; i < 10; i++) {
          const check = await connection.getAccountInfo(wsolATA, "confirmed");
          if (check === null) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

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
        TOKEN_2022_PROGRAM_ID
      );

      const sharesBurned = Number(sharesBefore.amount) - Number(sharesAfter.amount);
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

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  [Live] mint_sol tx:", tx);

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const solAfter = await connection.getBalance(payer.publicKey);

      const newShares = Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(newShares).to.equal(mintShares.toNumber());
      expect(solAfter).to.be.lessThan(solBefore);
    });

    it("mint_sol respects max_lamports_in slippage guard", async () => {
      const mintShares = new BN(LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected slippage error");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
      }
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
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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
      expect(vaultAccount.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());

      // Airdrop to new authority so it can sign
      const sig = await connection.requestAirdrop(newAuthority.publicKey, LAMPORTS_PER_SOL);
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
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("rejects sync on Live model (SyncNotAllowed)", async () => {
      try {
        await program.methods
          .sync()
          .accountsStrict({
            authority: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
          })
          .rpc();
        expect.fail("expected SyncNotAllowed error");
      } catch (err: any) {
        expect(err.toString()).to.include("SyncNotAllowed");
      }
    });

    it("rejects non-authority attempting pause", async () => {
      const impostor = Keypair.generate();
      const sig = await connection.requestAirdrop(impostor.publicKey, LAMPORTS_PER_SOL);
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

    it("total_assets returns wSOL vault balance (Live model)", async () => {
      const wsolAccount = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);
      const expectedLamports = Number(wsolAccount.amount);

      const sim = await program.methods
        .totalAssets()
        .accountsStrict(viewAccounts())
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      expect(result!.toNumber()).to.equal(expectedLamports);
      console.log("  total_assets (Live):", result!.toNumber());
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
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
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
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
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
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected ZeroAmount error");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("deposit_sol below MIN_DEPOSIT fails (DepositTooSmall)", async () => {
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

      // Try to withdraw more than total vault assets
      const wsolAccount = await getAccount(connection, ctx.wsolVault, undefined, TOKEN_PROGRAM_ID);
      const tooMuch = new BN(Number(wsolAccount.amount) + LAMPORTS_PER_SOL);

      // Ensure user wSOL ATA exists (will be closed on success, but we expect failure)
      const wsolATA = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(wsolATA);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(wsolATA, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID)
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
      }
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

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

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — Stored Balance Model
// ─────────────────────────────────────────────────────────────────────────────

describe("svs-7: Stored Balance Model", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs7 as Program<Svs7>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(701); // distinct from Live suite
  let ctx: VaultCtx;

  // ── Initialize ──────────────────────────────────────────────────────────────

  describe("Initialize", () => {
    it("creates a Stored-model vault", async () => {
      const [vault] = getVaultPDA(program.programId, vaultId);
      const [sharesMint] = getSharesMintPDA(program.programId, vault);
      const wsolVault = getWsolVaultATA(vault);

      ctx = { vaultId, vault, sharesMint, wsolVault };

      const tx = await program.methods
        .initialize(
          vaultId,
          { stored: {} },
          "SVS-7 Stored Vault",
          "svSOL-S",
          "https://example.com/svs7-stored.json"
        )
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

      console.log("  [Stored] initialize tx:", tx);

      const vaultAccount = await program.account.solVault.fetch(vault);
      expect(vaultAccount.balanceModel).to.deep.equal({ stored: {} });
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.paused).to.equal(false);
    });
  });

  // ── Deposit SOL ───────────────────────────────────────────────────────────

  describe("Deposit SOL (Stored model)", () => {
    it("deposits native SOL — totalAssets increments in stored field", async () => {
      const depositLamports = new BN(3 * LAMPORTS_PER_SOL);
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

      const vaultBefore = await program.account.solVault.fetch(ctx.vault);

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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await program.account.solVault.fetch(ctx.vault);
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Stored model: total_assets field is incremented
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + depositLamports.toNumber()
      );
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);

      console.log(
        "  [Stored] total_assets after deposit:",
        vaultAfter.totalAssets.toNumber()
      );
    });
  });

  // ── Sync ──────────────────────────────────────────────────────────────────

  describe("Sync (Stored model only)", () => {
    it("syncs total_assets from wSOL vault balance", async () => {
      // Simulate external yield: transfer SOL directly to the wSOL vault account
      // and sync_native it (mimicking staking rewards flowing in).
      const yieldAmount = 0.1 * LAMPORTS_PER_SOL;

      const syncNativeTx = new Transaction();
      syncNativeTx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: ctx.wsolVault,
          lamports: yieldAmount,
        })
      );
      syncNativeTx.add(createSyncNativeInstruction(ctx.wsolVault, TOKEN_PROGRAM_ID));
      await sendAndConfirmTransaction(connection, syncNativeTx, [payer]);

      const wsolAccount = await getAccount(
        connection,
        ctx.wsolVault,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const vaultBefore = await program.account.solVault.fetch(ctx.vault);

      // total_assets (stored) lags behind actual wSOL balance
      expect(Number(wsolAccount.amount)).to.be.greaterThan(
        vaultBefore.totalAssets.toNumber()
      );

      // Call sync
      const tx = await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: ctx.vault,
          wsolVault: ctx.wsolVault,
        })
        .rpc();

      console.log("  [Stored] sync tx:", tx);

      const vaultAfter = await program.account.solVault.fetch(ctx.vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(Number(wsolAccount.amount));
    });
  });

  // ── Withdraw SOL (Stored model) ───────────────────────────────────────────

  describe("Withdraw SOL (Stored model)", () => {
    it("withdraws native SOL and decrements totalAssets", async () => {
      const withdrawLamports = new BN(0.5 * LAMPORTS_PER_SOL);

      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const vaultBefore = await program.account.solVault.fetch(ctx.vault);

      // Prepare fresh empty wSOL ATA
      const wsolATA = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(wsolATA);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(wsolATA, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID)
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
        // Wait for close to propagate so ensureEmptyWsolAccount sees null
        for (let i = 0; i < 10; i++) {
          const check = await connection.getAccountInfo(wsolATA, "confirmed");
          if (check === null) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      await program.methods
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

      const vaultAfter = await program.account.solVault.fetch(ctx.vault);
      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Stored model: totalAssets decrements by exactly withdrawLamports
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() - withdrawLamports.toNumber()
      );
      expect(Number(sharesAfter.amount)).to.be.lessThan(Number(sharesBefore.amount));
    });
  });

  // ── Redeem SOL (Stored model) ─────────────────────────────────────────────

  describe("Redeem SOL (Stored model)", () => {
    it("redeems shares for native SOL and decrements totalAssets", async () => {
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const redeemShares = new BN(Math.floor(Number(sharesBefore.amount) / 4));
      if (redeemShares.isZero()) {
        console.log("  [Stored] redeem_sol: skipped (insufficient shares)");
        return;
      }

      const vaultBefore = await program.account.solVault.fetch(ctx.vault);

      // Fresh wSOL ATA
      const wsolATA = getUserWsolATA(payer.publicKey);
      const existingInfo = await connection.getAccountInfo(wsolATA);
      if (existingInfo !== null) {
        const closeTx = new Transaction().add(
          createCloseAccountInstruction(wsolATA, payer.publicKey, payer.publicKey, [], TOKEN_PROGRAM_ID)
        );
        await sendAndConfirmTransaction(connection, closeTx, [payer]);
      }
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);

      const solBefore = await connection.getBalance(payer.publicKey);

      await program.methods
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

      const vaultAfter = await program.account.solVault.fetch(ctx.vault);
      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const solAfter = await connection.getBalance(payer.publicKey);

      expect(Number(sharesAfter.amount)).to.equal(
        Number(sharesBefore.amount) - redeemShares.toNumber()
      );
      expect(solAfter).to.be.greaterThan(solBefore);
      // totalAssets should decrease
      expect(vaultAfter.totalAssets.toNumber()).to.be.lessThan(vaultBefore.totalAssets.toNumber());
    });
  });

  // ── total_assets view (Stored model) ─────────────────────────────────────

  describe("View: total_assets (Stored model)", () => {
    it("returns stored field value, not live wSOL balance", async () => {
      const vaultAccount = await program.account.solVault.fetch(ctx.vault);

      const sim = await program.methods
        .totalAssets()
        .accountsStrict({
          vault: ctx.vault,
          sharesMint: ctx.sharesMint,
          wsolVault: ctx.wsolVault,
        })
        .simulate();

      const result = parseReturnU64(sim.raw, sim.returnData as any);
      expect(result).to.not.be.null;
      expect(result!.toNumber()).to.equal(vaultAccount.totalAssets.toNumber());
    });
  });

  // ── Operations blocked when paused ────────────────────────────────────────

  describe("Pause guard (Stored model)", () => {
    before(async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault: ctx.vault })
        .rpc();
    });

    after(async () => {
      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault: ctx.vault })
        .rpc();
    });

    it("deposit_wsol fails when paused", async () => {
      // Ensure the wSOL ATA exists so Anchor can deserialize it before
      // evaluating the vault.paused constraint
      const userWsolAccount = await ensureEmptyWsolAccount(connection, payer, payer.publicKey);
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);

      // We only need to verify the paused constraint fires before any transfer occurs
      try {
        await program.methods
          .depositWsol(new BN(MIN_DEPOSIT_LAMPORTS), new BN(0))
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected VaultPaused error");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }
    });

    it("mint_sol fails when paused", async () => {
      const userSharesAccount = getUserSharesATA(ctx.sharesMint, payer.publicKey);
      try {
        await program.methods
          .mintSol(new BN(1000), new BN(LAMPORTS_PER_SOL))
          .accountsStrict({
            user: payer.publicKey,
            vault: ctx.vault,
            wsolVault: ctx.wsolVault,
            sharesMint: ctx.sharesMint,
            userSharesAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("expected VaultPaused error");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }
    });
  });
});
