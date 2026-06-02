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
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { expect } from "chai";
import { Svs11 } from "../target/types/svs_11";
import { MockOracle } from "../target/types/mock_oracle";
import { MockSas as MockAttestation } from "../target/types/mock_sas";
import { NavOracle } from "../target/types/nav_oracle";
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
} from "../sdk/core/src/credit-vault-pda";
import { resolveHookExtras } from "./helpers/hook-mint";

const ATTESTATION_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);
// compliance-hook program ID (used by initialize_pool to bind the TransferHook).
// initialize_pool CPIs into this program for the EAML init + reads its PDAs.
const COMPLIANCE_HOOK_PROGRAM_ID = new PublicKey(
  "6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P",
);
const PRICE_SCALE = new BN(1_000_000_000);
const FAR_FUTURE_EXPIRY = new BN(4_102_444_800); // ~year 2100

describe("svs-11 (Credit Markets Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs11 as Program<Svs11>;
  const oracleProgram = anchor.workspace.MockOracle as Program<MockOracle>;
  const navOracleProgram = anchor.workspace.NavOracle as Program<NavOracle>;
  const attestationMockProgram = anchor.workspace
    .MockSas as Program<MockAttestation>;
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
  let mockOracleData: PublicKey;
  let navAccount!: PublicKey;
  let navPublisher!: Keypair;
  let navSequence = 0n;
  let investorTokenAccount: PublicKey;
  let investorSharesAccount: PublicKey;
  let investmentRequest: PublicKey;
  let redemptionRequest: PublicKey;
  let claimableTokens: PublicKey;
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

  const getInvestmentRequestPDA = (
    investorKey: PublicKey,
  ): [PublicKey, number] =>
    getInvestmentRequestAddress(program.programId, vault, investorKey);

  const getRedemptionRequestPDA = (
    investorKey: PublicKey,
  ): [PublicKey, number] =>
    getRedemptionRequestAddress(program.programId, vault, investorKey);

  const getClaimableTokensPDA = (investorKey: PublicKey): [PublicKey, number] =>
    getClaimableTokensAddress(program.programId, vault, investorKey);

  const getOracleDataPDA = (vaultPda: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("oracle"), vaultPda.toBuffer()],
      oracleProgram.programId,
    );
  };

  const getNavAccountPDA = (vaultPda: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nav_oracle"), vaultPda.toBuffer()],
      navOracleProgram.programId,
    );
  };

  const getAttestationPDA = (
    subject: PublicKey,
    issuer: PublicKey,
    attestationType: number = 0,
  ): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        subject.toBuffer(),
        issuer.toBuffer(),
        Buffer.from([attestationType]),
      ],
      ATTESTATION_PROGRAM_ID,
    );
  };

  function buildNavSigningPayload(fields: {
    pool: PublicKey;
    navNet: bigint;
    navGross: bigint;
    terBps: number;
    lossBps: number;
    navType: number;
    timestamp: bigint;
    sequence: bigint;
    publisher: PublicKey;
    merkleRoot: Buffer;
  }): Buffer {
    const buf = Buffer.alloc(133);
    let off = 0;
    fields.pool.toBuffer().copy(buf, off);
    off += 32;
    buf.writeBigUInt64LE(fields.navNet, off);
    off += 8;
    buf.writeBigUInt64LE(fields.navGross, off);
    off += 8;
    buf.writeUInt16LE(fields.terBps, off);
    off += 2;
    buf.writeUInt16LE(fields.lossBps, off);
    off += 2;
    buf.writeUInt8(fields.navType, off);
    off += 1;
    buf.writeBigInt64LE(fields.timestamp, off);
    off += 8;
    buf.writeBigUInt64LE(fields.sequence, off);
    off += 8;
    fields.publisher.toBuffer().copy(buf, off);
    off += 32;
    fields.merkleRoot.copy(buf, off);
    off += 32;
    return buf.subarray(0, off);
  }

  async function publishNav(price: BN = PRICE_SCALE): Promise<void> {
    navSequence += 1n;
    const merkleRoot = Buffer.alloc(32, Number(navSequence % 255n));
    const navNet = BigInt(price.toString());
    const navGross = navNet;
    const terBps = 0;
    const lossBps = 0;
    // Stamp from the on-chain clock (slightly in the past), not wall-clock: the
    // validator clock can lag wall-time, and read_oracle rejects any future
    // timestamp (age < 0), so a wall-clock stamp would look stale at approve.
    const onChainTime = await connection.getBlockTime(
      await connection.getSlot(),
    );
    const baseTime = onChainTime ?? Math.floor(Date.now() / 1000);
    // -30s: comfortably in the past for the reader (age >= 0) yet inside the
    // writer's [now-60, now+60] window, robust to getBlockTime estimation noise.
    const timestamp = BigInt(baseTime - 30);

    const payload = buildNavSigningPayload({
      pool: vault,
      navNet,
      navGross,
      terBps,
      lossBps,
      navType: 0,
      timestamp,
      sequence: navSequence,
      publisher: navPublisher.publicKey,
      merkleRoot,
    });
    const signature = nacl.sign.detached(payload, navPublisher.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: navPublisher.publicKey.toBytes(),
      message: payload,
      signature,
    });
    const updateIx = await navOracleProgram.methods
      .update({
        navNet: new BN(navNet.toString()),
        navGross: new BN(navGross.toString()),
        terBps,
        lossBps,
        navType: 0,
        timestamp: new BN(timestamp.toString()),
        sequence: new BN(navSequence.toString()),
        loanTapeMerkleRoot: Array.from(merkleRoot),
        signature: Array.from(signature),
      })
      .accountsPartial({
        pool: vault,
        navAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    await provider.sendAndConfirm(tx, []);
  }

  // Hook extras for the cPOOL `transfer_checked` invoked from
  // request_redeem (source = investor, destination = vault PDA — the
  // owner of redemption_escrow). Computed per-call because the
  // source-side attestation PDA depends on the investor pubkey.
  // The result is appended to the request_redeem ix via
  // `.remainingAccounts(...)` so svs-11's CPI extension via
  // `add_extra_accounts_for_execute_cpi` can reach the hook program +
  // EAML PDA + resolved EAML extras when invoking Token-2022.
  const requestRedeemHookExtras = (investorKey: PublicKey) => {
    const [poolPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_policy_test"), vault.toBuffer()],
      program.programId,
    );
    return resolveHookExtras({
      complianceHookProgramId: COMPLIANCE_HOOK_PROGRAM_ID,
      mint: sharesMint,
      sourceOwner: investorKey,
      destinationOwner: vault,
      permissioned: true,
      attestationProgram: attestationProgramId,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: 0,
      poolPolicy: poolPolicyPda,
    });
  };

  // Hook extras for cancel_redeem's cPOOL transfer (source = vault,
  // destination = investor — opposite direction of request_redeem).
  // The source-side attestation PDA is now the vault's system
  // attestation, and destination-side is the investor's.
  const cancelRedeemHookExtras = (investorKey: PublicKey) => {
    const [poolPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_policy_test"), vault.toBuffer()],
      program.programId,
    );
    return resolveHookExtras({
      complianceHookProgramId: COMPLIANCE_HOOK_PROGRAM_ID,
      mint: sharesMint,
      sourceOwner: vault,
      destinationOwner: investorKey,
      permissioned: true,
      attestationProgram: attestationProgramId,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: 0,
      poolPolicy: poolPolicyPda,
    });
  };

  before(async () => {
    manager = Keypair.generate();
    investor = Keypair.generate();
    attester = Keypair.generate();
    attestationProgramId = ATTESTATION_PROGRAM_ID;

    // Fund manager and investor
    const airdropManager = await connection.requestAirdrop(
      manager.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(airdropManager);

    const airdropInvestor = await connection.requestAirdrop(
      investor.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL,
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
      TOKEN_PROGRAM_ID,
    );

    // Derive PDAs
    [vault] = getVaultPDA();
    [sharesMint] = getSharesMintPDA();
    [redemptionEscrow] = getRedemptionEscrowPDA();
    [mockOracleData] = getOracleDataPDA(vault);
    [navAccount] = getNavAccountPDA(vault);
    navPublisher = Keypair.generate();
    [investmentRequest] = getInvestmentRequestPDA(investor.publicKey);
    [redemptionRequest] = getRedemptionRequestPDA(investor.publicKey);
    [claimableTokens] = getClaimableTokensPDA(investor.publicKey);
    [attestation] = getAttestationPDA(investor.publicKey, attester.publicKey);

    depositVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      TOKEN_PROGRAM_ID,
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
      TOKEN_PROGRAM_ID,
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
      TOKEN_PROGRAM_ID,
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
      TOKEN_PROGRAM_ID,
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
      TOKEN_PROGRAM_ID,
    );

    // Set oracle price (1:1)
    await oracleProgram.methods
      .setPrice(PRICE_SCALE)
      .accountsPartial({
        authority: payer.publicKey,
        oracleData: mockOracleData,
        vault: vault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Create attestation for investor
    await attestationMockProgram.methods
      .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
      // initialize_pool binds the cPOOL mint's
      // Token-2022 TransferHook extension to COMPLIANCE_HOOK_PROGRAM_ID.
      // The compliance-hook PDAs (MintConfig + EAML) and infrastructure
      // attestations are initialized by separate follow-up txs in the
      // deployment runbook — they are NOT part of
      // initialize_pool's accounts struct.
      void COMPLIANCE_HOOK_PROGRAM_ID; // referenced via env at deploy time

      await program.methods
        .initializePool(vaultId, minimumInvestment, maxStaleness)
        .accountsPartial({
          authority: payer.publicKey,
          manager: manager.publicKey,
          vault,
          assetMint,
          sharesMint,
          depositVault,
          redemptionEscrow,
          navOracle: mockOracleData,
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

      await navOracleProgram.methods
        .initialize({ maxDeviationBps: 500 })
        .accountsPartial({
          pool: vault,
          navAccount,
          publisher: navPublisher.publicKey,
          payer: payer.publicKey,
        })
        .rpc();

      await publishNav();

      // Initialize the singleton compliance-hook SanctionsList if it
      // doesn't already exist. svs-11.ts runs before
      // compliance-hook.spec.ts in the anchor test order, so this is
      // the first place that needs the SanctionsList PDA. Idempotent
      // against re-runs (and against compliance-hook.spec.ts's own
      // setup) by tolerating "already in use".
      try {
        const [sanctionsListPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("sanctions_list")],
          COMPLIANCE_HOOK_PROGRAM_ID,
        );
        const complianceHookIdl = require("../target/idl/compliance_hook.json");
        const complianceHookProg = new anchor.Program(
          complianceHookIdl,
          provider,
        );
        await complianceHookProg.methods
          .initializeSanctionsList()
          .accountsPartial({
            sanctionsList: sanctionsListPda,
            authority: payer.publicKey,
            payer: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (_err) {
        // already initialized — fine
      }

      // Bootstrap compliance-hook PDAs for the cPOOL shares mint.
      // This is the operator-runbook step that initializes
      // MintConfig + EAML on cPOOL — without it, every cPOOL transfer
      // fails because Token-2022 invokes the hook (which is bound by
      // initialize_pool) but the hook's MintConfig/EAML PDAs don't
      // exist. Permissioned mode requires non-default trust anchors.
      const [poolPolicyPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool_policy_test"), vault.toBuffer()],
        program.programId,
      );
      const [mintConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_config"), sharesMint.toBuffer()],
        COMPLIANCE_HOOK_PROGRAM_ID,
      );
      const [eamlPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), sharesMint.toBuffer()],
        COMPLIANCE_HOOK_PROGRAM_ID,
      );
      await program.methods
        .bootstrapSharesCompliance({
          mode: { permissioned: {} },
          poolPolicy: poolPolicyPda,
          attestationProgram: attestationProgramId,
          attestationIssuer: attester.publicKey,
          requiredAttestationType: 0,
        })
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          sharesMint,
          mintConfig: mintConfigPda,
          extraAccountMetaList: eamlPda,
          complianceHookProgram: COMPLIANCE_HOOK_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Issue infrastructure attestation for the vault PDA. Permissioned
      // hooks validate BOTH transfer owners on every cPOOL transfer;
      // request_redeem moves cPOOL from investor → redemption_escrow,
      // and redemption_escrow.owner == vault. Without a vault
      // attestation, the destination-side check rejects with
      // AttestationNotFound. mock-sas accepts off-curve PDAs as
      // subjects, mirroring the wrapper-PDA system attestation pattern
      // in the deRWA flow.
      const [vaultAttestation] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("attestation"),
          vault.toBuffer(),
          attester.publicKey.toBuffer(),
          Buffer.from([0]),
        ],
        attestationProgramId,
      );
      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
        .accountsPartial({
          authority: payer.publicKey,
          attestation: vaultAttestation,
          subject: vault,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58(),
      );
      expect(vaultAccount.manager.toBase58()).to.equal(
        manager.publicKey.toBase58(),
      );
      expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58(),
      );
      expect(vaultAccount.navOracle.toBase58()).to.equal(
        mockOracleData.toBase58(),
      );
      expect(vaultAccount.oracleProgram.toBase58()).to.equal(
        oracleProgram.programId.toBase58(),
      );
      expect(vaultAccount.attester.toBase58()).to.equal(
        attester.publicKey.toBase58(),
      );
      expect(vaultAccount.attestationProgram.toBase58()).to.equal(
        attestationProgramId.toBase58(),
      );
      expect(vaultAccount.vaultId.toNumber()).to.equal(1);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
      expect(vaultAccount.minimumInvestment.toNumber()).to.equal(
        minimumInvestment.toNumber(),
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
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([investor])
        .rpc();

      const request =
        await program.account.investmentRequest.fetch(investmentRequest);
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58(),
      );
      expect(request.amountLocked.toString()).to.equal(
        depositAmount.toString(),
      );
      expect(request.sharesClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ pending: {} }),
      );

      const balanceAfter = await getAccount(connection, investorTokenAccount);
      expect(
        BigInt(balanceBefore.amount.toString()) -
          BigInt(balanceAfter.amount.toString()),
      ).to.equal(BigInt(depositAmount.toString()));

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalPendingDeposits.toString()).to.equal(
        depositAmount.toString(),
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
          oracleAccount: mockOracleData,
          attestation,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request =
        await program.account.investmentRequest.fetch(investmentRequest);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} }),
      );
      expect(request.sharesClaimable.toString()).to.equal(
        expectedShares.toString(),
      );

      const vaultAccount = await program.account.creditVault.fetch(vault);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalApprovedDeposits.toString()).to.equal(
        depositAmount.toString(),
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
        TOKEN_2022_PROGRAM_ID,
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
        TOKEN_2022_PROGRAM_ID,
      );
      expect(sharesBalance.amount.toString()).to.equal(
        expectedShares.toString(),
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [rejectInvestmentRequest] = getInvestmentRequestPDA(
        rejectInvestor.publicKey,
      );
      [rejectAttestation] = getAttestationPDA(
        rejectInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        rejectInvestorTokenAccount,
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
        rejectInvestorTokenAccount,
      );
      expect(
        BigInt(balanceAfter.amount.toString()) -
          BigInt(balanceBefore.amount.toString()),
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [cancelInvestmentRequest] = getInvestmentRequestPDA(
        cancelInvestor.publicKey,
      );
      [cancelAttestation] = getAttestationPDA(
        cancelInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([cancelInvestor])
        .rpc();
    });

    it("investor cancels pending deposit", async () => {
      // Wait so clock.unix_timestamp > requested_at (CancelTooEarly guard)
      await new Promise((r) => setTimeout(r, 4000));

      const balanceBefore = await getAccount(
        connection,
        cancelInvestorTokenAccount,
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
        cancelInvestorTokenAccount,
      );
      expect(
        BigInt(balanceAfter.amount.toString()) -
          BigInt(balanceBefore.amount.toString()),
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
        TOKEN_2022_PROGRAM_ID,
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
          assetMint,
          claimableTokens,
          attestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts(requestRedeemHookExtras(investor.publicKey))
        .signers([investor])
        .rpc();

      const request =
        await program.account.redemptionRequest.fetch(redemptionRequest);
      expect(request.investor.toBase58()).to.equal(
        investor.publicKey.toBase58(),
      );
      expect(request.sharesLocked.toString()).to.equal(
        sharesToRedeem.toString(),
      );
      expect(request.assetsClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ pending: {} }),
      );

      const sharesAfter = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
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
          oracleAccount: mockOracleData,
          attestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request =
        await program.account.redemptionRequest.fetch(redemptionRequest);
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} }),
      );
      expect(request.assetsClaimable.toString()).to.equal(
        depositAmount.toString(),
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
          BigInt(balanceBefore.amount.toString()),
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
          oracleAccount: mockOracleData,
          attestation,
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
        TOKEN_2022_PROGRAM_ID,
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
          assetMint,
          claimableTokens,
          attestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts(requestRedeemHookExtras(investor.publicKey))
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
          assetMint,
          claimableTokens,
          investorSharesAccount,
          redemptionEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(cancelRedeemHookExtras(investor.publicKey))
        .signers([investor])
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        investorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(sharesAfter.amount.toString()).to.equal(expectedShares.toString());

      const info = await connection.getAccountInfo(redemptionRequest);
      expect(info).to.be.null;
    });
  });

  describe("Credit Operations", () => {
    it("manager draws down assets", async () => {
      const depositVaultBefore = await getAccount(connection, depositVault);
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
        BigInt(depositVaultBefore.amount.toString()) -
        BigInt(drawAmount.toString());
      expect(depositVaultAccount.amount.toString()).to.equal(
        expectedBalance.toString(),
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
        new BN(100_000_000_000).toString(),
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
        newAuthority.publicKey.toBase58(),
      );

      // Transfer back
      const airdrop = await connection.requestAirdrop(
        newAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
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

    // Two-step authority transfer (the root-of-trust path). request sets a
    // pending authority without changing the live one; the NEW key must accept.
    it("request sets pending without changing authority; accept swaps", async () => {
      const newAuth = Keypair.generate();
      const air = await connection.requestAirdrop(
        newAuth.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(air);

      await program.methods
        .requestTransferAuthority(newAuth.publicKey)
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      let v = await program.account.creditVault.fetch(vault);
      expect(v.pendingAuthority.toBase58()).to.equal(
        newAuth.publicKey.toBase58(),
      );
      expect(v.authority.toBase58()).to.equal(payer.publicKey.toBase58());

      await program.methods
        .acceptAuthority()
        .accountsPartial({ newAuthority: newAuth.publicKey, vault })
        .signers([newAuth])
        .rpc();
      v = await program.account.creditVault.fetch(vault);
      expect(v.authority.toBase58()).to.equal(newAuth.publicKey.toBase58());
      expect(v.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
      );

      // Restore authority -> payer via the same two-step flow.
      await program.methods
        .requestTransferAuthority(payer.publicKey)
        .accountsPartial({ authority: newAuth.publicKey, vault })
        .signers([newAuth])
        .rpc();
      await program.methods
        .acceptAuthority()
        .accountsPartial({ newAuthority: payer.publicKey, vault })
        .rpc();
      v = await program.account.creditVault.fetch(vault);
      expect(v.authority.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("non-authority cannot request a transfer (Unauthorized)", async () => {
      const stranger = Keypair.generate();
      const air = await connection.requestAirdrop(
        stranger.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(air);
      try {
        await program.methods
          .requestTransferAuthority(stranger.publicKey)
          .accountsPartial({ authority: stranger.publicKey, vault })
          .signers([stranger])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("request while a transfer is pending is rejected; cancel clears it", async () => {
      const a = Keypair.generate();
      await program.methods
        .requestTransferAuthority(a.publicKey)
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      try {
        await program.methods
          .requestTransferAuthority(Keypair.generate().publicKey)
          .accountsPartial({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("PendingTransferExists");
      }
      await program.methods
        .cancelTransferAuthority()
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      const v = await program.account.creditVault.fetch(vault);
      expect(v.pendingAuthority.toBase58()).to.equal(
        PublicKey.default.toBase58(),
      );
    });

    it("a non-pending signer cannot accept (InvalidPendingAuthority)", async () => {
      const pending = Keypair.generate();
      const wrong = Keypair.generate();
      const air = await connection.requestAirdrop(
        wrong.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(air);
      await program.methods
        .requestTransferAuthority(pending.publicKey)
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      try {
        await program.methods
          .acceptAuthority()
          .accountsPartial({ newAuthority: wrong.publicKey, vault })
          .signers([wrong])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidPendingAuthority");
      }
      await program.methods
        .cancelTransferAuthority()
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
    });

    it("cancel with no pending transfer is rejected (NoPendingTransfer)", async () => {
      try {
        await program.methods
          .cancelTransferAuthority()
          .accountsPartial({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("NoPendingTransfer");
      }
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
        newManager.publicKey.toBase58(),
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
        newAttester.publicKey.toBase58(),
      );
      expect(vaultAccount.attestationProgram.toBase58()).to.equal(
        newAttestationProgram.toBase58(),
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      const [zeroRequest] = getInvestmentRequestPDA(zeroInvestor.publicKey);
      const [zeroAttestation] = getAttestationPDA(
        zeroInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      const [smallRequest] = getInvestmentRequestPDA(smallInvestor.publicKey);
      const [smallAttestation] = getAttestationPDA(
        smallInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(airdrop);

      const [zeroRedemption] = getRedemptionRequestPDA(zeroRedeemer.publicKey);
      const [zeroAttestation] = getAttestationPDA(
        zeroRedeemer.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        TOKEN_2022_PROGRAM_ID,
      );
      const zeroSharesAccount = zeroSharesAta.address;
      const [zeroClaimable] = getClaimableTokensPDA(zeroRedeemer.publicKey);

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
            assetMint,
            claimableTokens: zeroClaimable,
            attestation: zeroAttestation,
            assetTokenProgram: TOKEN_PROGRAM_ID,
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [statusInvestmentRequest] = getInvestmentRequestPDA(
        statusInvestor.publicKey,
      );
      [statusAttestation] = getAttestationPDA(
        statusInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        TOKEN_2022_PROGRAM_ID,
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
          oracleAccount: mockOracleData,
          attestation: statusAttestation,
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
            oracleAccount: mockOracleData,
            attestation: statusAttestation,
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
        statusInvestor.publicKey,
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
          oracleAccount: mockOracleData,
          attestation: statusAttestation,
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
      );
      liqInvestorTokenAccount = ata.address;

      const liqDepositAmount = depositAmount.mul(new BN(20));

      await mintTo(
        connection,
        payer,
        assetMint,
        liqInvestorTokenAccount,
        payer.publicKey,
        BigInt(liqDepositAmount.toString()),
        [],
        undefined,
        TOKEN_PROGRAM_ID,
      );

      [liqInvestmentRequest] = getInvestmentRequestPDA(liqInvestor.publicKey);
      [liqRedemptionRequest] = getRedemptionRequestPDA(liqInvestor.publicKey);
      [liqClaimableTokens] = getClaimableTokensPDA(liqInvestor.publicKey);
      [liqAttestation] = getAttestationPDA(
        liqInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        TOKEN_2022_PROGRAM_ID,
      );
      liqInvestorSharesAccount = liqSharesAta.address;

      // Deposit + approve + claim with large amount so liqInvestor dominates total_shares
      await program.methods
        .requestDeposit(liqDepositAmount)
        .accountsPartial({
          investor: liqInvestor.publicKey,
          vault,
          investmentRequest: liqInvestmentRequest,
          investorTokenAccount: liqInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: liqAttestation,
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
          oracleAccount: mockOracleData,
          attestation: liqAttestation,
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

      // Draw down most of the idle liquidity to deploy it as off-chain credit.
      // There is NO deviation-bps workaround any more: the vault-derived
      // books-vs-oracle deviation guard was removed (total_assets tracks idle
      // cash, AUM = shares * oracle price), so approve-after-drawdown is no
      // longer blocked by a false deviation trip — it now fails only on the
      // real liquidity boundary, which is exactly what this test exercises.
      const vaultAccount = await program.account.creditVault.fetch(vault);
      const depositVaultInfo = await getAccount(connection, depositVault);
      const available =
        BigInt(depositVaultInfo.amount.toString()) -
        BigInt(vaultAccount.totalPendingDeposits.toString()) -
        BigInt(vaultAccount.totalApprovedDeposits.toString());
      // Deploy 90% of idle liquidity so the full-share redeem payout exceeds
      // what remains in the vault → InsufficientLiquidity on approve_redeem.
      const drawAmount = (available * BigInt(90)) / BigInt(100);

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
        TOKEN_2022_PROGRAM_ID,
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
          assetMint,
          claimableTokens: liqClaimableTokens,
          attestation: liqAttestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts(requestRedeemHookExtras(liqInvestor.publicKey))
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
            oracleAccount: mockOracleData,
            attestation: liqAttestation,
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      const [tempRequest] = getInvestmentRequestPDA(tempInvestor.publicKey);
      const [tempAttestation] = getAttestationPDA(
        tempInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
            oracleAccount: mockOracleData,
            attestation: tempAttestation,
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      const [tempRequest2] = getInvestmentRequestPDA(tempInvestor2.publicKey);
      const [tempAttestation2] = getAttestationPDA(
        tempInvestor2.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [staleInvestmentRequest] = getInvestmentRequestPDA(
        staleInvestor.publicKey,
      );
      [staleAttestation] = getAttestationPDA(
        staleInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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
          oracleData: mockOracleData,
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
            oracleAccount: mockOracleData,
            attestation: staleAttestation,
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
      // Restore oracle to current time with price matching vault's expected price
      const vaultState = await program.account.creditVault.fetch(vault);
      let oraclePrice = PRICE_SCALE;
      if (
        vaultState.totalShares.toNumber() > 0 &&
        vaultState.totalAssets.toNumber() > 0
      ) {
        oraclePrice = new BN(
          (
            (BigInt(vaultState.totalAssets.toString()) *
              BigInt(PRICE_SCALE.toString())) /
            BigInt(vaultState.totalShares.toString())
          ).toString(),
        );
      }
      await oracleProgram.methods
        .setPrice(oraclePrice)
        .accountsPartial({
          authority: payer.publicKey,
          oracleData: mockOracleData,
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
          oracleAccount: mockOracleData,
          attestation: staleAttestation,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      const request = await program.account.investmentRequest.fetch(
        staleInvestmentRequest,
      );
      expect(JSON.stringify(request.status)).to.equal(
        JSON.stringify({ approved: {} }),
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
        TOKEN_2022_PROGRAM_ID,
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [expInvestmentRequest] = getInvestmentRequestPDA(expInvestor.publicKey);

      // Valid required type (0) with expires_at in the past, so expiry is the
      // ONLY failing dimension. The PDA is already unique via expInvestor's
      // subject — no need to vary the type.
      [expAttestation] = getAttestationPDA(
        expInvestor.publicKey,
        attester.publicKey,
        0,
      );

      await attestationMockProgram.methods
        .createAttestation(
          attester.publicKey,
          0,
          [66, 82],
          new BN(1_000_000), // far in the past
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
        5 * anchor.web3.LAMPORTS_PER_SOL,
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
        TOKEN_PROGRAM_ID,
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
        TOKEN_PROGRAM_ID,
      );

      [revInvestmentRequest] = getInvestmentRequestPDA(revInvestor.publicKey);
      [revAttestation] = getAttestationPDA(
        revInvestor.publicKey,
        attester.publicKey,
      );

      // Create valid attestation with far-future expiry
      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
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

  describe("Redeem Rejection (hook extras)", () => {
    let rejInvestor: Keypair;
    let rejInvestorTokenAccount: PublicKey;
    let rejInvestorSharesAccount: PublicKey;
    let rejInvRequest: PublicKey;
    let rejRedRequest: PublicKey;
    let rejClaimableTokens: PublicKey;
    let rejAttestation: PublicKey;
    let rejSharesBeforeReq: bigint;

    before(async () => {
      rejInvestor = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        rejInvestor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(airdrop);

      [rejInvRequest] = getInvestmentRequestPDA(rejInvestor.publicKey);
      [rejRedRequest] = getRedemptionRequestPDA(rejInvestor.publicKey);
      [rejClaimableTokens] = getClaimableTokensPDA(rejInvestor.publicKey);
      [rejAttestation] = getAttestationPDA(
        rejInvestor.publicKey,
        attester.publicKey,
      );

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
        .accountsPartial({
          authority: payer.publicKey,
          attestation: rejAttestation,
          subject: rejInvestor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const investorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        rejInvestor.publicKey,
      );
      rejInvestorTokenAccount = investorAta.address;
      const rejDepositAmount = new BN(1_000_000);
      await mintTo(
        connection,
        payer,
        assetMint,
        rejInvestorTokenAccount,
        payer,
        rejDepositAmount.toNumber(),
      );
      const sharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        rejInvestor.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      rejInvestorSharesAccount = sharesAta.address;

      try {
        await program.methods
          .openInvestmentWindow()
          .accountsPartial({ manager: manager.publicKey, vault })
          .signers([manager])
          .rpc();
      } catch (_) {
        // Already open.
      }

      await program.methods
        .requestDeposit(rejDepositAmount)
        .accountsPartial({
          investor: rejInvestor.publicKey,
          vault,
          investmentRequest: rejInvRequest,
          investorTokenAccount: rejInvestorTokenAccount,
          depositVault,
          assetMint,
          attestation: rejAttestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([rejInvestor])
        .rpc();
      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: rejInvRequest,
          investor: rejInvestor.publicKey,
          sharesMint,
          investorSharesAccount: rejInvestorSharesAccount,
          depositVault,
          assetMint,
          oracleAccount: mockOracleData,
          attestation: rejAttestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();
      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: rejInvestor.publicKey,
          vault,
          investmentRequest: rejInvRequest,
          sharesMint,
          investorSharesAccount: rejInvestorSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          attestation: rejAttestation,
        })
        .signers([rejInvestor])
        .rpc();

      const claimed = await getAccount(
        connection,
        rejInvestorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      rejSharesBeforeReq = claimed.amount;

      await program.methods
        .requestRedeem(new BN(rejSharesBeforeReq.toString()))
        .accountsPartial({
          investor: rejInvestor.publicKey,
          vault,
          redemptionRequest: rejRedRequest,
          sharesMint,
          investorSharesAccount: rejInvestorSharesAccount,
          redemptionEscrow,
          assetMint,
          claimableTokens: rejClaimableTokens,
          attestation: rejAttestation,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts(requestRedeemHookExtras(rejInvestor.publicKey))
        .signers([rejInvestor])
        .rpc();
    });

    it("reject_redeem returns escrowed shares through the transfer hook", async () => {
      await program.methods
        .rejectRedeem(0)
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          redemptionRequest: rejRedRequest,
          investor: rejInvestor.publicKey,
          sharesMint,
          assetMint,
          claimableTokens: rejClaimableTokens,
          investorSharesAccount: rejInvestorSharesAccount,
          redemptionEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(cancelRedeemHookExtras(rejInvestor.publicKey))
        .signers([manager])
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        rejInvestorSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect(sharesAfter.amount.toString()).to.equal(
        rejSharesBeforeReq.toString(),
      );

      const info = await connection.getAccountInfo(rejRedRequest);
      expect(info).to.be.null;
    });
  });

  describe("Protocol-level compliance", () => {
    // Single source of truth: freeze + sanctions live in compliance-hook.
    // mint_to (claim_deposit) and burn (approve_redeem) bypass the
    // Token-2022 TransferHook, so SVS-11 asserts compliance directly.
    let complianceHook: anchor.Program;
    let sanctionsListPda: PublicKey;

    const frozenPda = (wallet: PublicKey): PublicKey =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("frozen"), wallet.toBuffer()],
        COMPLIANCE_HOOK_PROGRAM_ID,
      )[0];

    before(async () => {
      const complianceHookIdl = require("../target/idl/compliance_hook.json");
      complianceHook = new anchor.Program(complianceHookIdl, provider);
      [sanctionsListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("sanctions_list")],
        COMPLIANCE_HOOK_PROGRAM_ID,
      );
    });

    async function provisionApprovedDeposit(
      inv: Keypair,
    ): Promise<{ invRequest: PublicKey; sharesAccount: PublicKey; att: PublicKey }> {
      const airdrop = await connection.requestAirdrop(
        inv.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(airdrop);

      const [invRequest] = getInvestmentRequestPDA(inv.publicKey);
      const [att] = getAttestationPDA(inv.publicKey, attester.publicKey);

      await attestationMockProgram.methods
        .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
        .accountsPartial({
          authority: payer.publicKey,
          attestation: att,
          subject: inv.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const investorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        inv.publicKey,
      );
      const amount = new BN(1_000_000);
      await mintTo(
        connection,
        payer,
        assetMint,
        investorAta.address,
        payer,
        amount.toNumber(),
      );
      const sharesAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        inv.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      try {
        await program.methods
          .openInvestmentWindow()
          .accountsPartial({ manager: manager.publicKey, vault })
          .signers([manager])
          .rpc();
      } catch (_) {
        // Already open.
      }

      await program.methods
        .requestDeposit(amount)
        .accountsPartial({
          investor: inv.publicKey,
          vault,
          investmentRequest: invRequest,
          investorTokenAccount: investorAta.address,
          depositVault,
          assetMint,
          attestation: att,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([inv])
        .rpc();
      await program.methods
        .approveDeposit()
        .accountsPartial({
          manager: manager.publicKey,
          vault,
          investmentRequest: invRequest,
          investor: inv.publicKey,
          sharesMint,
          investorSharesAccount: sharesAta.address,
          depositVault,
          assetMint,
          oracleAccount: mockOracleData,
          attestation: att,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([manager])
        .rpc();

      return { invRequest, sharesAccount: sharesAta.address, att };
    }

    it("claim_deposit fails when the investor wallet is frozen at the protocol level", async () => {
      const inv = Keypair.generate();
      const { invRequest, sharesAccount, att } =
        await provisionApprovedDeposit(inv);

      const frozenAccount = frozenPda(inv.publicKey);
      await complianceHook.methods
        .freezeAccount()
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: payer.publicKey,
          ownerToFreeze: inv.publicKey,
          frozenAccount,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      try {
        await program.methods
          .claimDeposit()
          .accountsPartial({
            investor: inv.publicKey,
            vault,
            investmentRequest: invRequest,
            sharesMint,
            investorSharesAccount: sharesAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            attestation: att,
          })
          .signers([inv])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AccountFrozen");
      }

      await complianceHook.methods
        .unfreezeAccount()
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: payer.publicKey,
          ownerToUnfreeze: inv.publicKey,
          frozenAccount,
          rentRecipient: payer.publicKey,
        })
        .signers([payer])
        .rpc();
    });

    it("approve_redeem fails when the investor wallet is sanctioned", async () => {
      const inv = Keypair.generate();
      const { invRequest, sharesAccount, att } =
        await provisionApprovedDeposit(inv);

      await program.methods
        .claimDeposit()
        .accountsPartial({
          investor: inv.publicKey,
          vault,
          investmentRequest: invRequest,
          sharesMint,
          investorSharesAccount: sharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          attestation: att,
        })
        .signers([inv])
        .rpc();

      const [redRequest] = getRedemptionRequestPDA(inv.publicKey);
      const [claimable] = getClaimableTokensPDA(inv.publicKey);
      const sharesHeld = await getAccount(
        connection,
        sharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      await program.methods
        .requestRedeem(new BN(sharesHeld.amount.toString()))
        .accountsPartial({
          investor: inv.publicKey,
          vault,
          redemptionRequest: redRequest,
          sharesMint,
          investorSharesAccount: sharesAccount,
          redemptionEscrow,
          assetMint,
          claimableTokens: claimable,
          attestation: att,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .remainingAccounts(requestRedeemHookExtras(inv.publicKey))
        .signers([inv])
        .rpc();

      await complianceHook.methods
        .updateSanctionsList([inv.publicKey], [])
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: payer.publicKey,
        })
        .signers([payer])
        .rpc();

      try {
        await program.methods
          .approveRedeem()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            redemptionRequest: redRequest,
            investor: inv.publicKey,
            sharesMint,
            redemptionEscrow,
            depositVault,
            assetMint,
            claimableTokens: claimable,
            oracleAccount: mockOracleData,
            attestation: att,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("SanctionedAddress");
      }

      await complianceHook.methods
        .updateSanctionsList([], [inv.publicKey])
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: payer.publicKey,
        })
        .signers([payer])
        .rpc();
    });
  });

  describe("NavOracle publisher rotation (D6: unified authority)", () => {
    // rotate_publisher reads the pool's live CreditVault.authority (payer)
    // from pool bytes 8..40; key_rotation_authority is gone. The NavAccount
    // here was initialized in setup against this real vault.
    it("rejects rotation by a non-authority signer", async () => {
      const newPublisher = Keypair.generate();
      try {
        await navOracleProgram.methods
          .rotatePublisher()
          .accountsPartial({
            pool: vault,
            navAccount,
            authority: manager.publicKey,
            newPublisher: newPublisher.publicKey,
          })
          .signers([manager])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        const msg =
          (err?.logs?.join("\n") ?? "") + "\n" + (err?.message ?? "");
        expect(msg).to.match(/UnauthorizedRotation|7003/i);
      }
    });

    it("rotates the publisher when signed by the live CreditVault.authority", async () => {
      const newPublisher = Keypair.generate();
      await navOracleProgram.methods
        .rotatePublisher()
        .accountsPartial({
          pool: vault,
          navAccount,
          authority: payer.publicKey,
          newPublisher: newPublisher.publicKey,
        })
        .signers([payer])
        .rpc();

      const nav = await navOracleProgram.account.navAccount.fetch(navAccount);
      expect(nav.publisher.toBase58()).to.equal(
        newPublisher.publicKey.toBase58(),
      );
    });
  });

  describe("set_oracle (immediate, authority-gated)", () => {
    // set_oracle repoints the NAV oracle in one authority-gated tx, fail-closed
    // on every check, seeding the replay floor from the incoming oracle's current
    // sequence. Negative cases must NOT mutate vault.nav_oracle.
    it("non-authority signer is rejected (Unauthorized), no mutation", async () => {
      const stranger = Keypair.generate();
      const sig = await connection.requestAirdrop(
        stranger.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig);
      const before = (await program.account.creditVault.fetch(vault)).navOracle;
      try {
        await program.methods
          .setOracle(navAccount, navOracleProgram.programId)
          .accountsPartial({
            authority: stranger.publicKey,
            vault,
            newOracleProgramAccount: navOracleProgram.programId,
            newOracleAccount: navAccount,
          })
          .signers([stranger])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
      const after = (await program.account.creditVault.fetch(vault)).navOracle;
      expect(after.toBase58()).to.equal(before.toBase58());
    });

    it("rejects when oracle account key != new_oracle arg (InvalidAddress)", async () => {
      const stray = Keypair.generate().publicKey;
      try {
        await program.methods
          .setOracle(stray, navOracleProgram.programId) // arg stray; account is navAccount
          .accountsPartial({
            authority: payer.publicKey,
            vault,
            newOracleProgramAccount: navOracleProgram.programId,
            newOracleAccount: navAccount,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidAddress");
      }
    });

    it("rejects a non-executable program account (OracleInvalidProgram)", async () => {
      // mockOracleData is a data account (not executable): key-match passes,
      // the executable check fails.
      try {
        await program.methods
          .setOracle(navAccount, mockOracleData)
          .accountsPartial({
            authority: payer.publicKey,
            vault,
            newOracleProgramAccount: mockOracleData,
            newOracleAccount: navAccount,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OracleInvalidProgram");
      }
    });

    it("rejects an oracle account not owned by the program (OracleInvalidProgram)", async () => {
      // mockOracleData is owned by mock-oracle, not nav-oracle.
      try {
        await program.methods
          .setOracle(mockOracleData, navOracleProgram.programId)
          .accountsPartial({
            authority: payer.publicKey,
            vault,
            newOracleProgramAccount: navOracleProgram.programId,
            newOracleAccount: mockOracleData,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OracleInvalidProgram");
      }
    });

    it("authority repoints the oracle; replay floor seeded from incoming sequence", async () => {
      const navState = await navOracleProgram.account.navAccount.fetch(
        navAccount,
      );
      await program.methods
        .setOracle(navAccount, navOracleProgram.programId)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          newOracleProgramAccount: navOracleProgram.programId,
          newOracleAccount: navAccount,
        })
        .rpc();

      const v = await program.account.creditVault.fetch(vault);
      expect(v.navOracle.toBase58()).to.equal(navAccount.toBase58());
      expect(v.oracleProgram.toBase58()).to.equal(
        navOracleProgram.programId.toBase58(),
      );
      // P2: floor adopts the incoming oracle's current sequence (not blanket 0).
      expect(v.lastSeenNavSequence.toString()).to.equal(
        navState.sequence.toString(),
      );
    });

    it("swapping to an unpublished oracle (sequence 0) seeds the floor to 0", async () => {
      // mock-oracle pins the sequence-0 sentinel ("sequencing unused"), so
      // pointing the vault at it seeds the replay floor to 0 — a fresh oracle
      // is never bricked.
      await program.methods
        .setOracle(mockOracleData, oracleProgram.programId)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          newOracleProgramAccount: oracleProgram.programId,
          newOracleAccount: mockOracleData,
        })
        .rpc();
      const v = await program.account.creditVault.fetch(vault);
      expect(v.navOracle.toBase58()).to.equal(mockOracleData.toBase58());
      expect(v.lastSeenNavSequence.toNumber()).to.equal(0);
    });
  });

  describe("Oracle staleness window at init (monthly-NAV regression)", () => {
    // Regression: initialize_pool validated max_staleness via
    // svs_oracle::validate_staleness_config (24h cap), so a credit pool with a
    // monthly NAV window (<=45d) could not be created at all. It now uses the
    // same 60..=DEFAULT_MAX_NAV_STALENESS_SECS bound as update_oracle_params.
    const THIRTY_DAYS = new BN(2_592_000); // > 24h cap, < 45d ceiling
    const vaultId2 = new BN(777);
    let vault2: PublicKey;
    let sharesMint2: PublicKey;
    let redemptionEscrow2: PublicKey;
    let depositVault2: PublicKey;

    before(() => {
      [vault2] = getCreditVaultAddress(program.programId, assetMint, vaultId2);
      [sharesMint2] = getCreditSharesMintAddress(program.programId, vault2);
      [redemptionEscrow2] = getRedemptionEscrowAddress(
        program.programId,
        vault2,
      );
      depositVault2 = getAssociatedTokenAddressSync(assetMint, vault2, true);
    });

    it("accepts a 30-day staleness window (was rejected by the 24h cap)", async () => {
      await program.methods
        .initializePool(vaultId2, minimumInvestment, THIRTY_DAYS)
        .accountsPartial({
          authority: payer.publicKey,
          manager: manager.publicKey,
          vault: vault2,
          assetMint,
          sharesMint: sharesMint2,
          depositVault: depositVault2,
          redemptionEscrow: redemptionEscrow2,
          navOracle: mockOracleData,
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

      const v = await program.account.creditVault.fetch(vault2);
      expect(v.maxStaleness.toNumber()).to.equal(THIRTY_DAYS.toNumber());
    });
  });

  describe("update_oracle_params + pause gating", () => {
    it("authority updates the staleness window", async () => {
      const SEVEN_DAYS = new BN(604_800);
      await program.methods
        .updateOracleParams(SEVEN_DAYS)
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      const v = await program.account.creditVault.fetch(vault);
      expect(v.maxStaleness.toNumber()).to.equal(SEVEN_DAYS.toNumber());
    });

    it("non-authority cannot update oracle params (Unauthorized)", async () => {
      const stranger = Keypair.generate();
      const air = await connection.requestAirdrop(
        stranger.publicKey,
        anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(air);
      try {
        await program.methods
          .updateOracleParams(new BN(604_800))
          .accountsPartial({ authority: stranger.publicKey, vault })
          .signers([stranger])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("rejects an out-of-bounds staleness window (InvalidStalenessConfig)", async () => {
      try {
        await program.methods
          .updateOracleParams(new BN(30)) // below the 60s floor
          .accountsPartial({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidStalenessConfig");
      }
    });

    it("pause blocks the deposit and redeem entry points", async () => {
      // Fresh investor (no prior request) so the pause gate — the FIRST line of
      // each handler — is what rejects, not an account-already-in-use error.
      const pInv = Keypair.generate();
      const air = await connection.requestAirdrop(
        pInv.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(air);
      const pAssetAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        pInv.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        pInv.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const pSharesAta = getAssociatedTokenAddressSync(
        sharesMint,
        pInv.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const [pInvReq] = getInvestmentRequestPDA(pInv.publicKey);
      const [pRedReq] = getRedemptionRequestPDA(pInv.publicKey);
      const [pClaimable] = getClaimableTokensPDA(pInv.publicKey);
      const [pAtt] = getAttestationPDA(pInv.publicKey, attester.publicKey);

      await program.methods
        .pause()
        .accountsPartial({ authority: payer.publicKey, vault })
        .rpc();
      try {
        try {
          await program.methods
            .requestDeposit(minimumInvestment)
            .accountsPartial({
              investor: pInv.publicKey,
              vault,
              investmentRequest: pInvReq,
              investorTokenAccount: pAssetAta.address,
              depositVault,
              assetMint,
              attestation: pAtt,
              assetTokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              clock: SYSVAR_CLOCK_PUBKEY,
            })
            .signers([pInv])
            .rpc();
          expect.fail("deposit should have thrown");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("VaultPaused");
        }

        try {
          await program.methods
            .requestRedeem(new BN(1))
            .accountsPartial({
              investor: pInv.publicKey,
              vault,
              redemptionRequest: pRedReq,
              sharesMint,
              investorSharesAccount: pSharesAta,
              redemptionEscrow,
              assetMint,
              claimableTokens: pClaimable,
              attestation: pAtt,
              assetTokenProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              clock: SYSVAR_CLOCK_PUBKEY,
            })
            .remainingAccounts(requestRedeemHookExtras(pInv.publicKey))
            .signers([pInv])
            .rpc();
          expect.fail("redeem should have thrown");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("VaultPaused");
        }
      } finally {
        await program.methods
          .unpause()
          .accountsPartial({ authority: payer.publicKey, vault })
          .rpc();
      }
    });
  });

  describe("Batch settlement against the real NAV oracle", () => {
    // P1 integration regression. With the vault reading the REAL nav-oracle
    // (non-zero, strictly-monotonic sequences — unlike mock-oracle's seq-0
    // sentinel), a manager must be able to approve MULTIPLE queued requests
    // against ONE published NAV. read_oracle treats the sequence as a replay
    // FLOOR (reject strictly-older, accept equal), so the second approval at
    // the same sequence must succeed. Exercises the approve path end-to-end
    // against the real oracle — the gap the mock-only approval tests left open.
    const investorA = Keypair.generate();
    const investorB = Keypair.generate();
    const amt = new BN(5_000_000); // 5 tokens, above minimum_investment
    let aAta: PublicKey;
    let bAta: PublicKey;
    let aReq: PublicKey;
    let bReq: PublicKey;
    let aAtt: PublicKey;
    let bAtt: PublicKey;

    before(async () => {
      // Point the vault at the real nav-oracle and ensure the window is open.
      await program.methods
        .setOracle(navAccount, navOracleProgram.programId)
        .accountsPartial({
          authority: payer.publicKey,
          vault,
          newOracleProgramAccount: navOracleProgram.programId,
          newOracleAccount: navAccount,
        })
        .rpc();
      try {
        await program.methods
          .openInvestmentWindow()
          .accountsPartial({ authority: payer.publicKey, vault })
          .rpc();
      } catch {
        /* already open */
      }

      // An earlier test rotated the publisher; restore it to navPublisher so
      // publishNav (which signs with navPublisher) produces a valid signature.
      await navOracleProgram.methods
        .rotatePublisher()
        .accountsPartial({
          pool: vault,
          navAccount,
          authority: payer.publicKey,
          newPublisher: navPublisher.publicKey,
        })
        .signers([payer])
        .rpc();

      for (const inv of [investorA, investorB]) {
        const air = await connection.requestAirdrop(
          inv.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL,
        );
        await connection.confirmTransaction(air);
        const ata = await getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          assetMint,
          inv.publicKey,
          false,
          undefined,
          undefined,
          TOKEN_PROGRAM_ID,
        );
        await mintTo(
          connection,
          payer,
          assetMint,
          ata.address,
          payer.publicKey,
          BigInt(amt.toString()) * 4n,
          [],
          undefined,
          TOKEN_PROGRAM_ID,
        );
        const [att] = getAttestationPDA(inv.publicKey, attester.publicKey);
        await attestationMockProgram.methods
          .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
          .accountsPartial({
            authority: payer.publicKey,
            attestation: att,
            subject: inv.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        if (inv === investorA) {
          aAta = ata.address;
          aAtt = att;
        } else {
          bAta = ata.address;
          bAtt = att;
        }
      }
      [aReq] = getInvestmentRequestPDA(investorA.publicKey);
      [bReq] = getInvestmentRequestPDA(investorB.publicKey);
    });

    it("approves two queued requests against a single published NAV", async () => {
      const legs = [
        { inv: investorA, ata: aAta, req: aReq, att: aAtt },
        { inv: investorB, ata: bAta, req: bReq, att: bAtt },
      ];

      for (const { inv, ata, req, att } of legs) {
        await program.methods
          .requestDeposit(amt)
          .accountsPartial({
            investor: inv.publicKey,
            vault,
            investmentRequest: req,
            investorTokenAccount: ata,
            depositVault,
            assetMint,
            attestation: att,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([inv])
          .rpc();
      }

      // ONE NAV publish (a single fresh monotonic sequence).
      await publishNav(PRICE_SCALE);
      const seq = (await navOracleProgram.account.navAccount.fetch(navAccount))
        .sequence;

      // Approve BOTH against that single published NAV (same sequence). The
      // second approval at the same sequence must NOT revert (P1 fix).
      for (const { inv, req, att } of legs) {
        await program.methods
          .approveDeposit()
          .accountsPartial({
            manager: manager.publicKey,
            vault,
            investmentRequest: req,
            investor: inv.publicKey,
            oracleAccount: navAccount,
            attestation: att,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([manager])
          .rpc();
        const r = await program.account.investmentRequest.fetch(req);
        expect(JSON.stringify(r.status)).to.equal(
          JSON.stringify({ approved: {} }),
        );
        expect(r.sharesClaimable.toNumber()).to.be.greaterThan(0);
      }

      // Replay floor sits at the single published sequence — proving both
      // approvals settled against it.
      const v = await program.account.creditVault.fetch(vault);
      expect(v.lastSeenNavSequence.toString()).to.equal(seq.toString());
    });
  });
});
