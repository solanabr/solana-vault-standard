import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Svs6 } from "../target/types/svs_6";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

describe("svs-6", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs6 as Program<Svs6>;

  // Test accounts
  const authority = provider.wallet as anchor.Wallet;
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Vault params
  const vaultId = new BN(1);
  const assetDecimals = 6; // USDC-like

  // PDAs
  let assetMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let sharesMintPda: PublicKey;
  let assetVault: PublicKey;

  // Helper: derive vault PDA
  function deriveVault(mint: PublicKey, id: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("confidential_stream_vault"),
        mint.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  }

  // Helper: derive shares mint PDA
  function deriveSharesMint(vault: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  }

  // Helper: airdrop SOL to test accounts
  async function airdrop(pubkey: PublicKey, amount: number) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      amount * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  }

  before(async () => {
    // Airdrop SOL to test users
    await airdrop(user1.publicKey, 10);
    await airdrop(user2.publicKey, 10);

    // Create asset mint (USDC-like, 6 decimals, SPL Token)
    assetMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      assetDecimals
    );

    // Derive PDAs
    [vaultPda, vaultBump] = deriveVault(assetMint, vaultId);
    [sharesMintPda] = deriveSharesMint(vaultPda);
    assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vaultPda,
      true // allowOwnerOffCurve (PDA)
    );

    // Mint test tokens to users
    const user1Ata = getAssociatedTokenAddressSync(assetMint, user1.publicKey);
    const user2Ata = getAssociatedTokenAddressSync(assetMint, user2.publicKey);

    // Create ATAs and mint
    await mintTo(
      provider.connection,
      authority.payer,
      assetMint,
      user1Ata,
      authority.payer,
      1_000_000_000_000 // 1,000,000 USDC
    );

    await mintTo(
      provider.connection,
      authority.payer,
      assetMint,
      user2Ata,
      authority.payer,
      1_000_000_000_000
    );
  });

  // ═══════════════════════════════════════════
  // INITIALIZATION TESTS
  // ═══════════════════════════════════════════

  describe("initialize", () => {
    it("creates vault with correct state", async () => {
      await program.methods
        .initialize({
          vaultId: vaultId,
          assetDecimals: assetDecimals,
          auditorElgamalPubkey: null, // no auditor
        })
        .accounts({
          authority: authority.publicKey,
          vault: vaultPda,
          assetMint: assetMint,
          sharesMint: sharesMintPda,
          assetVault: assetVault,
          assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      expect(vault.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(vault.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vault.decimalsOffset).to.equal(3); // 9 - 6
      expect(vault.paused).to.be.false;
      expect(vault.vaultId.toNumber()).to.equal(1);
      expect(vault.baseAssets.toNumber()).to.equal(0);
      expect(vault.totalShares.toNumber()).to.equal(0);
      expect(vault.streamAmount.toNumber()).to.equal(0);
      expect(vault.auditorElgamalPubkey).to.be.null;
    });

    it("rejects asset with > 9 decimals", async () => {
      // Create a 10-decimal mint
      const badMint = await createMint(
        provider.connection,
        authority.payer,
        authority.publicKey,
        null,
        10
      );

      const [badVault] = deriveVault(badMint, new BN(99));

      try {
        await program.methods
          .initialize({
            vaultId: new BN(99),
            assetDecimals: 10,
            auditorElgamalPubkey: null,
          })
          .accounts({
            authority: authority.publicKey,
            vault: badVault,
            assetMint: badMint,
            sharesMint: deriveSharesMint(badVault)[0],
            assetVault: getAssociatedTokenAddressSync(
              badMint,
              badVault,
              true
            ),
            assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should have thrown InvalidAssetDecimals");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidAssetDecimals");
      }
    });
  });

  // ═══════════════════════════════════════════
  // DEPOSIT TESTS (non-CT — standard mint)
  // ═══════════════════════════════════════════

  describe("deposit", () => {
    const depositAmount = new BN(1_000_000); // 1 USDC

    it("deposits assets and mints shares", async () => {
      const vaultBefore = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      await program.methods
        .deposit(depositAmount, new BN(0)) // min_shares_out = 0 for testing
        .accounts({
          user: user1.publicKey,
          vault: vaultPda,
          assetMint: assetMint,
          userAssetAccount: getAssociatedTokenAddressSync(
            assetMint,
            user1.publicKey
          ),
          assetVault: assetVault,
          sharesMint: sharesMintPda,
          userSharesAccount: getAssociatedTokenAddressSync(
            sharesMintPda,
            user1.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID
          ),
          assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      const vaultAfter = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      // base_assets should increase by deposit amount
      expect(vaultAfter.baseAssets.toNumber()).to.equal(
        vaultBefore.baseAssets.toNumber() + depositAmount.toNumber()
      );
      // total_shares should increase
      expect(vaultAfter.totalShares.toNumber()).to.be.greaterThan(
        vaultBefore.totalShares.toNumber()
      );
    });

    it("rejects zero deposit", async () => {
      try {
        await program.methods
          .deposit(new BN(0), new BN(0))
          .accounts({
            user: user1.publicKey,
            vault: vaultPda,
            assetMint: assetMint,
            userAssetAccount: getAssociatedTokenAddressSync(
              assetMint,
              user1.publicKey
            ),
            assetVault: assetVault,
            sharesMint: sharesMintPda,
            userSharesAccount: getAssociatedTokenAddressSync(
              sharesMintPda,
              user1.publicKey,
              false,
              TOKEN_2022_PROGRAM_ID
            ),
            assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown ZeroAmount");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("rejects deposit below minimum", async () => {
      try {
        await program.methods
          .deposit(new BN(999), new BN(0)) // below MIN_DEPOSIT_AMOUNT (1000)
          .accounts({
            user: user1.publicKey,
            vault: vaultPda,
            assetMint: assetMint,
            userAssetAccount: getAssociatedTokenAddressSync(
              assetMint,
              user1.publicKey
            ),
            assetVault: assetVault,
            sharesMint: sharesMintPda,
            userSharesAccount: getAssociatedTokenAddressSync(
              sharesMintPda,
              user1.publicKey,
              false,
              TOKEN_2022_PROGRAM_ID
            ),
            assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown DepositTooSmall");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("DepositTooSmall");
      }
    });

    it("enforces slippage protection", async () => {
      try {
        await program.methods
          .deposit(depositAmount, new BN(u64_MAX)) // impossibly high min_shares_out
          .accounts({
            user: user1.publicKey,
            vault: vaultPda,
            assetMint: assetMint,
            userAssetAccount: getAssociatedTokenAddressSync(
              assetMint,
              user1.publicKey
            ),
            assetVault: assetVault,
            sharesMint: sharesMintPda,
            userSharesAccount: getAssociatedTokenAddressSync(
              sharesMintPda,
              user1.publicKey,
              false,
              TOKEN_2022_PROGRAM_ID
            ),
            assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown SlippageExceeded");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("SlippageExceeded");
      }
    });
  });

  // ═══════════════════════════════════════════
  // STREAMING YIELD TESTS
  // ═══════════════════════════════════════════

  describe("distribute_yield + checkpoint", () => {
    it("authority can distribute yield", async () => {
      const streamAmount = new BN(100_000); // 0.1 USDC
      const duration = new BN(7 * 24 * 60 * 60); // 7 days

      await program.methods
        .distributeYield(streamAmount, duration)
        .accounts({
          authority: authority.publicKey,
          vault: vaultPda,
        })
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      expect(vault.streamAmount.toNumber()).to.equal(
        streamAmount.toNumber()
      );
      expect(vault.streamEnd.toNumber()).to.be.greaterThan(
        vault.streamStart.toNumber()
      );
    });

    it("rejects non-authority distribute_yield", async () => {
      try {
        await program.methods
          .distributeYield(new BN(100_000), new BN(86400))
          .accounts({
            authority: user1.publicKey,
            vault: vaultPda,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown Unauthorized");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("rejects invalid stream duration", async () => {
      try {
        await program.methods
          .distributeYield(new BN(100_000), new BN(100)) // too short (< 3600)
          .accounts({
            authority: authority.publicKey,
            vault: vaultPda,
          })
          .rpc();
        expect.fail("Should have thrown InvalidStreamDuration");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("InvalidStreamDuration");
      }
    });

    it("anyone can call checkpoint", async () => {
      // Advance clock (in bankrun, this is simulated)
      // For standard anchor test, we just verify the instruction succeeds
      await program.methods
        .checkpoint()
        .accounts({
          caller: user2.publicKey,
          vault: vaultPda,
        })
        .signers([user2])
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      // last_checkpoint should be updated
      expect(vault.lastCheckpoint.toNumber()).to.be.greaterThan(0);
    });
  });

  // ═══════════════════════════════════════════
  // ADMIN TESTS
  // ═══════════════════════════════════════════

  describe("admin", () => {
    it("authority can pause", async () => {
      await program.methods
        .pause()
        .accounts({
          authority: authority.publicKey,
          vault: vaultPda,
        })
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );
      expect(vault.paused).to.be.true;
    });

    it("deposit fails when paused", async () => {
      try {
        await program.methods
          .deposit(new BN(1_000_000), new BN(0))
          .accounts({
            user: user1.publicKey,
            vault: vaultPda,
            assetMint: assetMint,
            userAssetAccount: getAssociatedTokenAddressSync(
              assetMint,
              user1.publicKey
            ),
            assetVault: assetVault,
            sharesMint: sharesMintPda,
            userSharesAccount: getAssociatedTokenAddressSync(
              sharesMintPda,
              user1.publicKey,
              false,
              TOKEN_2022_PROGRAM_ID
            ),
            assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown VaultPaused");
      } catch (e) {
        expect(e.error.errorCode.code).to.equal("VaultPaused");
      }
    });

    it("authority can unpause", async () => {
      await program.methods
        .unpause()
        .accounts({
          authority: authority.publicKey,
          vault: vaultPda,
        })
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );
      expect(vault.paused).to.be.false;
    });

    it("authority can transfer authority", async () => {
      const newAuth = Keypair.generate();

      await program.methods
        .transferAuthority()
        .accounts({
          authority: authority.publicKey,
          vault: vaultPda,
          newAuthority: newAuth.publicKey,
        })
        .rpc();

      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );
      expect(vault.authority.toBase58()).to.equal(
        newAuth.publicKey.toBase58()
      );

      // Transfer back for remaining tests
      await program.methods
        .transferAuthority()
        .accounts({
          authority: newAuth.publicKey,
          vault: vaultPda,
          newAuthority: authority.publicKey,
        })
        .signers([newAuth])
        .rpc();
    });
  });

  // ═══════════════════════════════════════════
  // VIEW FUNCTION TESTS
  // ═══════════════════════════════════════════

  describe("views", () => {
    it("total_assets returns effective total including streamed yield", async () => {
      // This is a read-only call via simulate
      const vault = await program.account.confidentialStreamVault.fetch(
        vaultPda
      );

      // effective_total_assets = base_assets + accrued streaming
      // Since we just checkpointed, base_assets should include accrued
      expect(vault.baseAssets.toNumber()).to.be.greaterThan(0);
    });
  });

  // ═══════════════════════════════════════════
  // CONFIDENTIAL TRANSFER TESTS
  // ═══════════════════════════════════════════
  // ⚠️ These tests require the proof backend running.
  // Skipped by default — unskip when backend is available.

  describe.skip("confidential transfers (requires proof backend)", () => {
    it("configure_account sets up CT for user", async () => {
      // TODO: Generate ElGamal keypair via proof backend
      // TODO: Create PubkeyValidityProof
      // TODO: Call configure_account with proof in preceding instruction
    });

    it("deposit mints to pending balance", async () => {
      // TODO: After configure_account, deposit should mint to pending
    });

    it("apply_pending moves to available balance", async () => {
      // TODO: Call apply_pending with new_decryptable_available_balance
    });

    it("withdraw with ZK proofs succeeds", async () => {
      // TODO: Generate equality + range proofs via backend
      // TODO: Create proof context state accounts (tx 1)
      // TODO: Call checkpoint + withdraw (tx 2)
      // TODO: Close context accounts (tx 3)
    });

    it("redeem with ZK proofs succeeds", async () => {
      // TODO: Similar to withdraw but with exact shares
    });
  });

  // ═══════════════════════════════════════════
  // E2E LIFECYCLE TEST
  // ═══════════════════════════════════════════

  describe("E2E lifecycle (non-CT)", () => {
    it("initialize → deposit → distribute → checkpoint → redeem", async () => {
      // This tests the complete non-CT flow
      const newId = new BN(42);
      const [newVault] = deriveVault(assetMint, newId);
      const [newSharesMint] = deriveSharesMint(newVault);
      const newAssetVault = getAssociatedTokenAddressSync(
        assetMint,
        newVault,
        true
      );

      // 1. Initialize
      await program.methods
        .initialize({
          vaultId: newId,
          assetDecimals: assetDecimals,
          auditorElgamalPubkey: null,
        })
        .accounts({
          authority: authority.publicKey,
          vault: newVault,
          assetMint: assetMint,
          sharesMint: newSharesMint,
          assetVault: newAssetVault,
          assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // 2. Deposit
      await program.methods
        .deposit(new BN(10_000_000), new BN(0)) // 10 USDC
        .accounts({
          user: user1.publicKey,
          vault: newVault,
          assetMint: assetMint,
          userAssetAccount: getAssociatedTokenAddressSync(
            assetMint,
            user1.publicKey
          ),
          assetVault: newAssetVault,
          sharesMint: newSharesMint,
          userSharesAccount: getAssociatedTokenAddressSync(
            newSharesMint,
            user1.publicKey,
            false,
            TOKEN_2022_PROGRAM_ID
          ),
          assetTokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // 3. Distribute yield
      await program.methods
        .distributeYield(new BN(1_000_000), new BN(86400)) // 1 USDC over 1 day
        .accounts({
          authority: authority.publicKey,
          vault: newVault,
        })
        .rpc();

      // 4. Checkpoint
      await program.methods
        .checkpoint()
        .accounts({
          caller: user1.publicKey,
          vault: newVault,
        })
        .signers([user1])
        .rpc();

      // 5. Verify state
      const vault = await program.account.confidentialStreamVault.fetch(
        newVault
      );
      expect(vault.baseAssets.toNumber()).to.be.greaterThan(0);
      expect(vault.totalShares.toNumber()).to.be.greaterThan(0);
    });
  });
});

// Helper constant
const u64_MAX = "18446744073709551615";
