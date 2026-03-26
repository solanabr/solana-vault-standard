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
import { MockSas as MockAttestation } from "../target/types/mock_sas";
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getCreditFrozenAccountAddress,
} from "../sdk/core/src/credit-vault-pda";

const ATTESTATION_PROGRAM_ID = new PublicKey(
  "4azCqYgLHDRmsiR6kmYu6v5qvzamaYGqZcmx8MrnrKMc"
);
const PRICE_SCALE = new BN(1_000_000_000);

describe("svs-11 (Credit Markets Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const attestationMockProgram = anchor.workspace.MockSas as Program<MockAttestation>;
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
  let attester: Keypair;
  let attestationProgramId: PublicKey;
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

  const getOracleDataPDA = (vaultPda: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), vaultPda.toBuffer()],
      oracleProgram.programId
    );
  };

  const getAttestationPDA = (
    subject: PublicKey,
    issuer: PublicKey,
    attestationType: number = 0
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        subject.toBuffer(),
        issuer.toBuffer(),
        Buffer.from([attestationType]),
      ],
      ATTESTATION_PROGRAM_ID
    );
  };

  before(async () => {
    manager = Keypair.generate();
    investor = Keypair.generate();
    attester = Keypair.generate();
    attestationProgramId = ATTESTATION_PROGRAM_ID;

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
    [navOracle] = getOracleDataPDA(vault);
    [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);
    [redemptionRequest] = getRedemptionRequestPDA(investor.publicKey);
    [claimableTokens] = getClaimableTokensPDA(investor.publicKey);
    [frozenAccount] = getFrozenAccountPDA(investor.publicKey);
    [attestation] = getAttestationPDA(
      investor.publicKey,
      attester.publicKey
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
      BigInt(depositAmount.toString()) * BigInt(10),
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
      BigInt(depositAmount.toString()) * BigInt(10),
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
        vault: vault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Create attestation for investor
    await attestationMockProgram.methods
      .createAttestation(
        attester.publicKey,
        0,
        [66, 82],
        new BN(0) // expiresAt=0 means no expiry
      )
      .accountsPartial({
        authority: payer.publicKey,
        attestation,
        subject: investor.publicKey,
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
          attester: attester.publicKey,
          attestationProgram: attestationProgramId,
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
      expect(vaultAccount.attester.toBase58()).to.equal(
        attester.publicKey.toBase58()
      );
      expect(vaultAccount.attestationProgram.toBase58()).to.equal(
        attestationProgramId.toBase58()
      );
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
      expect(vaultAccount.minimumInvestment.toNumber()).to.equal(
        minimumInvestment.toNumber()
      );
      expect(vaultAccount.investmentWindowOpen).to.equal(false);
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
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalApprovedDeposits.toString()).to.equal(
        depositAmount.toString()
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
          attestation,
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
        rejectInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: rejectAttestation,
          subject: rejectInvestor.publicKey,
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
        cancelInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: cancelAttestation,
          subject: cancelInvestor.publicKey,
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
          attestation,
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
          attestation,
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

    it("updates attester config", async () => {
      const newAttester = Keypair.generate();
      // Use mock_sas as the new attestation program (it's a real deployed program)
      const newAttestationProgram = attestationProgramId;

      await program.methods
        .updateAttester(newAttester.publicKey, newAttestationProgram)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          newAttestationProgramAccount: newAttestationProgram,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.attester.toBase58()).to.equal(
        newAttester.publicKey.toBase58()
      );
      expect(vaultAccount.attestationProgram.toBase58()).to.equal(
        newAttestationProgram.toBase58()
      );

      // Restore original attester
      await program.methods
        .updateAttester(attester.publicKey, attestationProgramId)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          newAttestationProgramAccount: attestationProgramId,
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
        zeroInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: zeroAttestation,
          subject: zeroInvestor.publicKey,
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
        smallInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: smallAttestation,
          subject: smallInvestor.publicKey,
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
        zeroRedeemer.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: zeroAttestation,
          subject: zeroRedeemer.publicKey,
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
        BigInt(depositAmount.toString()) * BigInt(3),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [statusInvestmentRequest] = getInvestmentRequestPDA(
        statusInvestor.publicKey
      );
      [statusAttestation] = getAttestationPDA(
        statusInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: statusAttestation,
          subject: statusInvestor.publicKey,
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
          attestation: statusAttestation,
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
            attestation: statusAttestation,
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
          attestation: statusAttestation,
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
        liqInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: liqAttestation,
          subject: liqInvestor.publicKey,
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
          attestation: liqAttestation,
        })
        .signers([liqInvestor])
        .rpc();

      // Draw down most of the vault balance
      const vaultAccount = await program.account.creditVault.fetch(vault);
      const depositVaultInfo = await getAccount(connection, depositVault);
      const availableLiquidity =
        BigInt(depositVaultInfo.amount.toString()) -
        BigInt(vaultAccount.totalPendingDeposits.toString());
      const drawAmount = availableLiquidity - BigInt(1);

      if (drawAmount > BigInt(0)) {
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
        BigInt(depositAmount.toString()) * BigInt(2),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [frozenInvRequest] = getInvestmentRequestPDA(frozenInvestor.publicKey);
      [frozenRedRequest] = getRedemptionRequestPDA(frozenInvestor.publicKey);
      [frozenInvAttestation] = getAttestationPDA(
        frozenInvestor.publicKey,
        attester.publicKey
      );
      [frozenInvFrozenAccount] = getFrozenAccountPDA(frozenInvestor.publicKey);
      [frozenInvClaimableTokens] = getClaimableTokensPDA(
        frozenInvestor.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: frozenInvAttestation,
          subject: frozenInvestor.publicKey,
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
          attestation: frozenInvAttestation,
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
        tempInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: tempAttestation,
          subject: tempInvestor.publicKey,
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
        tempInvestor2.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: tempAttestation2,
          subject: tempInvestor2.publicKey,
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

  describe("Oracle Staleness Gate", () => {
    let staleInvestor: Keypair;
    let staleInvestorTokenAccount: PublicKey;
    let staleInvestmentRequest: PublicKey;
    let staleAttestation: PublicKey;

    before(async () => {
      staleInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        staleInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        staleInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      staleInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        staleInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [staleInvestmentRequest] = getInvestmentRequestPDA(
        staleInvestor.publicKey
      );
      [staleAttestation] = getAttestationPDA(
        staleInvestor.publicKey,
        attester.publicKey
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: staleAttestation,
          subject: staleInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Request deposit while oracle is fresh
      await program.methods
        .requestDeposit(depositAmount)
        .accountsPartial({
          investor: staleInvestor.publicKey,
          vault,
          investmentRequest: staleInvestmentRequest,
          investorTokenAccount: staleInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: staleAttestation,
          frozenCheck: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([staleInvestor])
        .rpc();
    });

    it("rejects approve_deposit when oracle is stale", async () => {
      // Set oracle timestamp to a value older than maxStaleness (3600s)
      const staleTimestamp = new BN(1_000_000);

      await oracleProgram.methods
        .updateTimestamp(staleTimestamp)
        .accountsPartial({
          authority: payer.publicKey,
          oracleData: navOracle,
          vault: vault,
        })
        .rpc();

      try {
        await program.methods
          .approveDeposit()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            investmentRequest: staleInvestmentRequest,
            investor: staleInvestor.publicKey,
            navOracle,
            attestation: staleAttestation,
            frozenCheck: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OracleStale");
      }
    });

    it("approve_deposit succeeds after oracle timestamp restored", async () => {
      // Restore oracle to current time by re-setting the price (set_price writes current timestamp)
      await oracleProgram.methods
        .setPrice(PRICE_SCALE)
        .accountsPartial({
          authority: payer.publicKey,
          oracleData: navOracle,
          vault: vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: staleInvestmentRequest,
          investor: staleInvestor.publicKey,
          navOracle,
          attestation: staleAttestation,
          frozenCheck: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request = await program.account.investmentRequest.fetch(
        staleInvestmentRequest
      );
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} })
      );

      // Clean up: claim deposit
      const staleSharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        staleInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: staleInvestor.publicKey,
          vault,
          investmentRequest: staleInvestmentRequest,
          sharesMint,
          investorSharesAccount: staleSharesAta.address,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          attestation: staleAttestation,
        })
        .signers([staleInvestor])
        .rpc();
    });
  });

  describe("Attestation Expiry Gate", () => {
    let expInvestor: Keypair;
    let expInvestorTokenAccount: PublicKey;
    let expInvestmentRequest: PublicKey;
    let expAttestation: PublicKey;

    before(async () => {
      expInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        expInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        expInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      expInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        expInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [expInvestmentRequest] = getInvestmentRequestPDA(expInvestor.publicKey);

      // Create attestation with type=1 so PDA is unique, and expires_at in the past
      [expAttestation] = getAttestationPDA(
        expInvestor.publicKey,
        attester.publicKey,
        1
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          1,
          [66, 82],
          new BN(1_000_000) // far in the past
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: expAttestation,
          subject: expInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("rejects request_deposit with expired attestation", async () => {
      try {
        await program.methods
          .requestDeposit(depositAmount)
          .accountsPartial({
            investor: expInvestor.publicKey,
            vault,
            investmentRequest: expInvestmentRequest,
            investorTokenAccount: expInvestorTokenAccount,
            depositVault,
            assetMint,
            attestation: expAttestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([expInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AttestationExpired");
      }
    });
  });

  describe("Attestation Revocation Gate", () => {
    let revInvestor: Keypair;
    let revInvestorTokenAccount: PublicKey;
    let revInvestmentRequest: PublicKey;
    let revAttestation: PublicKey;

    before(async () => {
      revInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        revInvestor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        revInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      revInvestorTokenAccount = ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        revInvestorTokenAccount,
        payer.publicKey,
        BigInt(depositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      [revInvestmentRequest] = getInvestmentRequestPDA(revInvestor.publicKey);
      [revAttestation] = getAttestationPDA(
        revInvestor.publicKey,
        attester.publicKey
      );

      // Create valid attestation (expires_at=0 means no expiry)
      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(0)
        )
        .accountsPartial({
          authority: payer.publicKey,
          attestation: revAttestation,
          subject: revInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Revoke the attestation
      await attestationMockProgram.methods
        .revokeAttestation()
        .accountsPartial({
          authority: payer.publicKey,
          attestation: revAttestation,
        })
        .rpc();
    });

    it("rejects request_deposit with revoked attestation", async () => {
      try {
        await program.methods
          .requestDeposit(depositAmount)
          .accountsPartial({
            investor: revInvestor.publicKey,
            vault,
            investmentRequest: revInvestmentRequest,
            investorTokenAccount: revInvestorTokenAccount,
            depositVault,
            assetMint,
            attestation: revAttestation,
            frozenCheck: null,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([revInvestor])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AttestationRevoked");
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
