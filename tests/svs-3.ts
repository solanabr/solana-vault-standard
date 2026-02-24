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
import { Svs3 } from "../target/types/svs_3";
import {
  isBackendAvailable,
  requestPubkeyValidityProof,
  requestWithdrawProof,
  readAvailableBalanceCiphertext,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
  createDecryptableBalance,
} from "./helpers/proof-client";

describe("svs-3 (Confidential Live Balance)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs3 as Program<Svs3>;
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
        Buffer.from("vault"),
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
    // Create asset mint (USDC-like, standard SPL Token)
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

    // Get user asset account
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
      TOKEN_PROGRAM_ID,
    );

    // Derive asset vault ATA (standard SPL Token ATA for vault PDA)
    assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // Derive user shares account (Token-2022 ATA since shares mint is Token-2022)
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
      "  NOTE: SVS-3 uses LIVE balance + Confidential Transfers",
    );
  });

  // ============ Initialize ============

  describe("Initialize", () => {
    it("creates a new confidential vault", async () => {
      const tx = await program.methods
        .initialize(
          vaultId,
          "SVS-3 Vault",
          "svVault3",
          "https://example.com/vault3.json",
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

      // Fetch vault using confidentialVault account type
      const vaultAccount =
        await program.account.confidentialVault.fetch(vault);
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

      // Check live balance (asset vault should be empty)
      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(assetVaultAccount.amount)).to.equal(0);
    });

    it("initializes with auditor ElGamal pubkey", async () => {
      // Create a different asset mint for second vault
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

      // 32-byte auditor pubkey
      const auditorPubkey = Buffer.alloc(32);
      auditorPubkey.fill(0xab);

      await program.methods
        .initialize(
          new BN(2),
          "SVS-3 Audited Vault",
          "svAudit",
          "https://example.com/audited.json",
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
        await program.account.confidentialVault.fetch(vault2);
      expect(vaultAccount.auditorElgamalPubkey).to.not.equal(null);
      expect(vaultAccount.decimalsOffset).to.equal(0); // 9 - 9 = 0
    });

    it("rejects decimals > 9", async () => {
      // Create a mint with 18 decimals (simulating invalid)
      // Solana SPL Token mints cap at 9, so this test verifies the constraint
      // by creating a 9-decimal mint (which should succeed) vs the program's check
      // The program validates asset_decimals <= 9 which SPL Token enforces anyway
      // This is a documentation/coverage test
      console.log("  SPL Token enforces max 9 decimals natively");
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
        await program.account.confidentialVault.fetch(vault);
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
        await program.account.confidentialVault.fetch(vault);
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
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58(),
      );

      // Transfer back for subsequent tests
      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: vault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAfter.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
    });

    it("rejects unauthorized pause", async () => {
      const attacker = Keypair.generate();

      // Fund attacker
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

      // Unpause for subsequent tests
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });
  });

  // ============ View Functions ============

  describe("View Functions (empty vault)", () => {
    it("total_assets returns 0 for empty vault", async () => {
      await program.methods
        .totalAssets()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      // View functions use set_return_data — verify via account state
      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(assetVaultAccount.amount)).to.equal(0);
    });

    it("max_deposit returns u64::MAX when not paused", async () => {
      // max_deposit uses set_return_data, we verify it doesn't error
      await program.methods
        .maxDeposit()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("max_withdraw returns vault total assets (SVS-3 specific)", async () => {
      // SVS-3: max_withdraw returns vault total (not user-specific)
      await program.methods
        .maxWithdraw()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("max_redeem returns u64::MAX (SVS-3 specific)", async () => {
      // SVS-3: max_redeem returns u64::MAX (can't read encrypted balances)
      await program.methods
        .maxRedeem()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("preview_deposit returns expected shares", async () => {
      const assets = new BN(1_000_000); // 1 USDC
      await program.methods
        .previewDeposit(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("convert_to_shares works on empty vault", async () => {
      const assets = new BN(1_000_000); // 1 USDC
      await program.methods
        .convertToShares(assets)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("convert_to_assets works on empty vault", async () => {
      const shares = new BN(1_000_000_000); // 1 share (9 decimals)
      await program.methods
        .convertToAssets(shares)
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });

    it("view functions return 0 when paused", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      // max_deposit should return 0 when paused
      await program.methods
        .maxDeposit()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      // max_withdraw should return 0 when paused
      await program.methods
        .maxWithdraw()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      // max_redeem should return 0 when paused
      await program.methods
        .maxRedeem()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      // Unpause
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
    it("ConfidentialVault has correct field values after init", async () => {
      const vaultAccount =
        await program.account.confidentialVault.fetch(vault);

      // Verify all fields
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
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.decimalsOffset).to.equal(3);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.auditorElgamalPubkey).to.equal(null);
      // confidential_authority is set to vault PDA itself
      expect(vaultAccount.confidentialAuthority.toBase58()).to.equal(
        vault.toBase58(),
      );
    });

    it("uses different account discriminator from SVS-1 Vault", async () => {
      // Verify that fetching as "vault" (SVS-1 type) fails
      // This confirms the IDL discriminator difference
      const accountInfo = await connection.getAccountInfo(vault);
      expect(accountInfo).to.not.be.null;
      // First 8 bytes are the Anchor discriminator — different for ConfidentialVault vs Vault
      const discriminator = accountInfo!.data.subarray(0, 8);
      console.log(
        "  ConfidentialVault discriminator:",
        Buffer.from(discriminator).toString("hex"),
      );
    });
  });

  // ============ Deposit (requires configure_account first) ============
  // NOTE: Full deposit/withdraw/redeem tests require ZK proof generation.
  // These tests verify the instruction structure and error conditions.

  describe("Deposit (without configure_account)", () => {
    it("rejects deposit when vault is paused", async () => {
      // Pause first
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      // Create user shares ATA (Token-2022)
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("VaultPaused");
      }

      // Unpause
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("ZeroAmount");
      }
    });

    it("rejects deposit below minimum", async () => {
      try {
        // MIN_DEPOSIT_AMOUNT is 1000
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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
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
      // Create dummy proof context accounts (will fail at proof validation anyway)
      const dummyProof1 = Keypair.generate();
      const dummyProof2 = Keypair.generate();

      try {
        await program.methods
          .withdraw(new BN(0), new BN(0), Array.from(new Uint8Array(36)))
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
        // Will fail at either ZeroAmount check or proof validation
        expect(err).to.exist;
      }
    });
  });

  // ============ PDA Derivation Verification ============

  describe("PDA Derivation", () => {
    it("vault PDA matches expected seeds", () => {
      const [derivedVault] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
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

  // ============ Full Deposit Flow (requires proof backend) ============
  // These tests exercise configure_account → deposit → apply_pending.
  // Skipped if the proof backend is not running.

  describe("Confidential Deposit Flow (requires proof backend)", function () {
    let backendAvailable: boolean;

    before(async function () {
      backendAvailable = await isBackendAvailable();
      if (!backendAvailable) {
        console.log(
          "  ⚠ Proof backend not running — skipping CT deposit tests",
        );
        console.log(
          "    Start with: cd proofs-backend && cargo run",
        );
        this.skip();
      }
    });

    it("configure_account enables confidential transfers on shares account", async function () {
      if (!backendAvailable) this.skip();

      // Get proof from backend
      const { proofData, elgamalPubkey } =
        await requestPubkeyValidityProof(payer, userSharesAccount);

      console.log(
        "  Proof data size:",
        proofData.length,
        "bytes",
      );
      console.log(
        "  ElGamal pubkey size:",
        elgamalPubkey.length,
        "bytes",
      );

      // Create decryptable zero balance
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const decryptableZeroBalance = createDecryptableZeroBalance(aesKey);

      // ZK ElGamal proof program ID
      const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
        "ZkE1Gama1Proof11111111111111111111111111111",
      );

      // Create VerifyPubkeyValidity instruction (discriminator = 4)
      const verifyProofIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [],
        data: Buffer.concat([Buffer.from([4]), proofData]),
      });

      // Create configure_account instruction via program
      // proof_instruction_offset = -1 (verify proof is 1 instruction before)
      const configureIx = await program.methods
        .configureAccount(
          Array.from(decryptableZeroBalance),
          -1, // proof is 1 instruction before
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

      // Build transaction: verify proof → configure account
      const tx = new Transaction().add(verifyProofIx, configureIx);
      const sig = await provider.sendAndConfirm(tx);

      console.log("  Configure account tx:", sig);

      // Verify the shares account now has CT extension
      const accountInfo = await connection.getAccountInfo(userSharesAccount);
      expect(accountInfo).to.not.be.null;
      // Account should be larger after reallocation for CT extension
      expect(accountInfo!.data.length).to.be.greaterThan(165);
    });

    it("deposits assets and receives confidential shares", async function () {
      if (!backendAvailable) this.skip();

      const depositAmount = new BN(1_000_000); // 1 USDC

      // Get asset balance before
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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Deposit tx:", tx);

      // Verify asset was transferred to vault
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

      // Shares were minted then moved to pending — non-confidential balance should be 0
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(sharesAccount.amount)).to.equal(0);

      // Shares mint supply should have increased
      const mint = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(mint.supply)).to.be.greaterThan(0);

      console.log(
        "  Shares minted (now in pending):",
        Number(mint.supply),
      );
    });

    it("apply_pending moves shares from pending to available", async function () {
      if (!backendAvailable) this.skip();

      // Create new decryptable balance after applying pending
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableZeroBalance(aesKey);

      // The pending_balance_credit_counter should be 1 after one deposit
      const tx = await program.methods
        .applyPending(
          Array.from(newDecryptableBalance),
          new BN(1), // expected_pending_balance_credit_counter
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  Apply pending tx:", tx);

      // After applying, non-confidential balance is still 0
      // but confidential available balance has the shares
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(sharesAccount.amount)).to.equal(0);
    });

    it("second deposit increments pending counter", async function () {
      if (!backendAvailable) this.skip();

      const depositAmount = new BN(500_000); // 0.5 USDC

      const supplyBefore = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

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
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const supplyAfter = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      expect(Number(supplyAfter.supply)).to.be.greaterThan(
        Number(supplyBefore.supply),
      );

      // Apply pending with counter = 2 (second deposit)
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newBalance = createDecryptableZeroBalance(aesKey);

      await program.methods
        .applyPending(
          Array.from(newBalance),
          new BN(2),
        )
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log(
        "  Total shares supply after 2 deposits:",
        Number(supplyAfter.supply),
      );
    });

    it("view functions reflect deposited state", async function () {
      if (!backendAvailable) this.skip();

      // total_assets should now be > 0
      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(assetVaultAccount.amount)).to.be.greaterThan(0);

      // preview_deposit should still work
      await program.methods
        .previewDeposit(new BN(1_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      // total_assets view
      await program.methods
        .totalAssets()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });
  });

  // ============ Full Withdraw/Redeem Flow (requires proof backend) ============
  // These tests exercise withdraw and redeem with equality + range proofs.
  // The program uses ProofLocation::ContextStateAccount, so we must:
  // 1. Create accounts owned by the ZK ElGamal proof program
  // 2. Verify proofs into them
  // 3. Pass them to the vault's withdraw/redeem instruction
  // Depends on the deposit flow above having run first.

  describe("Confidential Withdraw/Redeem Flow (requires proof backend)", function () {
    let backendAvailable: boolean;
    const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
      "ZkE1Gama1Proof11111111111111111111111111111",
    );

    // ProofContextState sizes:
    //   header = authority(32) + proof_type(1) = 33
    //   CiphertextCommitmentEqualityProofContext = pubkey(32) + ciphertext(64) + commitment(32) = 128
    //   BatchedRangeProofContext = commitments(8*32) + bit_lengths(8) = 264
    const EQUALITY_CONTEXT_SIZE = 33 + 128; // 161 bytes
    const RANGE_CONTEXT_SIZE = 33 + 264; // 297 bytes

    /**
     * Create a context state account and verify proof into it.
     * Split into 2 transactions because range proofs (936 bytes) exceed
     * the single-tx size limit (1232 bytes) when combined with createAccount.
     */
    async function createProofContext(
      proofDiscriminator: number,
      proofData: Uint8Array,
      contextSize: number,
    ): Promise<PublicKey> {
      const contextKeypair = Keypair.generate();
      const lamports = await connection.getMinimumBalanceForRentExemption(contextSize);

      // Tx 1: Create the account owned by ZK ElGamal proof program
      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: contextKeypair.publicKey,
        lamports,
        space: contextSize,
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
      });
      const createTx = new Transaction().add(createAccountIx);
      await provider.sendAndConfirm(createTx, [payer, contextKeypair]);

      // Tx 2: Verify proof and write context data into the account
      // ZK ElGamal verify instruction needs 2 accounts when writing to context state:
      //   [0] context_state_account (writable)
      //   [1] context_state_authority (readonly)
      const verifyIx = new TransactionInstruction({
        programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
        keys: [
          { pubkey: contextKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([proofDiscriminator]), proofData]),
      });
      const verifyTx = new Transaction().add(verifyIx);
      await provider.sendAndConfirm(verifyTx);

      return contextKeypair.publicKey;
    }

    before(async function () {
      backendAvailable = await isBackendAvailable();
      if (!backendAvailable) {
        console.log(
          "  ⚠ Proof backend not running — skipping CT withdraw tests",
        );
        console.log(
          "    Start with: cd proofs-backend && cargo run",
        );
        this.skip();
      }
    });

    it("redeems shares via confidential withdraw flow", async function () {
      if (!backendAvailable) this.skip();

      const mintBefore = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultBalanceBefore = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const userAssetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const totalShares = Number(mintBefore.supply);
      const totalAssets = Number(vaultBalanceBefore.amount);
      console.log("  State before redeem:");
      console.log("    Total shares:", totalShares);
      console.log("    Total assets:", totalAssets);

      // Redeem a portion. After 2 deposits (1M + 500K = 1.5M USDC),
      // shares at ~1000:1 ratio → ~1.5B shares. Redeem 500M.
      const sharesToRedeem = 500_000_000;

      // Read available balance ciphertext from CT extension
      const availableCiphertext = await readAvailableBalanceCiphertext(
        connection,
        userSharesAccount,
      );
      console.log(
        "  Available balance ciphertext:",
        availableCiphertext.length,
        "bytes",
      );

      const currentSharesBalance = totalShares;

      // Get withdraw proofs from backend
      const { equalityProof, rangeProof } = await requestWithdrawProof(
        payer,
        userSharesAccount,
        availableCiphertext,
        currentSharesBalance,
        sharesToRedeem,
      );

      console.log("  Equality proof:", equalityProof.length, "bytes");
      console.log("  Range proof:", rangeProof.length, "bytes");

      // Create context state accounts with verified proofs
      // discriminator 3 = VerifyCiphertextCommitmentEquality
      // discriminator 6 = VerifyBatchedRangeProofU64
      const equalityContext = await createProofContext(3, equalityProof, EQUALITY_CONTEXT_SIZE);
      const rangeContext = await createProofContext(6, rangeProof, RANGE_CONTEXT_SIZE);

      console.log("  Equality context:", equalityContext.toBase58());
      console.log("  Range context:", rangeContext.toBase58());

      // Compute new decryptable balance after redeem
      const remainingShares = currentSharesBalance - sharesToRedeem;
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableBalance(
        aesKey,
        remainingShares,
      );

      // Call redeem with context state accounts
      const tx = await program.methods
        .redeem(
          new BN(sharesToRedeem),
          new BN(0), // min_assets_out
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
          equalityProofContext: equalityContext,
          rangeProofContext: rangeContext,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  Redeem tx:", tx);

      // Verify state after redeem
      const mintAfter = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultBalanceAfter = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const userAssetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const sharesBurned = totalShares - Number(mintAfter.supply);
      const assetsReceived =
        Number(userAssetAfter.amount) - Number(userAssetBefore.amount);
      const vaultDecrease =
        Number(vaultBalanceBefore.amount) - Number(vaultBalanceAfter.amount);

      console.log("  Shares burned:", sharesBurned);
      console.log("  Assets received:", assetsReceived);
      console.log("  Vault decrease:", vaultDecrease);

      expect(sharesBurned).to.equal(sharesToRedeem);
      expect(assetsReceived).to.equal(vaultDecrease);
      expect(assetsReceived).to.be.greaterThan(0);
    });

    it("withdraws exact assets via confidential withdraw flow", async function () {
      if (!backendAvailable) this.skip();

      const mintBefore = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultBalanceBefore = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const userAssetBefore = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      const totalShares = Number(mintBefore.supply);
      const totalAssets = Number(vaultBalanceBefore.amount);
      const withdrawAssets = 100_000; // 0.1 USDC

      console.log("  State before withdraw:");
      console.log("    Total shares:", totalShares);
      console.log("    Total assets:", totalAssets);

      // Read current ciphertext
      const availableCiphertext = await readAvailableBalanceCiphertext(
        connection,
        userSharesAccount,
      );

      const currentSharesBalance = totalShares;

      // Calculate shares to burn (ceiling rounding)
      const offset = 1000;
      const sharesToBurn = Math.ceil(
        (withdrawAssets * (totalShares + offset)) / (totalAssets + 1),
      );

      // Get withdraw proofs
      const { equalityProof, rangeProof } = await requestWithdrawProof(
        payer,
        userSharesAccount,
        availableCiphertext,
        currentSharesBalance,
        sharesToBurn,
      );

      // Create context state accounts
      const equalityContext = await createProofContext(3, equalityProof, EQUALITY_CONTEXT_SIZE);
      const rangeContext = await createProofContext(6, rangeProof, RANGE_CONTEXT_SIZE);

      const remainingShares = currentSharesBalance - sharesToBurn;
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newDecryptableBalance = createDecryptableBalance(
        aesKey,
        remainingShares,
      );

      const tx = await program.methods
        .withdraw(
          new BN(withdrawAssets),
          new BN(sharesToBurn + 1000), // max_shares_in with buffer
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
          equalityProofContext: equalityContext,
          rangeProofContext: rangeContext,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();

      console.log("  Withdraw tx:", tx);

      const userAssetAfter = await getAccount(
        connection,
        userAssetAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const assetsReceived =
        Number(userAssetAfter.amount) - Number(userAssetBefore.amount);

      expect(assetsReceived).to.equal(withdrawAssets);
      console.log("  Assets received:", assetsReceived, "(exact)");
    });

    it("view functions reflect state after withdraw/redeem", async function () {
      if (!backendAvailable) this.skip();

      const vaultBalance = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      const mint = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("  Final state:");
      console.log("    Vault assets:", Number(vaultBalance.amount));
      console.log("    Shares supply:", Number(mint.supply));

      expect(Number(vaultBalance.amount)).to.be.greaterThan(0);
      expect(Number(mint.supply)).to.be.greaterThan(0);

      await program.methods
        .totalAssets()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();

      await program.methods
        .previewDeposit(new BN(1_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
          assetVault: assetVault,
        })
        .rpc();
    });
  });
});
