/**
 * Module Integration Tests
 *
 * Tests for the on-chain module system (fees, caps, locks, access).
 *
 * NOTE: These tests require the program to be built with the "modules" feature:
 *   anchor build -- --features modules
 *
 * Current status:
 * - Module admin instructions (init/update configs): IMPLEMENTED & TESTED
 * - Module integration with deposit/withdraw: HOOKS EXIST, NOT YET WIRED
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("SVS-1 Modules (Feature: modules)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test state
  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  const vaultId = new BN(99); // Use different vault ID to avoid conflicts
  const ASSET_DECIMALS = 6;

  // Module config PDAs
  let feeConfig: PublicKey;
  let capConfig: PublicKey;
  let lockConfig: PublicKey;
  let accessConfig: PublicKey;

  // Fee recipient
  const feeRecipient = Keypair.generate();

  // PDA derivation helpers
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

  const getFeeConfigPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("fee_config"), vault.toBuffer()],
      program.programId
    );
  };

  const getCapConfigPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("cap_config"), vault.toBuffer()],
      program.programId
    );
  };

  const getLockConfigPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lock_config"), vault.toBuffer()],
      program.programId
    );
  };

  const getAccessConfigPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("access_config"), vault.toBuffer()],
      program.programId
    );
  };

  // Check if modules feature is available
  const checkModulesFeature = (): boolean => {
    try {
      // Check if initializeFeeConfig instruction exists (IDL uses snake_case)
      const idl = program.idl;
      return idl.instructions.some((ix: { name: string }) =>
        ix.name === "initializeFeeConfig" || ix.name === "initialize_fee_config"
      );
    } catch {
      return false;
    }
  };

  before(async () => {
    // Skip if modules feature not available
    if (!checkModulesFeature()) {
      console.log("⚠️  Modules feature not available. Rebuild with: anchor build -- --features modules");
      return;
    }

    // Create asset mint
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
    [feeConfig] = getFeeConfigPDA(vault);
    [capConfig] = getCapConfigPDA(vault);
    [lockConfig] = getLockConfigPDA(vault);
    [accessConfig] = getAccessConfigPDA(vault);

    // Derive asset vault ATA
    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    console.log("Module Test Setup:");
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  FeeConfig PDA:", feeConfig.toBase58());
    console.log("  CapConfig PDA:", capConfig.toBase58());
    console.log("  LockConfig PDA:", lockConfig.toBase58());
    console.log("  AccessConfig PDA:", accessConfig.toBase58());

    // Initialize vault first
    await program.methods
      .initialize(vaultId, "Module Test Vault", "MTV", "https://example.com")
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

    console.log("  Vault initialized for module tests");
  });

  describe("Fee Module", function () {
    before(function () {
      if (!checkModulesFeature()) {
        this.skip();
      }
    });

    it("initializes fee config", async () => {
      const entryFeeBps = 50; // 0.5%
      const exitFeeBps = 100; // 1%
      const managementFeeBps = 200; // 2%
      const performanceFeeBps = 2000; // 20%

      const tx = await program.methods
        .initializeFeeConfig(entryFeeBps, exitFeeBps, managementFeeBps, performanceFeeBps)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          feeConfig: feeConfig,
          feeRecipient: feeRecipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Initialize fee config tx:", tx);

      const config = await program.account.feeConfig.fetch(feeConfig);
      expect(config.vault.toBase58()).to.equal(vault.toBase58());
      expect(config.feeRecipient.toBase58()).to.equal(feeRecipient.publicKey.toBase58());
      expect(config.entryFeeBps).to.equal(entryFeeBps);
      expect(config.exitFeeBps).to.equal(exitFeeBps);
      expect(config.managementFeeBps).to.equal(managementFeeBps);
      expect(config.performanceFeeBps).to.equal(performanceFeeBps);
    });

    it("updates fee config", async () => {
      const newEntryFeeBps = 25; // 0.25%

      await program.methods
        .updateFeeConfig(newEntryFeeBps, null, null, null)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          feeConfig: feeConfig,
        })
        .rpc();

      const config = await program.account.feeConfig.fetch(feeConfig);
      expect(config.entryFeeBps).to.equal(newEntryFeeBps);
      // Other values unchanged
      expect(config.exitFeeBps).to.equal(100);
      expect(config.managementFeeBps).to.equal(200);
      expect(config.performanceFeeBps).to.equal(2000);
    });

    it("rejects invalid entry fee (>10%)", async () => {
      try {
        await program.methods
          .updateFeeConfig(1100, null, null, null) // 11% - exceeds max
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
            feeConfig: feeConfig,
          })
          .rpc();
        expect.fail("Should have rejected invalid fee");
      } catch (err) {
        expect(err.message).to.include("EntryFeeExceedsMax");
      }
    });

    it("rejects non-authority", async () => {
      const nonAuthority = Keypair.generate();

      // Airdrop some SOL to non-authority
      const sig = await connection.requestAirdrop(nonAuthority.publicKey, 1e9);
      await connection.confirmTransaction(sig);

      try {
        await program.methods
          .updateFeeConfig(10, null, null, null)
          .accountsStrict({
            authority: nonAuthority.publicKey,
            vault: vault,
            feeConfig: feeConfig,
          })
          .signers([nonAuthority])
          .rpc();
        expect.fail("Should have rejected non-authority");
      } catch (err) {
        expect(err.message).to.include("Unauthorized");
      }
    });
  });

  describe("Cap Module", function () {
    before(function () {
      if (!checkModulesFeature()) {
        this.skip();
      }
    });

    it("initializes cap config", async () => {
      const globalCap = new BN(1_000_000 * 10 ** ASSET_DECIMALS); // 1M
      const perUserCap = new BN(100_000 * 10 ** ASSET_DECIMALS); // 100K

      const tx = await program.methods
        .initializeCapConfig(globalCap, perUserCap)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          capConfig: capConfig,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Initialize cap config tx:", tx);

      const config = await program.account.capConfig.fetch(capConfig);
      expect(config.vault.toBase58()).to.equal(vault.toBase58());
      expect(config.globalCap.toString()).to.equal(globalCap.toString());
      expect(config.perUserCap.toString()).to.equal(perUserCap.toString());
    });

    it("updates cap config", async () => {
      const newGlobalCap = new BN(2_000_000 * 10 ** ASSET_DECIMALS); // 2M

      await program.methods
        .updateCapConfig(newGlobalCap, null)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          capConfig: capConfig,
        })
        .rpc();

      const config = await program.account.capConfig.fetch(capConfig);
      expect(config.globalCap.toString()).to.equal(newGlobalCap.toString());
      // Per-user cap unchanged
      expect(config.perUserCap.toString()).to.equal(
        new BN(100_000 * 10 ** ASSET_DECIMALS).toString()
      );
    });

    it("allows zero cap (unlimited)", async () => {
      await program.methods
        .updateCapConfig(new BN(0), new BN(0)) // Unlimited
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          capConfig: capConfig,
        })
        .rpc();

      const config = await program.account.capConfig.fetch(capConfig);
      expect(config.globalCap.toString()).to.equal("0");
      expect(config.perUserCap.toString()).to.equal("0");
    });
  });

  describe("Lock Module", function () {
    before(function () {
      if (!checkModulesFeature()) {
        this.skip();
      }
    });

    it("initializes lock config", async () => {
      const lockDuration = new BN(86400); // 1 day in seconds

      const tx = await program.methods
        .initializeLockConfig(lockDuration)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          lockConfig: lockConfig,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Initialize lock config tx:", tx);

      const config = await program.account.lockConfig.fetch(lockConfig);
      expect(config.vault.toBase58()).to.equal(vault.toBase58());
      expect(config.lockDuration.toString()).to.equal(lockDuration.toString());
    });

    it("updates lock config", async () => {
      const newLockDuration = new BN(7 * 86400); // 7 days

      await program.methods
        .updateLockConfig(newLockDuration)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          lockConfig: lockConfig,
        })
        .rpc();

      const config = await program.account.lockConfig.fetch(lockConfig);
      expect(config.lockDuration.toString()).to.equal(newLockDuration.toString());
    });

    it("rejects lock duration exceeding 1 year", async () => {
      const tooLong = new BN(366 * 86400); // > 1 year

      try {
        await program.methods
          .updateLockConfig(tooLong)
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
            lockConfig: lockConfig,
          })
          .rpc();
        expect.fail("Should have rejected excessive lock duration");
      } catch (err) {
        expect(err.message).to.include("LockDurationExceedsMax");
      }
    });
  });

  describe("Access Module", function () {
    before(function () {
      if (!checkModulesFeature()) {
        this.skip();
      }
    });

    it("initializes access config (open mode)", async () => {
      const mode = { open: {} }; // AccessMode::Open
      const merkleRoot = new Array(32).fill(0); // Empty root for open mode

      const tx = await program.methods
        .initializeAccessConfig(mode, merkleRoot)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          accessConfig: accessConfig,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Initialize access config tx:", tx);

      const config = await program.account.accessConfig.fetch(accessConfig);
      expect(config.vault.toBase58()).to.equal(vault.toBase58());
      expect(config.mode).to.deep.equal({ open: {} });
    });

    it("updates to whitelist mode with merkle root", async () => {
      // Create a simple merkle root (32 bytes) - in production this would be computed from addresses
      const merkleRoot = Array.from(
        Buffer.from("a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd", "hex")
      );

      await program.methods
        .updateAccessConfig({ whitelist: {} }, merkleRoot)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          accessConfig: accessConfig,
        })
        .rpc();

      const config = await program.account.accessConfig.fetch(accessConfig);
      expect(config.mode).to.deep.equal({ whitelist: {} });
      expect(Array.from(config.merkleRoot)).to.deep.equal(merkleRoot);
    });

    it("updates to blacklist mode", async () => {
      await program.methods
        .updateAccessConfig({ blacklist: {} }, null)
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          accessConfig: accessConfig,
        })
        .rpc();

      const config = await program.account.accessConfig.fetch(accessConfig);
      expect(config.mode).to.deep.equal({ blacklist: {} });
    });

    it("resets to open mode", async () => {
      await program.methods
        .updateAccessConfig({ open: {} }, new Array(32).fill(0))
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
          accessConfig: accessConfig,
        })
        .rpc();

      const config = await program.account.accessConfig.fetch(accessConfig);
      expect(config.mode).to.deep.equal({ open: {} });
    });
  });

  describe("Module State Validation", function () {
    before(function () {
      if (!checkModulesFeature()) {
        this.skip();
      }
    });

    it("all module configs have correct vault reference", async () => {
      const feeConfigData = await program.account.feeConfig.fetch(feeConfig);
      const capConfigData = await program.account.capConfig.fetch(capConfig);
      const lockConfigData = await program.account.lockConfig.fetch(lockConfig);
      const accessConfigData = await program.account.accessConfig.fetch(accessConfig);

      expect(feeConfigData.vault.toBase58()).to.equal(vault.toBase58());
      expect(capConfigData.vault.toBase58()).to.equal(vault.toBase58());
      expect(lockConfigData.vault.toBase58()).to.equal(vault.toBase58());
      expect(accessConfigData.vault.toBase58()).to.equal(vault.toBase58());
    });

    it("all module configs have valid bumps stored", async () => {
      const feeConfigData = await program.account.feeConfig.fetch(feeConfig);
      const capConfigData = await program.account.capConfig.fetch(capConfig);
      const lockConfigData = await program.account.lockConfig.fetch(lockConfig);
      const accessConfigData = await program.account.accessConfig.fetch(accessConfig);

      // Verify bumps by re-deriving PDAs
      const [, feeExpectedBump] = getFeeConfigPDA(vault);
      const [, capExpectedBump] = getCapConfigPDA(vault);
      const [, lockExpectedBump] = getLockConfigPDA(vault);
      const [, accessExpectedBump] = getAccessConfigPDA(vault);

      expect(feeConfigData.bump).to.equal(feeExpectedBump);
      expect(capConfigData.bump).to.equal(capExpectedBump);
      expect(lockConfigData.bump).to.equal(lockExpectedBump);
      expect(accessConfigData.bump).to.equal(accessExpectedBump);
    });
  });
});

/**
 * NOTE: Integration tests for module enforcement in deposit/withdraw
 *
 * The module hooks (check_deposit_access, check_deposit_caps, apply_entry_fee, etc.)
 * exist in module_hooks.rs but are not yet wired into the deposit/withdraw handlers.
 *
 * TODO: Once deposit/withdraw accept remaining_accounts for modules:
 * - Test deposit blocked by access control
 * - Test deposit blocked by global cap
 * - Test deposit blocked by per-user cap
 * - Test deposit with entry fee applied
 * - Test redeem blocked by lock period
 * - Test redeem with exit fee applied
 */
