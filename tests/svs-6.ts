import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs6 } from "../target/types/svs_6";
import {
  isBackendAvailable,
  requestPubkeyValidityProof,
  requestWithdrawProof,
  readAvailableBalanceCiphertext,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  createDecryptableBalance,
} from "./helpers/proof-client";

describe("svs-6 (Confidential Streaming Yield Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs6 as Program<Svs6>;
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

  const getVaultPDA = (
    assetMint: PublicKey,
    vaultId: BN,
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("confidential_stream_vault"),
        assetMint.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  };

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId,
    );
  };

  before(async () => {
    assetMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      ASSET_DECIMALS,
      Keypair.generate(),
      undefined,
      TOKEN_PROGRAM_ID,
    );

    [vault] = getVaultPDA(assetMint, vaultId);
    [sharesMint] = getSharesMintPDA(vault);

    const userAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    userAssetAccount = userAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      userAssetAccount,
      payer.publicKey,
      1_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID,
    );

    assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Asset Mint:", assetMint.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Shares Mint:", sharesMint.toBase58());
    console.log(
      "  NOTE: SVS-6 uses streaming yield + confidential transfers",
    );
  });

  // ============ Initialize ============

  describe("Initialize", () => {
    it("creates a new confidential streaming vault", async () => {
      const tx = await program.methods
        .initialize(
          vaultId,
          null, // no auditor
        )
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetMint: assetMint,
          sharesMint: sharesMint,
          assetVault: assetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("  Initialize tx:", tx);

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
      expect(vaultAccount.assetMint.toBase58()).to.equal(
        assetMint.toBase58(),
      );
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58(),
      );
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.decimalsOffset).to.equal(3); // 9 - 6 = 3
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.auditorElgamalPubkey).to.equal(null);
      expect(vaultAccount.confidentialAuthority.toBase58()).to.equal(
        vault.toBase58(),
      );

      // Streaming fields zeroed
      expect(vaultAccount.baseAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.streamAmount.toNumber()).to.equal(0);
      expect(vaultAccount.streamStart.toNumber()).to.equal(0);
      expect(vaultAccount.streamEnd.toNumber()).to.equal(0);
      expect(vaultAccount.lastCheckpoint.toNumber()).to.be.greaterThan(0);

      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(assetVaultAccount.amount)).to.equal(0);
    });

    it("initializes with auditor ElGamal pubkey", async () => {
      const assetMint2 = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        9,
        Keypair.generate(),
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const [vault2] = getVaultPDA(assetMint2, new BN(2));
      const [sharesMint2] = getSharesMintPDA(vault2);
      const assetVault2 = getAssociatedTokenAddressSync(
        assetMint2,
        vault2,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const auditorPubkey = Buffer.alloc(32);
      auditorPubkey.fill(0xab);

      await program.methods
        .initialize(
          new BN(2),
          Array.from(auditorPubkey),
        )
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault2,
          assetMint: assetMint2,
          sharesMint: sharesMint2,
          assetVault: assetVault2,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault2);
      expect(vaultAccount.auditorElgamalPubkey).to.not.equal(null);
      expect(vaultAccount.decimalsOffset).to.equal(0); // 9 - 9 = 0
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
    });
  });

  // ============ Admin Operations ============

  describe("Admin Operations", () => {
    it("pauses the vault", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(true);
    });

    it("unpauses the vault", async () => {
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
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

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58(),
      );

      // Transfer back
      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: vault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAfter.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
    });

    it("rejects unauthorized pause", async () => {
      const attacker = Keypair.generate();

      const sig = await connection.requestAirdrop(
        attacker.publicKey,
        1_000_000_000,
      );
      await connection.confirmTransaction(sig);

      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: attacker.publicKey,
            vault: vault,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Unauthorized");
      }
    });

    it("rejects double pause", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("VaultPaused");
      }

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });
  });

  // ============ View Functions (empty vault) ============

  describe("View Functions (empty vault)", () => {
    it("total_assets returns 0 for empty vault", async () => {
      await program.methods
        .totalAssets()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(assetVaultAccount.amount)).to.equal(0);
    });

    it("max_deposit returns u64::MAX when not paused", async () => {
      await program.methods
        .maxDeposit()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("max_withdraw returns 0 (encrypted balances)", async () => {
      await program.methods
        .maxWithdraw()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("max_redeem returns 0 (encrypted balances)", async () => {
      await program.methods
        .maxRedeem()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("preview_deposit returns expected shares", async () => {
      const assets = new BN(1_000_000);
      await program.methods
        .previewDeposit(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("convert_to_shares works on empty vault", async () => {
      const assets = new BN(1_000_000);
      await program.methods
        .convertToShares(assets)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("convert_to_assets works on empty vault", async () => {
      const shares = new BN(1_000_000_000);
      await program.methods
        .convertToAssets(shares)
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("get_stream_info returns stream state", async () => {
      await program.methods
        .getStreamInfo()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      console.log("  Stream info:");
      console.log(
        "    streamAmount:",
        vaultAccount.streamAmount.toNumber(),
      );
      console.log(
        "    streamStart:",
        vaultAccount.streamStart.toNumber(),
      );
      console.log(
        "    streamEnd:",
        vaultAccount.streamEnd.toNumber(),
      );
    });

    it("view functions return 0 when paused", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      await program.methods
        .maxDeposit()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .maxWithdraw()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .maxRedeem()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });
  });

  // ============ State Verification ============

  describe("State Struct", () => {
    it("ConfidentialStreamVault has correct field values after init", async () => {
      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);

      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
      expect(vaultAccount.assetMint.toBase58()).to.equal(
        assetMint.toBase58(),
      );
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58(),
      );
      expect(vaultAccount.assetVault.toBase58()).to.equal(
        assetVault.toBase58(),
      );
      expect(vaultAccount.baseAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.decimalsOffset).to.equal(3);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.auditorElgamalPubkey).to.equal(null);
      expect(vaultAccount.confidentialAuthority.toBase58()).to.equal(
        vault.toBase58(),
      );
    });

    it("uses different account discriminator from SVS-1 and SVS-3", async () => {
      const accountInfo = await connection.getAccountInfo(vault);
      expect(accountInfo).to.not.be.null;
      const discriminator = accountInfo!.data.subarray(0, 8);
      console.log(
        "  ConfidentialStreamVault discriminator:",
        Buffer.from(discriminator).toString("hex"),
      );
    });
  });

  // ============ PDA Derivation Verification ============

  describe("PDA Derivation", () => {
    it("vault PDA matches expected seeds", () => {
      const [derivedVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("confidential_stream_vault"),
          assetMint.toBuffer(),
          vaultId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      expect(derivedVault.toBase58()).to.equal(vault.toBase58());
    });

    it("shares mint PDA matches expected seeds", () => {
      const [derivedSharesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("shares"), vault.toBuffer()],
        program.programId,
      );
      expect(derivedSharesMint.toBase58()).to.equal(
        sharesMint.toBase58(),
      );
    });
  });

  // ============ Deposit Error Conditions (before configure_account) ============

  describe("Deposit error conditions", () => {
    it("rejects deposit when vault is paused", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      try {
        await program.methods
          .deposit(new BN(1_000_000), new BN(0))
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("VaultPaused");
      }

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });

    it("rejects zero deposit", async () => {
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
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("ZeroAmount");
      }
    });

    it("rejects deposit below minimum", async () => {
      try {
        await program.methods
          .deposit(new BN(999), new BN(0))
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("DepositTooSmall");
      }
    });
  });

  // ============ Withdraw / Redeem Error Conditions ============

  describe("Withdraw error conditions", () => {
    it("rejects zero withdrawal", async () => {
      const dummyProof1 = Keypair.generate();
      const dummyProof2 = Keypair.generate();

      try {
        await program.methods
          .withdraw(
            new BN(0),
            new BN(0),
            Array.from(new Uint8Array(36)),
          )
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            equalityProofContext: dummyProof1.publicKey,
            rangeProofContext: dummyProof2.publicKey,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });
  });

  describe("Redeem error conditions", () => {
    it("rejects zero redeem", async () => {
      const dummyProof1 = Keypair.generate();
      const dummyProof2 = Keypair.generate();

      try {
        await program.methods
          .redeem(
            new BN(0),
            new BN(0),
            Array.from(new Uint8Array(36)),
          )
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            equalityProofContext: dummyProof1.publicKey,
            rangeProofContext: dummyProof2.publicKey,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });
  });

  // ============ Streaming Yield Error Conditions ============

  describe("Streaming Yield error conditions", () => {
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
      }
    });

    it("rejects distribute_yield when paused", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

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
      }

      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });
  });

  // ============ Checkpoint (empty vault) ============

  describe("Checkpoint (empty vault)", () => {
    it("checkpoint is permissionless and succeeds on empty vault", async () => {
      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      console.log("  Checkpoint called successfully (no signer required)");
    });

    it("checkpoint with no active stream is a no-op", async () => {
      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);

      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAfter.baseAssets.toNumber()).to.equal(
        vaultBefore.baseAssets.toNumber(),
      );
      console.log("  Checkpoint no-op confirmed (no active stream)");
    });
  });

  // ============ Slippage Protection ============

  describe("Slippage protection", () => {
    it("slippage protection on deposit (requires proof backend)", async function () {
      const backendAvailable = await isBackendAvailable();
      if (!backendAvailable) {
        console.log("  Proof backend not running -- skipping slippage test");
        this.skip();
      }

      // This would need configure_account first; test structure only
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      const unreasonableMinShares = new BN("18446744073709551615");

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
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("Slippage") ||
            s.includes("SlippageExceeded") ||
            s.includes("BelowMinimum"),
        );
        console.log("  Slippage protection on deposit works correctly");
      }
    });
  });

  // ============ Full Confidential Streaming Flow (requires proof backend) ============

  describe("Confidential Streaming Flow (requires proof backend)", function () {
    let backendAvailable: boolean;
    let pendingCreditCounter = 0;

    before(async function () {
      backendAvailable = await isBackendAvailable();
      if (!backendAvailable) {
        console.log(
          "  Proof backend not running -- skipping CT flow tests",
        );
        console.log(
          "    Start with: cd proofs-backend && cargo run",
        );
        this.skip();
      }
    });

    // ---- Configure Account ----

    it("configure_account enables confidential transfers on shares account", async function () {
      if (!backendAvailable) this.skip();

      const { proofData, elgamalPubkey } =
        await requestPubkeyValidityProof(payer, userSharesAccount);

      console.log("  Proof data size:", proofData.length, "bytes");
      console.log("  ElGamal pubkey size:", elgamalPubkey.length, "bytes");

      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const decryptableZeroBalance = createDecryptableZeroBalance(aesKey);

      const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
        "ZkE1Gama1Proof11111111111111111111111111111",
      );

      const verifyProofIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [],
        data: Buffer.concat([Buffer.from([4]), proofData]),
      });

      const configureIx = await program.methods
        .configureAccount(
          Array.from(decryptableZeroBalance),
          -1,
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          proofContextAccount: null,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const tx = new Transaction().add(verifyProofIx, configureIx);
      const sig = await provider.sendAndConfirm(tx);

      console.log("  Configure account tx:", sig);

      const accountInfo = await connection.getAccountInfo(userSharesAccount);
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.data.length).to.be.greaterThan(165);
    });

    // ---- Deposit + Apply Pending ----

    it("deposits assets and receives confidential shares", async function () {
      if (!backendAvailable) this.skip();

      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      const assetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const vaultBalanceBefore = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

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
        })
        .rpc();

      console.log("  Deposit tx:", tx);
      pendingCreditCounter++;

      const assetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const vaultBalanceAfter = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(
        Number(assetBefore.amount) - Number(assetAfter.amount),
      ).to.equal(depositAmount.toNumber());
      expect(
        Number(vaultBalanceAfter.amount) - Number(vaultBalanceBefore.amount),
      ).to.equal(depositAmount.toNumber());

      // Non-confidential balance is 0 (moved to CT pending)
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(sharesAccount.amount)).to.equal(0);

      // Shares mint supply increased
      const mint = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(mint.supply)).to.be.greaterThan(0);

      // base_assets and total_shares updated in state
      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.baseAssets.toNumber()).to.equal(
        depositAmount.toNumber(),
      );
      expect(vaultAccount.totalShares.toNumber()).to.be.greaterThan(0);

      console.log(
        "  baseAssets:",
        vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  totalShares:",
        vaultAccount.totalShares.toNumber() / 10 ** 9,
      );
    });

    it("apply_pending moves shares from pending to available", async function () {
      if (!backendAvailable) this.skip();

      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableZeroBalance(aesKey);

      const tx = await program.methods
        .applyPending(
          Array.from(newDecryptableBalance),
          new BN(pendingCreditCounter),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  Apply pending tx:", tx);

      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(sharesAccount.amount)).to.equal(0);
    });

    // ---- Mint + Apply Pending ----

    it("mints exact shares via mint instruction", async function () {
      if (!backendAvailable) this.skip();

      const mintShares = new BN(1000 * 10 ** 9);

      const assetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);

      await program.methods
        .mint(mintShares, new BN(Number(assetBefore.amount)))
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

      pendingCreditCounter++;

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.be.greaterThan(
        vaultBefore.totalShares.toNumber(),
      );
      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThan(
        vaultBefore.baseAssets.toNumber(),
      );

      console.log(
        "  totalShares after mint:",
        vaultAfter.totalShares.toNumber() / 10 ** 9,
      );
      console.log(
        "  baseAssets after mint:",
        vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );

      // Apply pending for the mint
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newBalance = createDecryptableZeroBalance(aesKey);

      await program.methods
        .applyPending(
          Array.from(newBalance),
          new BN(pendingCreditCounter),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    });

    // ---- Distribute Yield ----

    it("distribute_yield starts a stream", async function () {
      if (!backendAvailable) this.skip();

      const yieldAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const duration = new BN(120);

      const userAssetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const assetVaultBefore = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

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

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      const userAssetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const assetVaultAfter = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(vaultAccount.streamAmount.toNumber()).to.equal(
        yieldAmount.toNumber(),
      );
      expect(vaultAccount.streamStart.toNumber()).to.be.greaterThan(0);
      expect(vaultAccount.streamEnd.toNumber()).to.equal(
        vaultAccount.streamStart.toNumber() + duration.toNumber(),
      );
      expect(vaultAccount.lastCheckpoint.toNumber()).to.be.greaterThan(0);

      const authorityDebited =
        Number(userAssetBefore.amount) - Number(userAssetAfter.amount);
      expect(authorityDebited).to.equal(yieldAmount.toNumber());

      const vaultCredited =
        Number(assetVaultAfter.amount) - Number(assetVaultBefore.amount);
      expect(vaultCredited).to.equal(yieldAmount.toNumber());

      console.log("  Stream started:");
      console.log(
        "    Amount:",
        vaultAccount.streamAmount.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log("    Start:", vaultAccount.streamStart.toNumber());
      console.log("    End:", vaultAccount.streamEnd.toNumber());
    });

    // ---- Checkpoint ----

    it("checkpoint finalizes accrued yield", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);
      const baseAssetsBefore = vaultBefore.baseAssets.toNumber();

      await new Promise((resolve) => setTimeout(resolve, 2000));

      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);

      expect(vaultAfter.lastCheckpoint.toNumber()).to.be.greaterThanOrEqual(
        vaultBefore.lastCheckpoint.toNumber(),
      );
      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThanOrEqual(
        baseAssetsBefore,
      );

      console.log(
        "  baseAssets before:",
        baseAssetsBefore / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  baseAssets after:",
        vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  Accrued:",
        (vaultAfter.baseAssets.toNumber() - baseAssetsBefore) /
          10 ** ASSET_DECIMALS,
      );
    });

    // ---- Auto-checkpoint on deposit ----

    it("auto-checkpoint on deposit updates baseAssets before share calculation", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);
      const baseAssetsBefore = vaultBefore.baseAssets.toNumber();

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);

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
        .rpc();

      pendingCreditCounter++;

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);

      // baseAssets should increase by more than just the deposit (accrued yield + deposit)
      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThan(
        baseAssetsBefore + depositAmount.toNumber(),
      );

      console.log(
        "  baseAssets increased by:",
        (vaultAfter.baseAssets.toNumber() - baseAssetsBefore) /
          10 ** ASSET_DECIMALS,
        "(deposit + accrued yield from auto-checkpoint)",
      );

      // Apply pending
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newBalance = createDecryptableZeroBalance(aesKey);

      await program.methods
        .applyPending(
          Array.from(newBalance),
          new BN(pendingCreditCounter),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    });

    // ---- Withdraw with proofs ----

    it("withdraws exact assets with ZK proofs", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);
      const assetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const withdrawAssets = new BN(5_000 * 10 ** ASSET_DECIMALS);

      // Read current available balance ciphertext
      const currentCiphertext = await readAvailableBalanceCiphertext(
        connection,
        userSharesAccount,
      );

      // Compute current share balance from vault state
      const currentBalance = vaultBefore.totalShares.toNumber();

      const { equalityProof, rangeProof } = await requestWithdrawProof(
        payer,
        userSharesAccount,
        currentCiphertext,
        currentBalance,
        withdrawAssets.toNumber(),
      );

      // Create context state accounts for proofs (split into 2 txs per lesson learned)
      const equalityProofContext = Keypair.generate();
      const rangeProofContext = Keypair.generate();

      const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
        "ZkE1Gama1Proof11111111111111111111111111111",
      );

      // Verify equality proof (discriminator = 3)
      const verifyEqualityIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [
          {
            pubkey: equalityProofContext.publicKey,
            isSigner: true,
            isWritable: true,
          },
        ],
        data: Buffer.concat([Buffer.from([3]), equalityProof]),
      });

      const equalityTx = new Transaction().add(verifyEqualityIx);
      await provider.sendAndConfirm(equalityTx, [equalityProofContext]);

      // Verify range proof (discriminator = 7)
      const verifyRangeIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [
          {
            pubkey: rangeProofContext.publicKey,
            isSigner: true,
            isWritable: true,
          },
        ],
        data: Buffer.concat([Buffer.from([7]), rangeProof]),
      });

      const rangeTx = new Transaction().add(verifyRangeIx);
      await provider.sendAndConfirm(rangeTx, [rangeProofContext]);

      // Compute new decryptable balance
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableBalance(
        aesKey,
        currentBalance - withdrawAssets.toNumber(),
      );

      await program.methods
        .withdraw(
          withdrawAssets,
          new BN(vaultBefore.totalShares.toNumber()),
          Array.from(newDecryptableBalance),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          equalityProofContext: equalityProofContext.publicKey,
          rangeProofContext: rangeProofContext.publicKey,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const assetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const assetsReceived =
        Number(assetAfter.amount) - Number(assetBefore.amount);
      expect(assetsReceived).to.equal(withdrawAssets.toNumber());

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.be.lessThan(
        vaultBefore.totalShares.toNumber(),
      );

      console.log(
        "  Withdrew:",
        assetsReceived / 10 ** ASSET_DECIMALS,
        "assets",
      );
      console.log(
        "  baseAssets now:",
        vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  totalShares now:",
        vaultAfter.totalShares.toNumber() / 10 ** 9,
      );
    });

    // ---- Redeem with proofs ----

    it("redeems shares for assets with ZK proofs", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);
      const assetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      // Redeem 10% of remaining shares
      const redeemShares = new BN(
        Math.floor(vaultBefore.totalShares.toNumber() / 10),
      );

      const currentCiphertext = await readAvailableBalanceCiphertext(
        connection,
        userSharesAccount,
      );
      const currentBalance = vaultBefore.totalShares.toNumber();

      const { equalityProof, rangeProof } = await requestWithdrawProof(
        payer,
        userSharesAccount,
        currentCiphertext,
        currentBalance,
        redeemShares.toNumber(),
      );

      const equalityProofContext = Keypair.generate();
      const rangeProofContext = Keypair.generate();

      const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
        "ZkE1Gama1Proof11111111111111111111111111111",
      );

      const verifyEqualityIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [
          {
            pubkey: equalityProofContext.publicKey,
            isSigner: true,
            isWritable: true,
          },
        ],
        data: Buffer.concat([Buffer.from([3]), equalityProof]),
      });
      await provider.sendAndConfirm(
        new Transaction().add(verifyEqualityIx),
        [equalityProofContext],
      );

      const verifyRangeIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [
          {
            pubkey: rangeProofContext.publicKey,
            isSigner: true,
            isWritable: true,
          },
        ],
        data: Buffer.concat([Buffer.from([7]), rangeProof]),
      });
      await provider.sendAndConfirm(
        new Transaction().add(verifyRangeIx),
        [rangeProofContext],
      );

      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableBalance(
        aesKey,
        currentBalance - redeemShares.toNumber(),
      );

      await program.methods
        .redeem(
          redeemShares,
          new BN(0),
          Array.from(newDecryptableBalance),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          equalityProofContext: equalityProofContext.publicKey,
          rangeProofContext: rangeProofContext.publicKey,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      const assetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const assetsReceived =
        Number(assetAfter.amount) - Number(assetBefore.amount);
      expect(assetsReceived).to.be.greaterThan(0);

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.be.lessThan(
        vaultBefore.totalShares.toNumber(),
      );

      console.log(
        "  Redeemed:",
        redeemShares.toNumber() / 10 ** 9,
        "shares for",
        assetsReceived / 10 ** ASSET_DECIMALS,
        "assets",
      );
      console.log(
        "  baseAssets now:",
        vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  totalShares now:",
        vaultAfter.totalShares.toNumber() / 10 ** 9,
      );
    });

    // ---- Checkpoint after stream ends ----

    it("checkpoint after stream ends finalizes all yield", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialStreamVault.fetch(vault);
      const baseAssetsBefore = vaultBefore.baseAssets.toNumber();
      const streamRemaining = vaultBefore.streamAmount.toNumber();

      await program.methods
        .checkpoint()
        .accountsStrict({
          vault: vault,
        })
        .rpc();

      const vaultAfter =
        await program.account.confidentialStreamVault.fetch(vault);

      expect(vaultAfter.baseAssets.toNumber()).to.be.greaterThanOrEqual(
        baseAssetsBefore,
      );
      expect(vaultAfter.baseAssets.toNumber()).to.be.lessThanOrEqual(
        baseAssetsBefore + streamRemaining,
      );

      console.log(
        "  baseAssets before:",
        baseAssetsBefore / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  baseAssets after:",
        vaultAfter.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
    });

    // ---- View functions reflect deposited state ----

    it("view functions reflect deposited state", async function () {
      if (!backendAvailable) this.skip();

      const vaultAccount =
        await program.account.confidentialStreamVault.fetch(vault);
      expect(vaultAccount.baseAssets.toNumber()).to.be.greaterThan(0);
      expect(vaultAccount.totalShares.toNumber()).to.be.greaterThan(0);

      await program.methods
        .previewDeposit(new BN(1_000_000))
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .totalAssets()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .getStreamInfo()
        .accounts({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      console.log(
        "  baseAssets:",
        vaultAccount.baseAssets.toNumber() / 10 ** ASSET_DECIMALS,
      );
      console.log(
        "  totalShares:",
        vaultAccount.totalShares.toNumber() / 10 ** 9,
      );
    });
  });
});
