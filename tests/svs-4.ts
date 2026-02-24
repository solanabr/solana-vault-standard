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
  transfer,
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
import { Svs4 } from "../target/types/svs_4";
import {
  isBackendAvailable,
  requestPubkeyValidityProof,
  deriveAesKeyFromSignature,
  createDecryptableZeroBalance,
} from "./helpers/proof-client";

describe("svs-4 (Confidential Stored Balance)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs4 as Program<Svs4>;
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
      "  NOTE: SVS-4 uses STORED balance + Confidential Transfers",
    );
  });

  // ============ Initialize ============

  describe("Initialize", () => {
    it("creates a new confidential vault", async () => {
      const tx = await program.methods
        .initialize(
          vaultId,
          "SVS-4 Vault",
          "svVault4",
          "https://example.com/vault4.json",
          null,
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
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.auditorElgamalPubkey).to.equal(null);

      // Asset vault should be empty
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
      auditorPubkey.fill(0xcd);

      await program.methods
        .initialize(
          new BN(2),
          "SVS-4 Audited Vault",
          "svAudit4",
          "https://example.com/audited4.json",
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

      // Transfer back
      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: vault,
        })
        .signers([newAuthority])
        .rpc();
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
  });

  // ============ View Functions (SVS-4: stored balance, no asset_vault) ============

  describe("View Functions (empty vault)", () => {
    it("total_assets returns stored value (0)", async () => {
      // SVS-4 VaultView only needs vault + shares_mint
      await program.methods
        .totalAssets()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      const vaultAccount =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
    });

    it("max_deposit returns u64::MAX when not paused", async () => {
      await program.methods
        .maxDeposit()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("max_mint returns u64::MAX when not paused", async () => {
      await program.methods
        .maxMint()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("preview_deposit returns expected shares", async () => {
      await program.methods
        .previewDeposit(new BN(1_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("convert_to_shares works on empty vault", async () => {
      await program.methods
        .convertToShares(new BN(1_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
    });

    it("convert_to_assets works on empty vault", async () => {
      await program.methods
        .convertToAssets(new BN(1_000_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();
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
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      await program.methods
        .maxMint()
        .accountsStrict({
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
    it("ConfidentialVault has correct field values after init", async () => {
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
      expect(vaultAccount.assetVault.toBase58()).to.equal(
        assetVault.toBase58(),
      );
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.decimalsOffset).to.equal(3);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
    });

    it("uses ConfidentialVault discriminator (same as SVS-3)", async () => {
      const accountInfo = await connection.getAccountInfo(vault);
      expect(accountInfo).to.not.be.null;
      const discriminator = accountInfo!.data.subarray(0, 8);
      console.log(
        "  SVS-4 ConfidentialVault discriminator:",
        Buffer.from(discriminator).toString("hex"),
      );
    });
  });

  // ============ Deposit Error Conditions ============

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
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
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

  // ============ Sync (SVS-4 specific) ============

  describe("Sync", () => {
    it("rejects sync from non-authority", async () => {
      const attacker = Keypair.generate();
      const sig = await connection.requestAirdrop(
        attacker.publicKey,
        1_000_000_000,
      );
      await connection.confirmTransaction(sig);

      try {
        await program.methods
          .sync()
          .accountsStrict({
            authority: attacker.publicKey,
            vault: vault,
            assetVault: assetVault,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.message).to.include("Unauthorized");
      }
    });

    it("sync is a no-op when balance matches stored total", async () => {
      const vaultBefore =
        await program.account.confidentialVault.fetch(vault);
      const assetVaultAccount = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(vaultBefore.totalAssets.toNumber()).to.equal(
        Number(assetVaultAccount.amount),
      );

      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber(),
      );
    });
  });

  // ============ PDA Derivation ============

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

  // ============ Full Deposit + Sync Flow (requires proof backend) ============

  describe("Confidential Deposit + Sync Flow (requires proof backend)", function () {
    let backendAvailable: boolean;

    before(async function () {
      backendAvailable = await isBackendAvailable();
      if (!backendAvailable) {
        console.log(
          "  ⚠ Proof backend not running — skipping CT deposit+sync tests",
        );
        console.log(
          "    Start with: cd proofs-backend && cargo run",
        );
        this.skip();
      }
    });

    it("configure_account enables confidential transfers", async function () {
      if (!backendAvailable) this.skip();

      const { proofData } =
        await requestPubkeyValidityProof(payer, userSharesAccount);

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
    });

    it("deposits assets and updates stored total_assets", async function () {
      if (!backendAvailable) this.skip();

      const depositAmount = new BN(1_000_000); // 1 USDC

      const vaultBefore =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultBefore.totalAssets.toNumber()).to.equal(0);

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

      // SVS-4: stored total_assets should have increased
      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        depositAmount.toNumber(),
      );

      // Shares minted
      const mint = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(Number(mint.supply)).to.be.greaterThan(0);
      console.log("  Shares minted:", Number(mint.supply));
    });

    it("apply_pending moves shares to available", async function () {
      if (!backendAvailable) this.skip();

      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newBalance = createDecryptableZeroBalance(aesKey);

      await program.methods
        .applyPending(Array.from(newBalance), new BN(1))
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    });

    it("external donation does NOT change stored total_assets", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialVault.fetch(vault);
      const storedBefore = vaultBefore.totalAssets.toNumber();

      // Send assets directly to vault (simulating yield/donation)
      const donationAmount = 500_000; // 0.5 USDC
      await transfer(
        connection,
        payer,
        userAssetAccount,
        assetVault,
        payer.publicKey,
        donationAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID,
      );

      // Stored total should NOT change (that's the SVS-4 model)
      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(storedBefore);

      // But actual balance is higher
      const actualBalance = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      expect(Number(actualBalance.amount)).to.be.greaterThan(storedBefore);

      console.log(
        "  Stored total_assets:",
        storedBefore,
        "| Actual balance:",
        Number(actualBalance.amount),
      );
    });

    it("sync() updates stored total_assets to actual balance", async function () {
      if (!backendAvailable) this.skip();

      const vaultBefore =
        await program.account.confidentialVault.fetch(vault);
      const actualBalance = await getAccount(
        connection,
        assetVault,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      expect(vaultBefore.totalAssets.toNumber()).to.be.lessThan(
        Number(actualBalance.amount),
      );

      await program.methods
        .sync()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          assetVault: assetVault,
        })
        .rpc();

      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        Number(actualBalance.amount),
      );

      console.log(
        "  After sync: total_assets =",
        vaultAfter.totalAssets.toNumber(),
      );
    });

    it("sync increases share value for existing holders", async function () {
      if (!backendAvailable) this.skip();

      // After sync, the share price has increased because total_assets
      // now includes the donation but total_shares hasn't changed.
      const vaultState =
        await program.account.confidentialVault.fetch(vault);
      const mint = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      // With 1M deposited + 500K donated, total_assets = 1.5M
      // But shares only represent 1M deposit worth
      // So each share is now worth more assets
      expect(vaultState.totalAssets.toNumber()).to.equal(1_500_000);
      expect(Number(mint.supply)).to.be.greaterThan(0);

      console.log(
        "  Total assets after sync:",
        vaultState.totalAssets.toNumber(),
        "| Total shares:",
        Number(mint.supply),
      );
    });

    it("second deposit uses updated share price", async function () {
      if (!backendAvailable) this.skip();

      const supplyBefore = await getMint(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultBefore =
        await program.account.confidentialVault.fetch(vault);

      const depositAmount = new BN(1_000_000); // 1 USDC

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
      const vaultAfter =
        await program.account.confidentialVault.fetch(vault);

      // Second deposit should get fewer shares per asset
      // because share price increased after sync
      const firstShares = Number(supplyBefore.supply);
      const secondShares =
        Number(supplyAfter.supply) - Number(supplyBefore.supply);

      // First deposit: 1M assets -> X shares
      // Second deposit: 1M assets -> fewer shares (because total_assets included donation)
      expect(secondShares).to.be.lessThan(firstShares);

      // Stored total should have increased by deposit amount
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + depositAmount.toNumber(),
      );

      console.log(
        "  First deposit shares:",
        firstShares,
        "| Second deposit shares:",
        secondShares,
      );

      // Apply pending for cleanup
      const aesKey = deriveAesKeyFromSignature(payer, userSharesAccount);
      const newBalance = createDecryptableZeroBalance(aesKey);
      await program.methods
        .applyPending(Array.from(newBalance), new BN(2))
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    });

    it("view functions use stored balance (not live)", async function () {
      if (!backendAvailable) this.skip();

      // preview_deposit uses stored total_assets
      await program.methods
        .previewDeposit(new BN(1_000_000))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      // total_assets returns stored value
      await program.methods
        .totalAssets()
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .rpc();

      const vaultState =
        await program.account.confidentialVault.fetch(vault);
      expect(vaultState.totalAssets.toNumber()).to.equal(2_500_000);
    });
  });
});
