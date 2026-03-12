import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
import { Svs11 } from "../target/types/svs_11";
import { MockOracle } from "../target/types/mock_oracle";
import { MockAttestation } from "../target/types/mock_attestation";

// Oracle price scale: 1e9 = 1:1 NAV
const PRICE_SCALE = 1_000_000_000;

describe("svs-11 (Credit Markets Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const attestationProgram = anchor.workspace
    .MockAttestation as Program<MockAttestation>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const ASSET_DECIMALS = 6;
  const vaultId = new BN(1);
  const minimumInvestment = new BN(1_000_000); // 1 USDC
  const maxStaleness = new BN(3600); // 1 hour

  // Accounts
  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let depositVault: PublicKey;
  let redemptionEscrow: PublicKey;

  // Oracle + attestation
  let oracleKeypair: Keypair;
  let oracleAccount: PublicKey;
  let attestationKeypair: Keypair;
  let attestationAccount: PublicKey;

  // Manager (separate from authority for role separation)
  const manager = Keypair.generate();

  // Investor
  const investor = Keypair.generate();
  let investorAssetAccount: PublicKey;
  let investorSharesAccount: PublicKey;

  // Second investor for multi-user tests
  const investor2 = Keypair.generate();
  let investor2AssetAccount: PublicKey;
  let investor2SharesAccount: PublicKey;
  let attestation2Keypair: Keypair;
  let attestation2Account: PublicKey;

  // PDA helpers
  const getVaultPDA = (
    assetMint: PublicKey,
    vaultId: BN
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("credit_vault"),
        assetMint.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  };

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  };

  const getDepositVaultPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("deposit_vault"), vault.toBuffer()],
      program.programId
    );
  };

  const getRedemptionEscrowPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("redemption_escrow"), vault.toBuffer()],
      program.programId
    );
  };

  const getInvestmentRequestPDA = (
    vault: PublicKey,
    investor: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("investment_request"),
        vault.toBuffer(),
        investor.toBuffer(),
      ],
      program.programId
    );
  };

  const getRedemptionRequestPDA = (
    vault: PublicKey,
    investor: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("redemption_request"),
        vault.toBuffer(),
        investor.toBuffer(),
      ],
      program.programId
    );
  };

  const getClaimableEscrowPDA = (
    vault: PublicKey,
    investor: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claimable"), vault.toBuffer(), investor.toBuffer()],
      program.programId
    );
  };

  const getClaimableTokensPDA = (
    vault: PublicKey,
    investor: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claimable_tokens"), vault.toBuffer(), investor.toBuffer()],
      program.programId
    );
  };

  const getFrozenAccountPDA = (
    vault: PublicKey,
    investor: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), vault.toBuffer(), investor.toBuffer()],
      program.programId
    );
  };

  // Create an oracle account via mock-oracle program
  const createOracleAccount = async (
    vaultKey: PublicKey,
    price: number
  ): Promise<[Keypair, PublicKey]> => {
    const kp = Keypair.generate();
    await oracleProgram.methods
      .createOracle(vaultKey, new BN(price))
      .accounts({
        authority: payer.publicKey,
        oraclePrice: kp.publicKey,
      })
      .signers([kp])
      .rpc();
    return [kp, kp.publicKey];
  };

  // Create an attestation account via mock-attestation program
  const createAttestationAccount = async (
    subject: PublicKey,
    issuer: PublicKey,
    expiresAt: number = 0
  ): Promise<[Keypair, PublicKey]> => {
    const kp = Keypair.generate();
    await attestationProgram.methods
      .createAttestation(
        subject,
        issuer,
        1, // attestation_type: KYC
        [85, 83], // country_code: "US"
        new BN(expiresAt)
      )
      .accounts({
        authority: payer.publicKey,
        attestation: kp.publicKey,
      })
      .signers([kp])
      .rpc();
    return [kp, kp.publicKey];
  };

  // Update oracle price
  const updateOraclePrice = async (
    oracleKp: Keypair,
    newPrice: number
  ): Promise<void> => {
    await oracleProgram.methods
      .updateOracle(new BN(newPrice))
      .accounts({
        authority: payer.publicKey,
        oraclePrice: oracleKp.publicKey,
      })
      .rpc();
  };

  before(async () => {
    // Fund manager and investors
    const airdropPromises = [manager, investor, investor2].map((kp) =>
      connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const sigs = await Promise.all(airdropPromises);
    await Promise.all(
      sigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
    );

    // Create asset mint (USDC-like, SPL Token)
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

    // Derive PDAs
    [vault] = getVaultPDA(assetMint, vaultId);
    [sharesMint] = getSharesMintPDA(vault);
    [depositVault] = getDepositVaultPDA(vault);
    [redemptionEscrow] = getRedemptionEscrowPDA(vault);

    // Create oracle account (1:1 NAV)
    [oracleKeypair, oracleAccount] = await createOracleAccount(
      vault,
      PRICE_SCALE
    );

    // Create attestation for payer (authority) -- used in some tests
    // We'll create per-investor attestations in test sections

    // Create investor asset accounts and fund them
    const investorAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      investor.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    investorAssetAccount = investorAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      investorAssetAccount,
      payer.publicKey,
      10_000_000 * 10 ** ASSET_DECIMALS, // 10M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Investor 2
    const investor2AssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      investor2.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    investor2AssetAccount = investor2AssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      investor2AssetAccount,
      payer.publicKey,
      5_000_000 * 10 ** ASSET_DECIMALS, // 5M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Manager asset account (for repay)
    const managerAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      manager.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    await mintTo(
      connection,
      payer,
      assetMint,
      managerAssetAta.address,
      payer.publicKey,
      10_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Oracle Program:", oracleProgram.programId.toBase58());
    console.log(
      "  Attestation Program:",
      attestationProgram.programId.toBase58()
    );
    console.log("  Asset Mint:", assetMint.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Manager:", manager.publicKey.toBase58());
    console.log("  Investor:", investor.publicKey.toBase58());
  });

  // =========================================================================
  // Initialize
  // =========================================================================
  describe("Initialize", () => {
    it("creates a credit vault", async () => {
      const tx = await program.methods
        .initializePool(vaultId, minimumInvestment, maxStaleness)
        .accountsStrict({
          authority: payer.publicKey,
          manager: manager.publicKey,
          vault,
          assetMint,
          navOracle: oracleAccount,
          oracleProgram: oracleProgram.programId,
          attester: payer.publicKey, // payer is the attester initially
          attestationProgram: attestationProgram.programId,
          sharesMint,
          depositVault,
          redemptionEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("  Initialize tx:", tx);

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
      expect(vaultAccount.manager.toBase58()).to.equal(
        manager.publicKey.toBase58()
      );
      expect(vaultAccount.assetMint.toBase58()).to.equal(
        assetMint.toBase58()
      );
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58()
      );
      expect(vaultAccount.depositVault.toBase58()).to.equal(
        depositVault.toBase58()
      );
      expect(vaultAccount.redemptionEscrow.toBase58()).to.equal(
        redemptionEscrow.toBase58()
      );
      expect(vaultAccount.navOracle.toBase58()).to.equal(
        oracleAccount.toBase58()
      );
      expect(vaultAccount.oracleProgram.toBase58()).to.equal(
        oracleProgram.programId.toBase58()
      );
      expect(vaultAccount.attester.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
      expect(vaultAccount.attestationProgram.toBase58()).to.equal(
        attestationProgram.programId.toBase58()
      );
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.minimumInvestment.toNumber()).to.equal(
        minimumInvestment.toNumber()
      );
      expect(vaultAccount.investmentWindowOpen).to.equal(false);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());
      expect(vaultAccount.maxStaleness.toNumber()).to.equal(
        maxStaleness.toNumber()
      );
    });

    it("rejects duplicate vault initialization", async () => {
      try {
        await program.methods
          .initializePool(vaultId, minimumInvestment, maxStaleness)
          .accountsStrict({
            authority: payer.publicKey,
            manager: manager.publicKey,
            vault,
            assetMint,
            navOracle: oracleAccount,
            oracleProgram: oracleProgram.programId,
            attester: payer.publicKey,
            attestationProgram: attestationProgram.programId,
            sharesMint,
            depositVault,
            redemptionEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // PDA already initialized
        expect(err.message).to.include("already in use");
      }
    });

    it("rejects zero-address manager", async () => {
      const badVaultId = new BN(999);
      const [badVault] = getVaultPDA(assetMint, badVaultId);
      const [badSharesMint] = getSharesMintPDA(badVault);
      const [badDepositVault] = getDepositVaultPDA(badVault);
      const [badRedemptionEscrow] = getRedemptionEscrowPDA(badVault);

      try {
        await program.methods
          .initializePool(badVaultId, minimumInvestment, maxStaleness)
          .accountsStrict({
            authority: payer.publicKey,
            manager: PublicKey.default,
            vault: badVault,
            assetMint,
            navOracle: oracleAccount,
            oracleProgram: oracleProgram.programId,
            attester: payer.publicKey,
            attestationProgram: attestationProgram.programId,
            sharesMint: badSharesMint,
            depositVault: badDepositVault,
            redemptionEscrow: badRedemptionEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidManager");
      }
    });

    it("rejects negative max staleness", async () => {
      const badVaultId = new BN(998);
      const [badVault] = getVaultPDA(assetMint, badVaultId);
      const [badSharesMint] = getSharesMintPDA(badVault);
      const [badDepositVault] = getDepositVaultPDA(badVault);
      const [badRedemptionEscrow] = getRedemptionEscrowPDA(badVault);

      try {
        await program.methods
          .initializePool(badVaultId, minimumInvestment, new BN(-1))
          .accountsStrict({
            authority: payer.publicKey,
            manager: manager.publicKey,
            vault: badVault,
            assetMint,
            navOracle: oracleAccount,
            oracleProgram: oracleProgram.programId,
            attester: payer.publicKey,
            attestationProgram: attestationProgram.programId,
            sharesMint: badSharesMint,
            depositVault: badDepositVault,
            redemptionEscrow: badRedemptionEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidMaxStaleness");
      }
    });
  });

  // =========================================================================
  // Investment Window
  // =========================================================================
  describe("Investment Window", () => {
    it("manager opens investment window", async () => {
      await program.methods
        .openInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.investmentWindowOpen).to.equal(true);
    });

    it("non-manager cannot open window", async () => {
      // Close first so we can test re-opening
      await program.methods
        .closeInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();

      try {
        await program.methods
          .openInvestmentWindow()
          .accountsStrict({
            manager: investor.publicKey,
            vault,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("manager closes investment window", async () => {
      // Re-open first
      await program.methods
        .openInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();

      await program.methods
        .closeInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.investmentWindowOpen).to.equal(false);
    });

    it("cannot open window when paused", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      try {
        await program.methods
          .openInvestmentWindow()
          .accountsStrict({
            manager: manager.publicKey,
            vault,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }

      // Unpause for subsequent tests
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });
  });

  // =========================================================================
  // Deposit Flow
  // =========================================================================
  describe("Deposit Flow", () => {
    let investorAttestationKeypair: Keypair;
    let investorAttestationAccount: PublicKey;

    before(async () => {
      // Create attestation for investor (payer is attester)
      [investorAttestationKeypair, investorAttestationAccount] =
        await createAttestationAccount(investor.publicKey, payer.publicKey, 0);

      // Create investor shares account (Token-2022 ATA)
      investorSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        investor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Create the ATA
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          investorSharesAccount,
          investor.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      const tx = new Transaction().add(ataIx);
      await sendAndConfirmTransaction(connection, tx, [payer]);

      // Open investment window
      await program.methods
        .openInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();
    });

    it("investor requests deposit", async () => {
      const amount = new BN(100_000 * 10 ** ASSET_DECIMALS); // 100K USDC
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      const beforeBalance = await getAccount(connection, investorAssetAccount);

      await program.methods
        .requestDeposit(amount)
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: investorAttestationAccount,
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([investor])
        .rpc();

      const afterBalance = await getAccount(connection, investorAssetAccount);
      expect(
        Number(beforeBalance.amount) - Number(afterBalance.amount)
      ).to.equal(amount.toNumber());

      const request = await program.account.investmentRequest.fetch(
        investmentRequest
      );
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(request.vault.toBase58()).to.equal(vault.toBase58());
      expect(request.amountLocked.toNumber()).to.equal(amount.toNumber());
      expect(request.sharesToReceive.toNumber()).to.equal(0);
      // status: Pending = { pending: {} }
      expect(JSON.stringify(request.status)).to.include("pending");
    });

    it("rejects deposit below minimum investment", async () => {
      // Need a fresh investor for a fresh PDA
      const tinyInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tinyInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tinyAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tinyInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tinyAta.address,
        payer.publicKey,
        500_000, // 0.5 USDC (below minimum)
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [, tinyAttestation] = await createAttestationAccount(
        tinyInvestor.publicKey,
        payer.publicKey,
        0
      );

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tinyInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tinyInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(500_000))
          .accountsStrict({
            investor: tinyInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tinyAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: tinyAttestation,
              isSigner: false,
              isWritable: false,
            },
          ])
          .signers([tinyInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("BelowMinimumInvestment");
      }
    });

    it("rejects deposit with zero amount", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(0))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("rejects deposit when window is closed", async () => {
      // Close window
      await program.methods
        .closeInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();

      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        10_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvestmentWindowClosed");
      }

      // Re-open for subsequent tests
      await program.methods
        .openInvestmentWindow()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
        })
        .signers([manager])
        .rpc();
    });

    it("rejects deposit without attestation", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        10_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          // No remaining accounts = no attestation
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AttestationNotFound");
      }
    });

    it("manager approves deposit and investor receives shares", async () => {
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      const vaultBefore = await program.account.creditVault.fetch(vault);

      await program.methods
        .approveDeposit()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: investor.publicKey,
          sharesMint,
          investorSharesAccount,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: investorAttestationAccount,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: oracleAccount, isSigner: false, isWritable: false },
        ])
        .signers([manager])
        .rpc();

      // Verify shares minted
      const sharesBalance = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(sharesBalance.amount)).to.be.greaterThan(0);

      // Verify vault totals updated
      const vaultAfter = await program.account.creditVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.be.greaterThan(
        vaultBefore.totalAssets.toNumber()
      );
      expect(vaultAfter.totalShares.toNumber()).to.be.greaterThan(
        vaultBefore.totalShares.toNumber()
      );

      // Investment request should be closed (rent returned)
      try {
        await program.account.investmentRequest.fetch(investmentRequest);
        expect.fail("should have thrown - account closed");
      } catch {
        // Expected: account closed
      }

      console.log(
        "  Shares minted:",
        Number(sharesBalance.amount) / 1e9,
        "shares"
      );
      console.log(
        "  Total assets:",
        vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS
      );
    });

    it("non-manager cannot approve deposit", async () => {
      // Create new deposit request first
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        10_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Try to approve as investor (not manager)
      const tmpSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        tmpInvestor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          tmpSharesAccount,
          tmpInvestor.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ataIx),
        [payer]
      );

      try {
        await program.methods
          .approveDeposit()
          .accountsStrict({
            manager: investor.publicKey, // wrong manager
            vault,
            investmentRequest,
            investor: tmpInvestor.publicKey,
            sharesMint,
            investorSharesAccount: tmpSharesAccount,
            frozenAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
            { pubkey: oracleAccount, isSigner: false, isWritable: false },
          ])
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      // Clean up: cancel the request
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();
    });
  });

  // =========================================================================
  // Reject Deposit
  // =========================================================================
  describe("Reject Deposit", () => {
    it("manager rejects deposit and returns assets", async () => {
      // Create a fresh deposit
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const depositAmount = 10_000_000;
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        depositAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(depositAmount))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Verify assets moved to deposit vault
      const ataAfterDeposit = await getAccount(connection, tmpAta.address);
      expect(Number(ataAfterDeposit.amount)).to.equal(0);

      // Manager rejects
      await program.methods
        .rejectDeposit(1) // reason_code = 1
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: tmpInvestor.publicKey,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      // Assets returned
      const ataAfterReject = await getAccount(connection, tmpAta.address);
      expect(Number(ataAfterReject.amount)).to.equal(depositAmount);

      // Request closed
      try {
        await program.account.investmentRequest.fetch(investmentRequest);
        expect.fail("should have thrown");
      } catch {
        // Expected
      }
    });
  });

  // =========================================================================
  // Cancel Deposit
  // =========================================================================
  describe("Cancel Deposit", () => {
    it("investor cancels pending deposit and gets assets back", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const depositAmount = 5_000_000;
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        depositAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(depositAmount))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Cancel
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();

      const ataAfter = await getAccount(connection, tmpAta.address);
      expect(Number(ataAfter.amount)).to.equal(depositAmount);
    });

    it("non-investor cannot cancel another investor's deposit", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Another investor tries to cancel
      try {
        await program.methods
          .cancelDeposit()
          .accountsStrict({
            investor: investor.publicKey, // wrong investor
            vault,
            investmentRequest,
            assetMint,
            depositVault,
            investorAssetAccount: tmpAta.address,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // PDA seeds mismatch or constraint failure
        expect(err.toString()).to.not.be.empty;
      }

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();
    });
  });

  // =========================================================================
  // Redemption Flow
  // =========================================================================
  describe("Redemption Flow", () => {
    let investorAttestationKeypair: Keypair;
    let investorAttestationAccount: PublicKey;

    before(async () => {
      // Create fresh attestation for redemption tests
      [investorAttestationKeypair, investorAttestationAccount] =
        await createAttestationAccount(investor.publicKey, payer.publicKey, 0);
    });

    it("investor requests redemption", async () => {
      // Get current shares balance
      const sharesBalance = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const sharesToRedeem = Number(sharesBalance.amount) / 2; // Redeem half

      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      await program.methods
        .requestRedeem(new BN(sharesToRedeem))
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount,
          redemptionEscrow,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: investorAttestationAccount,
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([investor])
        .rpc();

      const request = await program.account.redemptionRequest.fetch(
        redemptionRequest
      );
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(request.sharesLocked.toNumber()).to.equal(sharesToRedeem);
      expect(request.amountClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(request.status)).to.include("pending");

      // Shares should be in escrow
      const escrowBalance = await getAccount(
        connection,
        redemptionEscrow,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(escrowBalance.amount)).to.equal(sharesToRedeem);
    });

    it("rejects redemption with zero shares", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        tmpInvestor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          tmpSharesAccount,
          tmpInvestor.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ataIx),
        [payer]
      );

      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestRedeem(new BN(0))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            redemptionRequest,
            sharesMint,
            investorSharesAccount: tmpSharesAccount,
            redemptionEscrow,
            frozenAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("manager approves redemption", async () => {
      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        investor.publicKey
      );
      const [claimableEscrow] = getClaimableEscrowPDA(
        vault,
        investor.publicKey
      );
      const [claimableTokens] = getClaimableTokensPDA(
        vault,
        investor.publicKey
      );

      const vaultBefore = await program.account.creditVault.fetch(vault);

      await program.methods
        .approveRedeem()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          redemptionEscrow,
          assetMint,
          depositVault,
          claimableTokens,
          claimableEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: oracleAccount, isSigner: false, isWritable: false },
        ])
        .signers([manager])
        .rpc();

      // Vault totals should decrease
      const vaultAfter = await program.account.creditVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.be.lessThan(
        vaultBefore.totalShares.toNumber()
      );

      // Claimable escrow should have amount
      const escrow = await program.account.claimableEscrow.fetch(
        claimableEscrow
      );
      expect(escrow.amountClaimable.toNumber()).to.be.greaterThan(0);
      expect(escrow.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );

      // Redemption request should be approved
      const request = await program.account.redemptionRequest.fetch(
        redemptionRequest
      );
      expect(JSON.stringify(request.status)).to.include("approved");
      expect(request.amountClaimable.toNumber()).to.be.greaterThan(0);

      console.log(
        "  Claimable amount:",
        escrow.amountClaimable.toNumber() / 10 ** ASSET_DECIMALS,
        "assets"
      );
    });

    it("investor claims redemption", async () => {
      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        investor.publicKey
      );
      const [claimableEscrow] = getClaimableEscrowPDA(
        vault,
        investor.publicKey
      );
      const [claimableTokens] = getClaimableTokensPDA(
        vault,
        investor.publicKey
      );

      const beforeBalance = await getAccount(connection, investorAssetAccount);

      await program.methods
        .claimRedemption()
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          claimableEscrow,
          assetMint,
          claimableTokens,
          investorAssetAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();

      const afterBalance = await getAccount(connection, investorAssetAccount);
      const received =
        Number(afterBalance.amount) - Number(beforeBalance.amount);
      expect(received).to.be.greaterThan(0);

      // Redemption request and claimable escrow should be closed
      try {
        await program.account.redemptionRequest.fetch(redemptionRequest);
        expect.fail("should have thrown");
      } catch {
        // Expected
      }

      try {
        await program.account.claimableEscrow.fetch(claimableEscrow);
        expect.fail("should have thrown");
      } catch {
        // Expected
      }

      console.log("  Claimed:", received / 10 ** ASSET_DECIMALS, "assets");
    });
  });

  // =========================================================================
  // Cancel Redeem
  // =========================================================================
  describe("Cancel Redeem", () => {
    it("investor cancels pending redemption and gets shares back", async () => {
      // Need a fresh attestation for the new redemption request
      const [, tmpAtt] = await createAttestationAccount(
        investor.publicKey,
        payer.publicKey,
        0
      );

      // Get current shares
      const sharesBefore = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const sharesToRedeem = Math.floor(Number(sharesBefore.amount) / 4);

      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      // Request
      await program.methods
        .requestRedeem(new BN(sharesToRedeem))
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount,
          redemptionEscrow,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([investor])
        .rpc();

      // Cancel
      await program.methods
        .cancelRedeem()
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          redemptionEscrow,
          investorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();

      // Shares should be restored
      const sharesAfter = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(sharesAfter.amount)).to.equal(
        Number(sharesBefore.amount)
      );

      // Request should be closed
      try {
        await program.account.redemptionRequest.fetch(redemptionRequest);
        expect.fail("should have thrown");
      } catch {
        // Expected
      }
    });
  });

  // =========================================================================
  // Repayment
  // =========================================================================
  describe("Repayment", () => {
    it("manager repays assets to vault", async () => {
      const managerAssetAccount = getAssociatedTokenAddressSync(
        assetMint,
        manager.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const vaultBefore = await program.account.creditVault.fetch(vault);
      const repayAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .repay(repayAmount)
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          assetMint,
          managerAssetAccount,
          depositVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      const vaultAfter = await program.account.creditVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + repayAmount.toNumber()
      );

      console.log(
        "  Repaid:",
        repayAmount.toNumber() / 10 ** ASSET_DECIMALS,
        "assets"
      );
      console.log(
        "  New total assets:",
        vaultAfter.totalAssets.toNumber() / 10 ** ASSET_DECIMALS
      );
    });

    it("rejects repayment with zero amount", async () => {
      const managerAssetAccount = getAssociatedTokenAddressSync(
        assetMint,
        manager.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      try {
        await program.methods
          .repay(new BN(0))
          .accountsStrict({
            manager: manager.publicKey,
            vault,
            assetMint,
            managerAssetAccount,
            depositVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("non-manager cannot repay", async () => {
      try {
        await program.methods
          .repay(new BN(1_000_000))
          .accountsStrict({
            manager: investor.publicKey,
            vault,
            assetMint,
            managerAssetAccount: investorAssetAccount,
            depositVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("cannot repay when paused", async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const managerAssetAccount = getAssociatedTokenAddressSync(
        assetMint,
        manager.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      try {
        await program.methods
          .repay(new BN(1_000_000))
          .accountsStrict({
            manager: manager.publicKey,
            vault,
            assetMint,
            managerAssetAccount,
            depositVault,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }

      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();
    });
  });

  // =========================================================================
  // Compliance (Freeze/Unfreeze)
  // =========================================================================
  describe("Compliance", () => {
    it("manager freezes an investor account", async () => {
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      await program.methods
        .freezeAccount()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investor: investor.publicKey,
          frozenAccount,
          systemProgram: SystemProgram.programId,
        })
        .signers([manager])
        .rpc();

      const frozen = await program.account.frozenAccount.fetch(frozenAccount);
      expect(frozen.vault.toBase58()).to.equal(vault.toBase58());
      expect(frozen.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(frozen.frozenBy.toBase58()).to.equal(
        manager.publicKey.toBase58()
      );
    });

    it("frozen investor cannot request deposit", async () => {
      const [, tmpAtt] = await createAttestationAccount(
        investor.publicKey,
        payer.publicKey,
        0
      );

      // Use investor2 PDA slot since investor already has a request (PDA collision)
      // Actually investor's request was already closed, so this should work
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      // But let's test with the actual frozen investor
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: investor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AccountFrozen");
      }
    });

    it("frozen investor cannot request redemption", async () => {
      const [, tmpAtt] = await createAttestationAccount(
        investor.publicKey,
        payer.publicKey,
        0
      );
      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      try {
        await program.methods
          .requestRedeem(new BN(1_000))
          .accountsStrict({
            investor: investor.publicKey,
            vault,
            redemptionRequest,
            sharesMint,
            investorSharesAccount,
            redemptionEscrow,
            frozenAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AccountFrozen");
      }
    });

    it("non-manager cannot freeze", async () => {
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        investor2.publicKey
      );

      try {
        await program.methods
          .freezeAccount()
          .accountsStrict({
            manager: investor.publicKey,
            vault,
            investor: investor2.publicKey,
            frozenAccount,
            systemProgram: SystemProgram.programId,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("manager unfreezes account", async () => {
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      await program.methods
        .unfreezeAccount()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investor: investor.publicKey,
          frozenAccount,
        })
        .signers([manager])
        .rpc();

      // Account should be closed
      try {
        await program.account.frozenAccount.fetch(frozenAccount);
        expect.fail("should have thrown");
      } catch {
        // Expected: account closed
      }
    });

    it("unfrozen investor can request deposit again", async () => {
      const [, tmpAtt] = await createAttestationAccount(
        investor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        investor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(vault, investor.publicKey);

      await program.methods
        .requestDeposit(new BN(2_000_000))
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([investor])
        .rpc();

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();
    });
  });

  // =========================================================================
  // Admin
  // =========================================================================
  describe("Admin", () => {
    it("authority pauses vault", async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(true);
    });

    it("cannot pause already-paused vault", async () => {
      try {
        await program.methods
          .pause()
          .accountsStrict({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }
    });

    it("authority unpauses vault", async () => {
      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
    });

    it("cannot unpause already-unpaused vault", async () => {
      try {
        await program.methods
          .unpause()
          .accountsStrict({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultNotPaused");
      }
    });

    it("non-authority cannot pause", async () => {
      try {
        await program.methods
          .pause()
          .accountsStrict({ authority: manager.publicKey, vault })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("transfers authority", async () => {
      const newAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58()
      );

      // Transfer back so subsequent tests still work
      const sig = await connection.requestAirdrop(
        newAuthority.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultAfter = await program.account.creditVault.fetch(vault);
      expect(vaultAfter.authority.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
    });

    it("rejects transfer to zero address", async () => {
      try {
        await program.methods
          .transferAuthority(PublicKey.default)
          .accountsStrict({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAuthority");
      }
    });

    it("sets new manager", async () => {
      const newManager = Keypair.generate();

      await program.methods
        .setManager(newManager.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.manager.toBase58()).to.equal(
        newManager.publicKey.toBase58()
      );

      // Set back
      await program.methods
        .setManager(manager.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();
    });

    it("rejects zero-address manager", async () => {
      try {
        await program.methods
          .setManager(PublicKey.default)
          .accountsStrict({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidManager");
      }
    });

    it("updates attester", async () => {
      const newAttester = Keypair.generate();

      await program.methods
        .updateAttester(newAttester.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.attester.toBase58()).to.equal(
        newAttester.publicKey.toBase58()
      );

      // Set back so subsequent tests work
      await program.methods
        .updateAttester(payer.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();
    });

    it("non-authority cannot update attester", async () => {
      try {
        await program.methods
          .updateAttester(Keypair.generate().publicKey)
          .accountsStrict({
            authority: manager.publicKey,
            vault,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // =========================================================================
  // Oracle Price Impact
  // =========================================================================
  describe("Oracle Price Impact", () => {
    it("higher NAV means fewer shares per deposit", async () => {
      // Update oracle to 2x NAV (2 assets per share)
      await updateOraclePrice(oracleKeypair, PRICE_SCALE * 2);

      // Create investor2 setup
      [attestation2Keypair, attestation2Account] =
        await createAttestationAccount(
          investor2.publicKey,
          payer.publicKey,
          0
        );

      investor2SharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        investor2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          investor2SharesAccount,
          investor2.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ataIx),
        [payer]
      );

      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        investor2.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        investor2.publicKey
      );

      // Request deposit
      await program.methods
        .requestDeposit(depositAmount)
        .accountsStrict({
          investor: investor2.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: investor2AssetAccount,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: attestation2Account,
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([investor2])
        .rpc();

      // Approve at 2x NAV
      await program.methods
        .approveDeposit()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: investor2.publicKey,
          sharesMint,
          investorSharesAccount: investor2SharesAccount,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: attestation2Account,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: oracleAccount, isSigner: false, isWritable: false },
        ])
        .signers([manager])
        .rpc();

      const sharesReceived = await getAccount(
        connection,
        investor2SharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // At 2x NAV, 100K assets should yield ~50K shares (scaled)
      // shares = 100_000 * 1e6 * 1e9 / (2 * 1e9) = 50_000 * 1e6
      const expectedShares = 50_000 * 10 ** ASSET_DECIMALS;
      expect(Number(sharesReceived.amount)).to.equal(expectedShares);

      console.log(
        "  At 2x NAV: 100K assets -> ",
        Number(sharesReceived.amount) / 1e9,
        "shares"
      );

      // Reset oracle to 1:1
      await updateOraclePrice(oracleKeypair, PRICE_SCALE);
    });

    it("rejects deposit approval without oracle in remaining accounts", async () => {
      // Create another deposit for investor2
      const [, att2] = await createAttestationAccount(
        investor2.publicKey,
        payer.publicKey,
        0
      );

      // Need investor2 to have a new request; previous one was consumed
      // Let's use a fresh investor for this test
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const tmpSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        tmpInvestor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          tmpSharesAccount,
          tmpInvestor.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ataIx),
        [payer]
      );

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Try to approve WITHOUT oracle
      try {
        await program.methods
          .approveDeposit()
          .accountsStrict({
            manager: manager.publicKey,
            vault,
            investmentRequest,
            investor: tmpInvestor.publicKey,
            sharesMint,
            investorSharesAccount: tmpSharesAccount,
            frozenAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([
            // Only attestation, no oracle
            { pubkey: tmpAtt, isSigner: false, isWritable: false },
          ])
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("OracleRequired");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();
    });
  });

  // =========================================================================
  // Attestation Validation
  // =========================================================================
  describe("Attestation Validation", () => {
    it("rejects revoked attestation", async () => {
      // Create and then revoke an attestation
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [revokedAttKp, revokedAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );

      // Revoke it
      await attestationProgram.methods
        .revokeAttestation()
        .accounts({
          authority: payer.publicKey,
          attestation: revokedAtt,
        })
        .rpc();

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: revokedAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AttestationRevoked");
      }
    });

    it("rejects expired attestation", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Create attestation that expires at timestamp 1 (already expired)
      const [, expiredAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        1 // expires_at = 1 (long past)
      );

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: expiredAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AttestationExpired");
      }
    });

    it("rejects attestation from wrong issuer", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Create attestation with WRONG issuer (manager instead of payer/attester)
      const [, wrongIssuerAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        manager.publicKey, // Wrong issuer
        0
      );

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: wrongIssuerAtt, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAttester");
      }
    });

    it("accepts non-expiring attestation (expires_at = 0)", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        5_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [, noExpiryAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0 // expires_at = 0 means no expiry
      );

      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      // Should succeed
      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: noExpiryAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();
    });
  });

  // =========================================================================
  // Full Lifecycle
  // =========================================================================
  describe("Full Lifecycle", () => {
    it("deposit -> repay (yield accrual) -> redeem -> claim", async () => {
      const lifecycleInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        lifecycleInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      // Fund
      const lcAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        lifecycleInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const depositAmount = 1_000_000 * 10 ** ASSET_DECIMALS; // 1M USDC
      await mintTo(
        connection,
        payer,
        assetMint,
        lcAta.address,
        payer.publicKey,
        depositAmount,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Attestation
      const [, lcAtt] = await createAttestationAccount(
        lifecycleInvestor.publicKey,
        payer.publicKey,
        0
      );

      // Shares ATA
      const lcSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        lifecycleInvestor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const ataIx =
        require("@solana/spl-token").createAssociatedTokenAccountInstruction(
          payer.publicKey,
          lcSharesAccount,
          lifecycleInvestor.publicKey,
          sharesMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ataIx),
        [payer]
      );

      // Step 1: Request deposit
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        lifecycleInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        lifecycleInvestor.publicKey
      );

      await program.methods
        .requestDeposit(new BN(depositAmount))
        .accountsStrict({
          investor: lifecycleInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: lcAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lcAtt, isSigner: false, isWritable: false },
        ])
        .signers([lifecycleInvestor])
        .rpc();

      // Step 2: Approve deposit
      await program.methods
        .approveDeposit()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: lifecycleInvestor.publicKey,
          sharesMint,
          investorSharesAccount: lcSharesAccount,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: lcAtt, isSigner: false, isWritable: false },
          { pubkey: oracleAccount, isSigner: false, isWritable: false },
        ])
        .signers([manager])
        .rpc();

      const sharesAfterDeposit = await getAccount(
        connection,
        lcSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      console.log(
        "  Deposited 1M USDC, received",
        Number(sharesAfterDeposit.amount) / 1e9,
        "shares"
      );

      // Step 3: Repay (simulate yield — NAV goes up)
      const managerAssetAccount = getAssociatedTokenAddressSync(
        assetMint,
        manager.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const yieldAmount = new BN(100_000 * 10 ** ASSET_DECIMALS); // 100K yield
      await program.methods
        .repay(yieldAmount)
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          assetMint,
          managerAssetAccount,
          depositVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      const vaultAfterRepay = await program.account.creditVault.fetch(vault);
      console.log(
        "  After repay, total assets:",
        vaultAfterRepay.totalAssets.toNumber() / 10 ** ASSET_DECIMALS
      );

      // Step 4: Update NAV oracle to reflect yield (1.1x)
      await updateOraclePrice(
        oracleKeypair,
        Math.floor(PRICE_SCALE * 1.1)
      );

      // Step 5: Request redemption (all shares)
      const allShares = Number(sharesAfterDeposit.amount);
      const [redemptionRequest] = getRedemptionRequestPDA(
        vault,
        lifecycleInvestor.publicKey
      );

      // New attestation for redemption
      const [, lcAtt2] = await createAttestationAccount(
        lifecycleInvestor.publicKey,
        payer.publicKey,
        0
      );

      await program.methods
        .requestRedeem(new BN(allShares))
        .accountsStrict({
          investor: lifecycleInvestor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount: lcSharesAccount,
          redemptionEscrow,
          frozenAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: lcAtt2, isSigner: false, isWritable: false },
        ])
        .signers([lifecycleInvestor])
        .rpc();

      // Step 6: Approve redemption
      const [claimableEscrow] = getClaimableEscrowPDA(
        vault,
        lifecycleInvestor.publicKey
      );
      const [claimableTokens] = getClaimableTokensPDA(
        vault,
        lifecycleInvestor.publicKey
      );

      await program.methods
        .approveRedeem()
        .accountsStrict({
          manager: manager.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          redemptionEscrow,
          assetMint,
          depositVault,
          claimableTokens,
          claimableEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: oracleAccount, isSigner: false, isWritable: false },
        ])
        .signers([manager])
        .rpc();

      const escrowData = await program.account.claimableEscrow.fetch(
        claimableEscrow
      );
      console.log(
        "  Claimable after yield:",
        escrowData.amountClaimable.toNumber() / 10 ** ASSET_DECIMALS,
        "USDC"
      );

      // At 1.1x NAV, 1M shares should yield ~1.1M assets
      expect(escrowData.amountClaimable.toNumber()).to.be.greaterThan(
        depositAmount
      );

      // Step 7: Claim
      const balanceBefore = await getAccount(connection, lcAta.address);

      await program.methods
        .claimRedemption()
        .accountsStrict({
          investor: lifecycleInvestor.publicKey,
          vault,
          redemptionRequest,
          claimableEscrow,
          assetMint,
          claimableTokens,
          investorAssetAccount: lcAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([lifecycleInvestor])
        .rpc();

      const balanceAfter = await getAccount(connection, lcAta.address);
      const claimed =
        Number(balanceAfter.amount) - Number(balanceBefore.amount);

      console.log(
        "  Final claimed:",
        claimed / 10 ** ASSET_DECIMALS,
        "USDC (profit:",
        (claimed - depositAmount) / 10 ** ASSET_DECIMALS,
        "USDC)"
      );

      expect(claimed).to.be.greaterThan(depositAmount);

      // Reset oracle
      await updateOraclePrice(oracleKeypair, PRICE_SCALE);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe("Edge Cases", () => {
    it("multiple investors can deposit in same window", async () => {
      const investorA = Keypair.generate();
      const investorB = Keypair.generate();

      const [sigA, sigB] = await Promise.all([
        connection.requestAirdrop(
          investorA.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        ),
        connection.requestAirdrop(
          investorB.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        ),
      ]);
      await Promise.all([
        connection.confirmTransaction(sigA, "confirmed"),
        connection.confirmTransaction(sigB, "confirmed"),
      ]);

      const [ataA, ataB] = await Promise.all([
        getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          assetMint,
          investorA.publicKey,
          false,
          undefined,
          undefined,
          TOKEN_PROGRAM_ID
        ),
        getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          assetMint,
          investorB.publicKey,
          false,
          undefined,
          undefined,
          TOKEN_PROGRAM_ID
        ),
      ]);

      await Promise.all([
        mintTo(
          connection,
          payer,
          assetMint,
          ataA.address,
          payer.publicKey,
          5_000_000,
          [],
          undefined,
          TOKEN_PROGRAM_ID
        ),
        mintTo(
          connection,
          payer,
          assetMint,
          ataB.address,
          payer.publicKey,
          5_000_000,
          [],
          undefined,
          TOKEN_PROGRAM_ID
        ),
      ]);

      const [, attA] = await createAttestationAccount(
        investorA.publicKey,
        payer.publicKey,
        0
      );
      const [, attB] = await createAttestationAccount(
        investorB.publicKey,
        payer.publicKey,
        0
      );

      const [reqA] = getInvestmentRequestPDA(vault, investorA.publicKey);
      const [frozenA] = getFrozenAccountPDA(vault, investorA.publicKey);
      const [reqB] = getInvestmentRequestPDA(vault, investorB.publicKey);
      const [frozenB] = getFrozenAccountPDA(vault, investorB.publicKey);

      // Both request deposits
      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: investorA.publicKey,
          vault,
          investmentRequest: reqA,
          assetMint,
          investorAssetAccount: ataA.address,
          depositVault,
          frozenAccount: frozenA,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: attA, isSigner: false, isWritable: false },
        ])
        .signers([investorA])
        .rpc();

      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: investorB.publicKey,
          vault,
          investmentRequest: reqB,
          assetMint,
          investorAssetAccount: ataB.address,
          depositVault,
          frozenAccount: frozenB,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: attB, isSigner: false, isWritable: false },
        ])
        .signers([investorB])
        .rpc();

      // Both requests exist
      const requestA = await program.account.investmentRequest.fetch(reqA);
      const requestB = await program.account.investmentRequest.fetch(reqB);
      expect(requestA.amountLocked.toNumber()).to.equal(5_000_000);
      expect(requestB.amountLocked.toNumber()).to.equal(5_000_000);

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: investorA.publicKey,
          vault,
          investmentRequest: reqA,
          assetMint,
          depositVault,
          investorAssetAccount: ataA.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([investorA])
        .rpc();

      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: investorB.publicKey,
          vault,
          investmentRequest: reqB,
          assetMint,
          depositVault,
          investorAssetAccount: ataB.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([investorB])
        .rpc();
    });

    it("investor cannot have duplicate investment requests", async () => {
      const tmpInvestor = Keypair.generate();
      const sig = await connection.requestAirdrop(
        tmpInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      const tmpAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tmpInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection,
        payer,
        assetMint,
        tmpAta.address,
        payer.publicKey,
        20_000_000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );
      const [, tmpAtt] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );
      const [investmentRequest] = getInvestmentRequestPDA(
        vault,
        tmpInvestor.publicKey
      );
      const [frozenAccount] = getFrozenAccountPDA(
        vault,
        tmpInvestor.publicKey
      );

      // First request succeeds
      await program.methods
        .requestDeposit(new BN(5_000_000))
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          investorAssetAccount: tmpAta.address,
          depositVault,
          frozenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: tmpAtt, isSigner: false, isWritable: false },
        ])
        .signers([tmpInvestor])
        .rpc();

      // Second request fails (PDA already exists)
      const [, tmpAtt2] = await createAttestationAccount(
        tmpInvestor.publicKey,
        payer.publicKey,
        0
      );

      try {
        await program.methods
          .requestDeposit(new BN(5_000_000))
          .accountsStrict({
            investor: tmpInvestor.publicKey,
            vault,
            investmentRequest,
            assetMint,
            investorAssetAccount: tmpAta.address,
            depositVault,
            frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: tmpAtt2, isSigner: false, isWritable: false },
          ])
          .signers([tmpInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // PDA already initialized
        expect(err.message).to.include("already in use");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          investor: tmpInvestor.publicKey,
          vault,
          investmentRequest,
          assetMint,
          depositVault,
          investorAssetAccount: tmpAta.address,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([tmpInvestor])
        .rpc();
    });

    it("vault state is consistent after multiple operations", async () => {
      const vaultAccount = await program.account.creditVault.fetch(vault);

      // total_assets and total_shares should be non-negative and consistent
      expect(vaultAccount.totalAssets.toNumber()).to.be.greaterThanOrEqual(0);
      expect(vaultAccount.totalShares.toNumber()).to.be.greaterThanOrEqual(0);

      // Authority and manager should be set
      expect(vaultAccount.authority.toBase58()).to.not.equal(
        PublicKey.default.toBase58()
      );
      expect(vaultAccount.manager.toBase58()).to.not.equal(
        PublicKey.default.toBase58()
      );

      console.log("  Final vault state:");
      console.log(
        "    Total assets:",
        vaultAccount.totalAssets.toNumber() / 10 ** ASSET_DECIMALS
      );
      console.log(
        "    Total shares:",
        vaultAccount.totalShares.toNumber() / 1e9
      );
      console.log("    Paused:", vaultAccount.paused);
      console.log(
        "    Window open:",
        vaultAccount.investmentWindowOpen
      );
    });
  });
});
