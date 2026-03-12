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
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getCreditFrozenAccountAddress,
} from "../sdk/core/src/credit-vault-pda";

const SAS_PROGRAM_ID = new PublicKey(
  "4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc"
);
const PRICE_SCALE = new BN(1_000_000_000);

describe("svs-11 (Credit Markets Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const sasProgram = anchor.workspace.MockSas as Program<MockSas>;
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

  const getVaultPDA = (): [PublicKey, number] =>
    getCreditVaultAddress(program.programId, assetMint, vaultId);

  const getSharesMintPDA = (): [PublicKey, number] =>
    getCreditSharesMintAddress(program.programId, vault);

  const getRedemptionEscrowPDA = (): [PublicKey, number] =>
    getRedemptionEscrowAddress(program.programId, vault);

  const getInvestmentRequestPDA = (investorKey: PublicKey): [PublicKey, number] =>
    getInvestmentRequestAddress(program.programId, vault, investorKey);

  const getRedemptionRequestPDA = (investorKey: PublicKey): [PublicKey, number] =>
    getRedemptionRequestAddress(program.programId, vault, investorKey);

  const getClaimableTokensPDA = (investorKey: PublicKey): [PublicKey, number] =>
    getClaimableTokensAddress(program.programId, vault, investorKey);

  const getFrozenAccountPDA = (investorKey: PublicKey): [PublicKey, number] =>
    getCreditFrozenAccountAddress(program.programId, vault, investorKey);

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
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        investor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      investorSharesAccount = ata.address;

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: investor.publicKey,
          vault,
          investmentRequest,
          sharesMint,
          investorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
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
        .rejectDeposit(0)
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
      expect(sharesAfter.amount.toString()).to.equal(
        expectedShares.toString()
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
      const expectedBalance =
        BigInt(vaultBefore.totalAssets.toString()) - BigInt(drawAmount.toString());
      expect(depositVaultAccount.amount.toString()).to.equal(
        expectedBalance.toString()
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
        new BN(100_000_000_000).toString()
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

    it("rejects repay when paused", async () => {
      try {
        await program.methods
          .repay(new BN(1_000_000))
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            depositVault,
            managerTokenAccount,
            assetMint,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([manager])
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

  describe("Error Cases - Invalid Amounts", () => {
    it("rejects zero amount deposit request", async () => {
      const zeroInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        zeroInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        zeroInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      await mintTo(
        connection,
        payer,
        assetMint,
        ata.address,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [zeroRequest] = getInvestmentRequestPDA(zeroInvestor.publicKey);
      const [zeroAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        zeroInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: zeroAttestation,
          investor: zeroInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      try {
        await program.methods
          .requestDeposit(new BN(0))
          .accountsPartial({
            investor: zeroInvestor.publicKey,
            vault,
            investmentRequest: zeroRequest,
            investorTokenAccount: ata.address,
            depositVault,
            assetMint,
            attestation: zeroAttestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([zeroInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("rejects deposit below minimum investment", async () => {
      const smallInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        smallInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        smallInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      await mintTo(
        connection,
        payer,
        assetMint,
        ata.address,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [smallRequest] = getInvestmentRequestPDA(smallInvestor.publicKey);
      const [smallAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        smallInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: smallAttestation,
          investor: smallInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      try {
        await program.methods
          .requestDeposit(new BN(1))
          .accountsPartial({
            investor: smallInvestor.publicKey,
            vault,
            investmentRequest: smallRequest,
            investorTokenAccount: ata.address,
            depositVault,
            assetMint,
            attestation: smallAttestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([smallInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DepositTooSmall");
      }
    });

    it("rejects zero amount redeem request", async () => {
      const zeroRedeemer = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        zeroRedeemer.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const [zeroRedemption] = getRedemptionRequestPDA(zeroRedeemer.publicKey);
      const [zeroAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        zeroRedeemer.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: zeroAttestation,
          investor: zeroRedeemer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const zeroSharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        zeroRedeemer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const zeroSharesAccount = zeroSharesAta.address;

      try {
        await program.methods
          .requestRedeem(new BN(0))
          .accountsPartial({
            investor: zeroRedeemer.publicKey,
            vault,
            redemptionRequest: zeroRedemption,
            sharesMint,
            investorSharesAccount: zeroSharesAccount,
            redemptionEscrow,
            attestation: zeroAttestation,
            frozenCheck: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([zeroRedeemer])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("rejects zero amount draw_down", async () => {
      try {
        await program.methods
          .drawDown(new BN(0))
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
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("rejects zero amount repay", async () => {
      try {
        await program.methods
          .repay(new BN(0))
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
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  describe("Error Cases - Invalid Status Transitions", () => {
    let statusInvestor: Keypair;
    let statusInvestorTokenAccount: PublicKey;
    let statusInvestorSharesAccount: PublicKey;
    let statusInvestmentRequest: PublicKey;
    let statusAttestation: PublicKey;

    before(async () => {
      statusInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        statusInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        statusInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      statusInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        statusInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()) * 3n,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [statusInvestmentRequest] = getInvestmentRequestPDA(
        statusInvestor.publicKey
      );
      [statusAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        statusInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: statusAttestation,
          investor: statusInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        statusInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      statusInvestorSharesAccount = sharesAta.address;
    });

    it("rejects approve on already-approved deposit", async () => {
      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: statusInvestor.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          investorTokenAccount: statusInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: statusAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([statusInvestor])
        .rpc();

      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          investor: statusInvestor.publicKey,
          navOracle,
          attestation: statusAttestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      try {
        await program.methods
          .approveDeposit()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            investmentRequest: statusInvestmentRequest,
            investor: statusInvestor.publicKey,
            navOracle,
            attestation: statusAttestation,
            frozenCheck: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("RequestNotPending");
      }
    });

    it("rejects claim on pending deposit", async () => {
      // Clean up previous: claim the approved deposit first
      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: statusInvestor.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          sharesMint,
          investorSharesAccount: statusInvestorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([statusInvestor])
        .rpc();

      // Create a new pending request
      [statusInvestmentRequest] = getInvestmentRequestPDA(
        statusInvestor.publicKey
      );

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: statusInvestor.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          investorTokenAccount: statusInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: statusAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([statusInvestor])
        .rpc();

      try {
        await program.methods
          .claimDeposit()
          .accountsPartial({
            investor: statusInvestor.publicKey,
            vault,
            investmentRequest: statusInvestmentRequest,
            sharesMint,
            investorSharesAccount: statusInvestorSharesAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([statusInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("RequestNotApproved");
      }
    });

    it("rejects cancel on approved deposit", async () => {
      // Approve the pending request from previous test
      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          investor: statusInvestor.publicKey,
          navOracle,
          attestation: statusAttestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      try {
        await program.methods
          .cancelDeposit()
          .accountsPartial({
            investor: statusInvestor.publicKey,
            vault,
            investmentRequest: statusInvestmentRequest,
            depositVault,
            investorTokenAccount: statusInvestorTokenAccount,
            assetMint,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([statusInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("RequestNotPending");
      }

      // Clean up: claim so the request PDA is freed
      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: statusInvestor.publicKey,
          vault,
          investmentRequest: statusInvestmentRequest,
          sharesMint,
          investorSharesAccount: statusInvestorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([statusInvestor])
        .rpc();
    });
  });

  describe("Error Cases - Insufficient Liquidity on Redeem", () => {
    let liqInvestor: Keypair;
    let liqInvestorTokenAccount: PublicKey;
    let liqInvestorSharesAccount: PublicKey;
    let liqInvestmentRequest: PublicKey;
    let liqRedemptionRequest: PublicKey;
    let liqAttestation: PublicKey;
    let liqClaimableTokens: PublicKey;

    before(async () => {
      liqInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        liqInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        liqInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      liqInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        liqInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [liqInvestmentRequest] = getInvestmentRequestPDA(liqInvestor.publicKey);
      [liqRedemptionRequest] = getRedemptionRequestPDA(liqInvestor.publicKey);
      [liqClaimableTokens] = getClaimableTokensPDA(liqInvestor.publicKey);
      [liqAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        liqInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: liqAttestation,
          investor: liqInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const liqSharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        liqInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      liqInvestorSharesAccount = liqSharesAta.address;

      // Deposit + approve + claim
      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: liqInvestor.publicKey,
          vault,
          investmentRequest: liqInvestmentRequest,
          investorTokenAccount: liqInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: liqAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([liqInvestor])
        .rpc();

      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: liqInvestmentRequest,
          investor: liqInvestor.publicKey,
          navOracle,
          attestation: liqAttestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: liqInvestor.publicKey,
          vault,
          investmentRequest: liqInvestmentRequest,
          sharesMint,
          investorSharesAccount: liqInvestorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([liqInvestor])
        .rpc();

      // Draw down most of the vault balance
      const vaultAccount = await program.account.creditVault.fetch(vault);
      const depositVaultInfo = await getAccount(connection, depositVault);
      const availableLiquidity =
        BigInt(depositVaultInfo.amount.toString()) -
        BigInt(vaultAccount.totalPendingDeposits.toString());
      const drawAmount = availableLiquidity - 1n; // leave only 1 lamport

      if (drawAmount > 0n) {
        await program.methods
          .drawDown(new BN(drawAmount.toString()))
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
      }
    });

    it("rejects approve_redeem with insufficient liquidity", async () => {
      const shares = await getAccount(
        connection,
        liqInvestorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .requestRedeem(new BN(shares.amount.toString()))
        .accountsPartial({
          investor: liqInvestor.publicKey,
          vault,
          redemptionRequest: liqRedemptionRequest,
          sharesMint,
          investorSharesAccount: liqInvestorSharesAccount,
          redemptionEscrow,
          attestation: liqAttestation,
          frozenCheck: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([liqInvestor])
        .rpc();

      try {
        await program.methods
          .approveRedeem()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            redemptionRequest: liqRedemptionRequest,
            investor: liqInvestor.publicKey,
            sharesMint,
            redemptionEscrow,
            depositVault,
            assetMint,
            claimableTokens: liqClaimableTokens,
            navOracle,
            attestation: liqAttestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InsufficientLiquidity");
      }
    });
  });

  describe("Error Cases - Frozen Account on Approve", () => {
    let frozenInvestor: Keypair;
    let frozenInvestorTokenAccount: PublicKey;
    let frozenInvestorSharesAccount: PublicKey;
    let frozenInvRequest: PublicKey;
    let frozenRedRequest: PublicKey;
    let frozenInvAttestation: PublicKey;
    let frozenInvFrozenAccount: PublicKey;
    let frozenInvClaimableTokens: PublicKey;

    before(async () => {
      frozenInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        frozenInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        frozenInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      frozenInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        frozenInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()) * 2n,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [frozenInvRequest] = getInvestmentRequestPDA(frozenInvestor.publicKey);
      [frozenRedRequest] = getRedemptionRequestPDA(frozenInvestor.publicKey);
      [frozenInvAttestation] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        frozenInvestor.publicKey
      );
      [frozenInvFrozenAccount] = getFrozenAccountPDA(frozenInvestor.publicKey);
      [frozenInvClaimableTokens] = getClaimableTokensPDA(
        frozenInvestor.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: frozenInvAttestation,
          investor: frozenInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const frozenSharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        frozenInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      frozenInvestorSharesAccount = frozenSharesAta.address;

      // Repay so the vault has liquidity for the redeem test
      await program.methods
        .repay(depositAmount)
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
    });

    it("rejects approve_deposit for frozen investor", async () => {
      // Request deposit while unfrozen
      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: frozenInvestor.publicKey,
          vault,
          investmentRequest: frozenInvRequest,
          investorTokenAccount: frozenInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: frozenInvAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([frozenInvestor])
        .rpc();

      // Freeze investor
      await program.methods
        .freezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investor: frozenInvestor.publicKey,
          frozenAccount: frozenInvFrozenAccount,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      // Try approve with frozen check
      try {
        await program.methods
          .approveDeposit()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            investmentRequest: frozenInvRequest,
            investor: frozenInvestor.publicKey,
            navOracle,
            attestation: frozenInvAttestation,
            frozenCheck: frozenInvFrozenAccount,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AccountFrozen");
      }

      // Clean up: unfreeze and reject deposit
      await program.methods
        .unfreezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          frozenAccount: frozenInvFrozenAccount,
        })
        .signers([manager])
        .rpc();

      await program.methods
        .rejectDeposit(0)
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: frozenInvRequest,
          investor: frozenInvestor.publicKey,
          depositVault,
          investorTokenAccount: frozenInvestorTokenAccount,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();
    });

    it("rejects approve_redeem for frozen investor", async () => {
      // Deposit + approve + claim first to get shares
      [frozenInvRequest] = getInvestmentRequestPDA(frozenInvestor.publicKey);

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: frozenInvestor.publicKey,
          vault,
          investmentRequest: frozenInvRequest,
          investorTokenAccount: frozenInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: frozenInvAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([frozenInvestor])
        .rpc();

      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: frozenInvRequest,
          investor: frozenInvestor.publicKey,
          navOracle,
          attestation: frozenInvAttestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: frozenInvestor.publicKey,
          vault,
          investmentRequest: frozenInvRequest,
          sharesMint,
          investorSharesAccount: frozenInvestorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([frozenInvestor])
        .rpc();

      // Request redeem while unfrozen
      const shares = await getAccount(
        connection,
        frozenInvestorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .requestRedeem(new BN(shares.amount.toString()))
        .accountsPartial({
          investor: frozenInvestor.publicKey,
          vault,
          redemptionRequest: frozenRedRequest,
          sharesMint,
          investorSharesAccount: frozenInvestorSharesAccount,
          redemptionEscrow,
          attestation: frozenInvAttestation,
          frozenCheck: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([frozenInvestor])
        .rpc();

      // Freeze investor
      await program.methods
        .freezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investor: frozenInvestor.publicKey,
          frozenAccount: frozenInvFrozenAccount,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      // Try approve redeem with frozen check
      try {
        await program.methods
          .approveRedeem()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            redemptionRequest: frozenRedRequest,
            investor: frozenInvestor.publicKey,
            sharesMint,
            redemptionEscrow,
            depositVault,
            assetMint,
            claimableTokens: frozenInvClaimableTokens,
            navOracle,
            attestation: frozenInvAttestation,
            frozenCheck: frozenInvFrozenAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AccountFrozen");
      }

      // Clean up: unfreeze
      await program.methods
        .unfreezeAccount()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          frozenAccount: frozenInvFrozenAccount,
        })
        .signers([manager])
        .rpc();
    });
  });

  describe("Error Cases - Pause Blocks Operations", () => {
    before(async () => {
      await program.methods
        .pause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });

    after(async () => {
      await program.methods
        .unpause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });

    it("rejects draw_down when paused", async () => {
      try {
        await program.methods
          .drawDown(new BN(1_000_000))
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
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }
    });

    it("rejects repay when paused", async () => {
      try {
        await program.methods
          .repay(new BN(1_000_000))
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
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }
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
        .rejectDeposit(0)
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

    it("non-manager cannot reject deposit", async () => {
      const tempInvestor2 = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        tempInvestor2.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const tempAta2 = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        tempInvestor2.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      await mintTo(
        connection,
        payer,
        assetMint,
        tempAta2.address,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const [tempRequest2] = getInvestmentRequestPDA(tempInvestor2.publicKey);
      const [tempAttestation2] = getAttestationPDA(
        sasCredential.publicKey,
        sasSchema.publicKey,
        tempInvestor2.publicKey
      );

      await sasProgram.methods
        .createAttestation(
          sasCredential.publicKey,
          sasSchema.publicKey,
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: tempAttestation2,
          investor: tempInvestor2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: tempInvestor2.publicKey,
          vault,
          investmentRequest: tempRequest2,
          investorTokenAccount: tempAta2.address,
          depositVault,
          assetMint,
          attestation: tempAttestation2,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([tempInvestor2])
        .rpc();

      try {
        await program.methods
          .rejectDeposit(0)
          .accountsPartial({
            manager: investor.publicKey,
            vault,
            investmentRequest: tempRequest2,
            investor: tempInvestor2.publicKey,
            depositVault,
            investorTokenAccount: tempAta2.address,
            assetMint,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error).to.exist;
      }

      // Clean up
      await program.methods
        .rejectDeposit(0)
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: tempRequest2,
          investor: tempInvestor2.publicKey,
          depositVault,
          investorTokenAccount: tempAta2.address,
          assetMint,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([manager])
        .rpc();
    });

    it("non-manager cannot draw_down", async () => {
      try {
        await program.methods
          .drawDown(new BN(1_000_000))
          .accountsPartial({
            manager: investor.publicKey,
            vault,
            depositVault,
            destination: investorTokenAccount,
            assetMint,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error).to.exist;
      }
    });

    it("non-manager cannot freeze account", async () => {
      const targetInvestor = Keypair.generate();
      const [targetFrozen] = getFrozenAccountPDA(targetInvestor.publicKey);

      try {
        await program.methods
          .freezeAccount()
          .accountsPartial({
            manager: investor.publicKey,
            vault,
            investor: targetInvestor.publicKey,
            frozenAccount: targetFrozen,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([investor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error).to.exist;
      }
    });

    it("non-authority cannot transfer authority", async () => {
      const newAuth = Keypair.generate();

      try {
        await program.methods
          .transferAuthority(newAuth.publicKey)
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

    it("non-authority cannot set manager", async () => {
      const newMgr = Keypair.generate();

      try {
        await program.methods
          .setManager(newMgr.publicKey)
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

  describe("Zero Address Guards", () => {
    it("rejects transfer_authority to zero address", async () => {
      try {
        await program.methods
          .transferAuthority(PublicKey.default)
          .accountsPartial({
            authority: payer.publicKey,
            vault,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidAddress");
      }
    });

    it("rejects set_manager to zero address", async () => {
      try {
        await program.methods
          .setManager(PublicKey.default)
          .accountsPartial({
            authority: payer.publicKey,
            vault,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidAddress");
      }
    });
  });

  describe("Double Pause/Unpause", () => {
    it("rejects pause when already paused", async () => {
      await program.methods
        .pause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      try {
        await program.methods
          .pause()
          .accountsPartial({
            authority: payer.publicKey,
            vault,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }

      // Restore: unpause
      await program.methods
        .unpause()
        .accountsPartial({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });

    it("rejects unpause when not paused", async () => {
      try {
        await program.methods
          .unpause()
          .accountsPartial({
            authority: payer.publicKey,
            vault,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultNotPaused");
      }
    });
  });
});
