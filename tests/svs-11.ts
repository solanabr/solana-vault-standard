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
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs11 } from "../target/types/svs_11";
import { MockOracle } from "../target/types/mock_oracle";
import { MockSas } from "../target/types/mock_sas";

const SAS_PROGRAM_ID = new PublicKey(
  "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG"
);
const PRICE_SCALE = new BN(1_000_000_000);

describe("svs-11 (Credit Markets Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const sasProgram = new Program(
    anchor.workspace.MockSas.idl,
    SAS_PROGRAM_ID,
    provider
  ) as Program<MockSas>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const ASSET_DECIMALS = 6;
  const SHARES_DECIMALS = 9;
  const vaultId = new BN(1);
  const depositAmount = new BN(100_000_000_000); // 100,000 tokens (6 decimals)
  const minimumInvestment = new BN(1_000_000); // 1 token
  const maxStaleness = new BN(3600);

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let depositVault: PublicKey;
  let redemptionEscrow: PublicKey;
  let navOracle: PublicKey;
  let investorTokenAccount: PublicKey;
  let investorSharesAccount: PublicKey;
  let investmentRequest: PublicKey;
  let redemptionRequest: PublicKey;
  let claimableTokens: PublicKey;
  let frozenAccount: PublicKey;
  let attestation: PublicKey;
  let sasCredential: Keypair;
  let sasSchema: Keypair;
  let manager: Keypair;
  let investor: Keypair;
  let managerTokenAccount: PublicKey;

  // Expected shares from 100,000 assets at 1:1 price
  // shares = assets * PRICE_SCALE / price = 100_000_000_000 * 1e9 / 1e9 = 100_000_000_000
  const expectedShares = new BN(100_000_000_000);

  const getVaultPDA = (): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("credit_vault"),
        assetMint.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  };

  const getSharesMintPDA = (): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  };

  const getRedemptionEscrowPDA = (): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("redemption_escrow"), vault.toBuffer()],
      program.programId
    );
  };

  const getInvestmentRequestPDA = (
    investorKey: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("investment_request"),
        vault.toBuffer(),
        investorKey.toBuffer(),
      ],
      program.programId
    );
  };

  const getRedemptionRequestPDA = (
    investorKey: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("redemption_request"),
        vault.toBuffer(),
        investorKey.toBuffer(),
      ],
      program.programId
    );
  };

  const getClaimableTokensPDA = (
    investorKey: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("claimable_tokens"),
        vault.toBuffer(),
        investorKey.toBuffer(),
      ],
      program.programId
    );
  };

  const getFrozenAccountPDA = (
    investorKey: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("frozen_account"),
        vault.toBuffer(),
        investorKey.toBuffer(),
      ],
      program.programId
    );
  };

  const getOracleDataPDA = (): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      oracleProgram.programId
    );
  };

  const getAttestationPDA = (
    credential: PublicKey,
    schema: PublicKey,
    investorKey: PublicKey
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [credential.toBuffer(), schema.toBuffer(), investorKey.toBuffer()],
      SAS_PROGRAM_ID
    );
  };

  before(async () => {
    manager = Keypair.generate();
    investor = Keypair.generate();
    sasCredential = Keypair.generate();
    sasSchema = Keypair.generate();

    // Fund manager and investor
    const airdropManager = await connection.requestAirdrop(
      manager.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropManager);

    const airdropInvestor = await connection.requestAirdrop(
      investor.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropInvestor);

    // Create asset mint (standard SPL Token, 6 decimals)
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
    [vault] = getVaultPDA();
    [sharesMint] = getSharesMintPDA();
    [redemptionEscrow] = getRedemptionEscrowPDA();
    [navOracle] = getOracleDataPDA();
    [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);
    [redemptionRequest] = getRedemptionRequestPDA(investor.publicKey);
    [claimableTokens] = getClaimableTokensPDA(investor.publicKey);
    [frozenAccount] = getFrozenAccountPDA(investor.publicKey);
    [attestation] = getAttestationPDA(
      sasCredential.publicKey,
      sasSchema.publicKey,
      investor.publicKey
    );

    depositVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      TOKEN_PROGRAM_ID
    );

    // Create investor token account and mint assets
    const investorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      investor.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    investorTokenAccount = investorAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      investorTokenAccount,
      payer.publicKey,
      BigInt(depositAmount.toString()) * 10n,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Create manager token account and mint assets (for repay)
    const managerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      manager.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    managerTokenAccount = managerAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      managerTokenAccount,
      payer.publicKey,
      BigInt(depositAmount.toString()) * 10n,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Set oracle price (1:1)
    await oracleProgram.methods
      .setPrice(PRICE_SCALE)
      .accountsPartial({
        authority: payer.publicKey,
        oracleData: navOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Create SAS attestation for investor
    await sasProgram.methods
      .createAttestation(
        sasCredential.publicKey,
        sasSchema.publicKey,
        new BN(0) // expiry=0 means no expiry
      )
      .accountsPartial({
        authority: payer.publicKey,
        attestation,
        investor: investor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  describe("Initialization", () => {
    it("initializes vault correctly", async () => {
      await program.methods
        .initializePool(
          vaultId,
          "Credit Vault",
          "cVLT",
          "https://example.com/metadata",
          minimumInvestment,
          maxStaleness
        )
        .accountsPartial({
          authority: payer.publicKey,
          manager: manager.publicKey,
          vault,
          assetMint,
          sharesMint,
          depositVault,
          redemptionEscrow,
          navOracle,
          oracleProgram: oracleProgram.programId,
          sasCredential: sasCredential.publicKey,
          sasSchema: sasSchema.publicKey,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

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
      expect(vaultAccount.navOracle.toBase58()).to.equal(
        navOracle.toBase58()
      );
      expect(vaultAccount.oracleProgram.toBase58()).to.equal(
        oracleProgram.programId.toBase58()
      );
      expect(vaultAccount.sasCredential.toBase58()).to.equal(
        sasCredential.publicKey.toBase58()
      );
      expect(vaultAccount.sasSchema.toBase58()).to.equal(
        sasSchema.publicKey.toBase58()
      );
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
      expect(vaultAccount.minimumInvestment.toNumber()).to.equal(
        minimumInvestment.toNumber()
      );
      expect(vaultAccount.investmentWindowOpen).to.equal(false);
      expect(vaultAccount.decimalsOffset).to.equal(3);
      expect(vaultAccount.paused).to.equal(false);
    });
  });

  describe("Investment Window", () => {
    it("opens investment window", async () => {
      await program.methods
        .openInvestmentWindow()
        .accountsPartial({
          vault,
          manager: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.investmentWindowOpen).to.equal(true);
    });

    it("closes investment window", async () => {
      await program.methods
        .closeInvestmentWindow()
        .accountsPartial({
          vault,
          manager: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.investmentWindowOpen).to.equal(false);
    });

    it("rejects deposit when window closed", async () => {
      try {
        await program.methods
          .requestDeposit(depositAmount)
          .accountsPartial({
            investor: investor.publicKey,
            vault,
            investmentRequest,
            investorTokenAccount,
            depositVault,
            assetMint,
            attestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvestmentWindowClosed");
      }
    });
  });

  describe("Deposit Flow", () => {
    before(async () => {
      // Re-open investment window for deposit tests
      await program.methods
        .openInvestmentWindow()
        .accountsPartial({
          vault,
          manager: manager.publicKey,
        })
        .signers([manager])
        .rpc();
    });

    it("investor requests deposit", async () => {
      const balanceBefore = await getAccount(connection, investorTokenAccount);

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          investorTokenAccount,
          depositVault,
          assetMint,
          attestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([investor])
        .rpc();

      const request = await program.account.investmentRequest.fetch(
        investmentRequest
      );
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(request.amountLocked.toString()).to.equal(
        depositAmount.toString()
      );
      expect(request.sharesClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ pending: {} })
      );

      const balanceAfter = await getAccount(connection, investorTokenAccount);
      expect(
        BigInt(balanceBefore.amount.toString()) -
          BigInt(balanceAfter.amount.toString())
      ).to.equal(BigInt(depositAmount.toString()));

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalPendingDeposits.toString()).to.equal(
        depositAmount.toString()
      );
    });

    it("manager approves deposit", async () => {
      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: investor.publicKey,
          navOracle,
          attestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request = await program.account.investmentRequest.fetch(
        investmentRequest
      );
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} })
      );
      expect(request.sharesClaimable.toString()).to.equal(
        expectedShares.toString()
      );

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalAssets.toString()).to.equal(
        depositAmount.toString()
      );
      expect(vaultAccount.totalShares.toString()).to.equal(
        expectedShares.toString()
      );
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
    });

    it("investor claims deposit", async () => {
      investorSharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        investor.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          sharesMint,
          investorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();

      const sharesBalance = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(sharesBalance.amount.toString()).to.equal(
        expectedShares.toString()
      );
    });

    it("request PDA closed after claim", async () => {
      const info = await connection.getAccountInfo(investmentRequest);
      expect(info).to.be.null;
    });
  });

  describe("Deposit Rejection", () => {
    let rejectInvestor: Keypair;
    let rejectInvestorTokenAccount: PublicKey;
    let rejectInvestmentRequest: PublicKey;
    let rejectAttestation: PublicKey;

    before(async () => {
      rejectInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        rejectInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        rejectInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      rejectInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        rejectInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [rejectInvestmentRequest] = getInvestmentRequestPDA(
        rejectInvestor.publicKey
      );
      [rejectAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        rejectInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: rejectAttestation,
          investor: rejectInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: rejectInvestor.publicKey,
          vault,
          investmentRequest: rejectInvestmentRequest,
          investorTokenAccount: rejectInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: rejectAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([rejectInvestor])
        .rpc();
    });

    it("manager rejects deposit", async () => {
      const balanceBefore = await getAccount(
        connection,
        rejectInvestorTokenAccount
      );

      await program.methods
        .rejectDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: rejectInvestmentRequest,
          investor: rejectInvestor.publicKey,
          depositVault,
          investorTokenAccount: rejectInvestorTokenAccount,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      const balanceAfter = await getAccount(
        connection,
        rejectInvestorTokenAccount
      );
      expect(
        BigInt(balanceAfter.amount.toString()) -
          BigInt(balanceBefore.amount.toString())
      ).to.equal(BigInt(depositAmount.toString()));

      const info = await connection.getAccountInfo(rejectInvestmentRequest);
      expect(info).to.be.null;
    });
  });

  describe("Deposit Cancellation", () => {
    let cancelInvestor: Keypair;
    let cancelInvestorTokenAccount: PublicKey;
    let cancelInvestmentRequest: PublicKey;
    let cancelAttestation: PublicKey;

    before(async () => {
      cancelInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        cancelInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        cancelInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      cancelInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        cancelInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [cancelInvestmentRequest] = getInvestmentRequestPDA(
        cancelInvestor.publicKey
      );
      [cancelAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        cancelInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: cancelAttestation,
          investor: cancelInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: cancelInvestor.publicKey,
          vault,
          investmentRequest: cancelInvestmentRequest,
          investorTokenAccount: cancelInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: cancelAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([cancelInvestor])
        .rpc();
    });

    it("investor cancels pending deposit", async () => {
      const balanceBefore = await getAccount(
        connection,
        cancelInvestorTokenAccount
      );

      await program.methods
        .cancelDeposit()
        .accountsPartial({
          investor: cancelInvestor.publicKey,
          vault,
          investmentRequest: cancelInvestmentRequest,
          depositVault,
          investorTokenAccount: cancelInvestorTokenAccount,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([cancelInvestor])
        .rpc();

      const balanceAfter = await getAccount(
        connection,
        cancelInvestorTokenAccount
      );
      expect(
        BigInt(balanceAfter.amount.toString()) -
          BigInt(balanceBefore.amount.toString())
      ).to.equal(BigInt(depositAmount.toString()));

      const info = await connection.getAccountInfo(cancelInvestmentRequest);
      expect(info).to.be.null;
    });
  });

  describe("Redeem Flow", () => {
    it("investor requests redemption", async () => {
      const sharesBefore = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const sharesToRedeem = new BN(sharesBefore.amount.toString());

      await program.methods
        .requestRedeem(sharesToRedeem)
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount,
          redemptionEscrow,
          attestation,
          frozenCheck: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([investor])
        .rpc();

      const request = await program.account.redemptionRequest.fetch(
        redemptionRequest
      );
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(request.sharesLocked.toString()).to.equal(
        sharesToRedeem.toString()
      );
      expect(request.assetsClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ pending: {} })
      );

      const sharesAfter = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(sharesAfter.amount.toString()).to.equal("0");
    });

    it("manager approves redemption", async () => {
      await program.methods
        .approveRedeem()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          redemptionRequest,
          investor: investor.publicKey,
          sharesMint,
          redemptionEscrow,
          depositVault,
          assetMint,
          claimableTokens,
          navOracle,
          attestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request = await program.account.redemptionRequest.fetch(
        redemptionRequest
      );
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} })
      );
      expect(request.assetsClaimable.toString()).to.equal(
        depositAmount.toString()
      );

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
    });

    it("investor claims redemption", async () => {
      const balanceBefore = await getAccount(connection, investorTokenAccount);

      await program.methods
        .claimRedeem()
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          assetMint,
          claimableTokens,
          investorTokenAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();

      const balanceAfter = await getAccount(connection, investorTokenAccount);
      expect(
        BigInt(balanceAfter.amount.toString()) -
          BigInt(balanceBefore.amount.toString())
      ).to.equal(BigInt(depositAmount.toString()));

      const requestInfo = await connection.getAccountInfo(redemptionRequest);
      expect(requestInfo).to.be.null;

      const claimableInfo = await connection.getAccountInfo(claimableTokens);
      expect(claimableInfo).to.be.null;
    });
  });

  describe("Redeem Cancellation", () => {
    before(async () => {
      // Deposit again so we have shares to test cancellation
      [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          investorTokenAccount,
          depositVault,
          assetMint,
          attestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([investor])
        .rpc();

      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest,
          investor: investor.publicKey,
          navOracle,
          attestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          sharesMint,
          investorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();

      // Request redemption to cancel
      [redemptionRequest] = getRedemptionRequestPDA(investor.publicKey);

      const shares = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .requestRedeem(new BN(shares.amount.toString()))
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount,
          redemptionEscrow,
          attestation,
          frozenCheck: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([investor])
        .rpc();
    });

    it("investor cancels pending redemption", async () => {
      const sharesBefore = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .cancelRedeem()
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          redemptionRequest,
          sharesMint,
          investorSharesAccount,
          redemptionEscrow,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([investor])
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(BigInt(sharesAfter.amount.toString())).to.be.greaterThan(
        BigInt(sharesBefore.amount.toString())
      );

      const info = await connection.getAccountInfo(redemptionRequest);
      expect(info).to.be.null;
    });
  });

  describe("Credit Operations", () => {
    it("manager draws down assets", async () => {
      const vaultBefore = await program.account.creditVault.fetch(vault);
      const drawAmount = new BN(50_000_000_000); // 50,000 tokens

      await program.methods
        .drawDown(drawAmount)
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          depositVault,
          destination: managerTokenAccount,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      const depositVaultAccount = await getAccount(connection, depositVault);
      expect(
        BigInt(depositVaultAccount.amount.toString())
      ).to.be.lessThan(
        BigInt(vaultBefore.totalAssets.toString())
      );
    });

    it("manager repays assets", async () => {
      const repayAmount = new BN(50_000_000_000);

      await program.methods
        .repay(repayAmount)
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          managerTokenAccount,
          depositVault,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalAssets.toString()).to.equal(
        new BN(150_000_000_000).toString()
      );
    });

    it("draw_down rejects when insufficient liquidity", async () => {
      const hugeAmount = new BN("999000000000000");
      try {
        await program.methods
          .drawDown(hugeAmount)
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            depositVault,
            destination: managerTokenAccount,
            assetMint,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InsufficientLiquidity");
      }
    });
  });

  describe("Compliance", () => {
    it("manager freezes account", async () => {
      await program.methods
        .freezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investor: investor.publicKey,
          frozenAccount,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const frozen = await program.account.frozenAccount.fetch(frozenAccount);
      expect(frozen.investor.toBase58()).to.equal(
        investor.publicKey.toBase58()
      );
      expect(frozen.frozenBy.toBase58()).to.equal(
        manager.publicKey.toBase58()
      );
    });

    it("frozen account cannot request deposit", async () => {
      [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);

      try {
        await program.methods
          .requestDeposit(depositAmount)
          .accountsPartial({
            investor: investor.publicKey,
            vault,
            investmentRequest,
            investorTokenAccount,
            depositVault,
            assetMint,
            attestation,
            frozenCheck: frozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AccountFrozen");
      }
    });

    it("manager unfreezes account", async () => {
      await program.methods
        .unfreezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          frozenAccount,
        })
        .signers([manager])
        .rpc();

      const info = await connection.getAccountInfo(frozenAccount);
      expect(info).to.be.null;
    });
  });

  describe("Admin", () => {
    it("pauses vault", async () => {
      await program.methods
        .pause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(true);
    });

    it("rejects requests when paused", async () => {
      [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);

      try {
        await program.methods
          .requestDeposit(depositAmount)
          .accountsPartial({
            investor: investor.publicKey,
            vault,
            investmentRequest,
            investorTokenAccount,
            depositVault,
            assetMint,
            attestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }
    });

    it("unpauses vault", async () => {
      await program.methods
        .unpause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
    });

    it("transfers authority", async () => {
      const newAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58()
      );

      // Transfer back
      const airdrop = await connection.requestAirdrop(
        newAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsPartial({
          authority: newAuthority.publicKey,
          vault,
        })
        .signers([newAuthority])
        .rpc();
    });

    it("sets manager", async () => {
      const newManager = Keypair.generate();

      await program.methods
        .setManager(newManager.publicKey)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.manager.toBase58()).to.equal(
        newManager.publicKey.toBase58()
      );

      // Set back to original manager for remaining tests
      await program.methods
        .setManager(manager.publicKey)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });

    it("updates SAS config", async () => {
      const newCredential = Keypair.generate();
      const newSchema = Keypair.generate();

      await program.methods
        .updateSasConfig(newCredential.publicKey, newSchema.publicKey)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.sasCredential.toBase58()).to.equal(
        newCredential.publicKey.toBase58()
      );
      expect(vaultAccount.sasSchema.toBase58()).to.equal(
        newSchema.publicKey.toBase58()
      );

      // Restore original SAS config
      await program.methods
        .updateSasConfig(sasCredential.publicKey, sasSchema.publicKey)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });
  });

  describe("Permission Checks", () => {
    it("non-manager cannot approve deposit", async () => {
      // Set up a fresh deposit to approve
      const tempInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        tempInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const tempAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tempInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      await mintTo(
        connection,
        payer,
        assetMint,
        tempAta.address,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [tempRequest] = getInvestmentRequestPDA(tempInvestor.publicKey);
      const [tempAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        tempInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: tempAttestation,
          investor: tempInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: tempInvestor.publicKey,
          vault,
          investmentRequest: tempRequest,
          investorTokenAccount: tempAta.address,
          depositVault,
          assetMint,
          attestation: tempAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([tempInvestor])
        .rpc();

      // Try to approve as non-manager (investor)
      try {
        await program.methods
          .approveDeposit()
          .accountsPartial({
            manager: investor.publicKey,
            vault,
            investmentRequest: tempRequest,
            investor: tempInvestor.publicKey,
            navOracle,
            attestation: tempAttestation,
            frozenCheck: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error).to.exist;
      }

      // Clean up: reject the deposit as manager
      await program.methods
        .rejectDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: tempRequest,
          investor: tempInvestor.publicKey,
          depositVault,
          investorTokenAccount: tempAta.address,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();
    });

    it("non-authority cannot pause", async () => {
      try {
        await program.methods
          .pause()
          .accountsPartial({
            authority: manager.publicKey,
            vault,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });
});
