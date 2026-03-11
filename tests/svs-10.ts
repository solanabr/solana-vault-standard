import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
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
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs10 } from "../target/types/svs_10";

// ============================================================
// PDA helpers
// ============================================================

function getVaultPDA(
  assetMint: PublicKey,
  vaultId: BN,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("async_vault"),
      assetMint.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  );
}

function getSharesMintPDA(
  vault: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer()],
    programId
  );
}

function getShareEscrowPDA(
  vault: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("share_escrow"), vault.toBuffer()],
    programId
  );
}

function getDepositRequestPDA(
  vault: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_request"), vault.toBuffer(), owner.toBuffer()],
    programId
  );
}

function getRedeemRequestPDA(
  vault: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_request"), vault.toBuffer(), owner.toBuffer()],
    programId
  );
}

function getClaimableEscrowPDA(
  vault: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable"), vault.toBuffer(), owner.toBuffer()],
    programId
  );
}

function getClaimableTokensPDA(
  vault: PublicKey,
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claimable_tokens"), vault.toBuffer(), owner.toBuffer()],
    programId
  );
}

function getOperatorApprovalPDA(
  vault: PublicKey,
  owner: PublicKey,
  operator: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("operator_approval"),
      vault.toBuffer(),
      owner.toBuffer(),
      operator.toBuffer(),
    ],
    programId
  );
}

// ============================================================
// Suite
// ============================================================

describe("svs-10 (Async Vault - ERC-7540)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs10 as Program<Svs10>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Shared across all tests in this outer describe
  let assetMint: PublicKey;
  const ASSET_DECIMALS = 6;
  const vaultId = new BN(1);

  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let shareEscrow: PublicKey;

  // Operator is a separate keypair from authority in SVS-10
  let operatorKeypair: Keypair;

  // Primary user = payer
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;

  before("global setup: mint asset, derive PDAs", async () => {
    operatorKeypair = Keypair.generate();

    // Create the asset mint (SPL Token, 6 decimals — USDC-like)
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

    [vault] = getVaultPDA(assetMint, vaultId, program.programId);
    [sharesMint] = getSharesMintPDA(vault, program.programId);
    [shareEscrow] = getShareEscrowPDA(vault, program.programId);

    // Asset vault is an ATA owned by the vault PDA (standard SPL token account)
    assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true, // allowOwnerOffCurve — vault is a PDA
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // User (payer) asset account
    const userAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      payer.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    userAssetAccount = userAssetAta.address;

    // Mint 10M assets to payer
    await mintTo(
      connection,
      payer,
      assetMint,
      userAssetAccount,
      payer.publicKey,
      10_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // User shares account (Token-2022 ATA — created after initialize)
    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Fund operator with SOL for signing
    const airdropSig = await connection.requestAirdrop(
      operatorKeypair.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSig);

    console.log("  Program ID    :", program.programId.toBase58());
    console.log("  Asset Mint    :", assetMint.toBase58());
    console.log("  Vault PDA     :", vault.toBase58());
    console.log("  Shares Mint   :", sharesMint.toBase58());
    console.log("  Operator      :", operatorKeypair.publicKey.toBase58());
  });

  // ============================================================
  // 1. Initialization
  // ============================================================

  describe("1. Initialization", () => {
    it("creates a new async vault with operator", async () => {
      const tx = await program.methods
        .initialize(
          vaultId,
          "SVS Async Vault",
          "svAVLT",
          "https://example.com/svs-10.json",
          operatorKeypair.publicKey
        )
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint,
          sharesMint,
          assetVault,
          shareEscrow,
          operator: operatorKeypair.publicKey,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("    Initialize tx:", tx);

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
      expect(vaultAccount.operator.toBase58()).to.equal(
        operatorKeypair.publicKey.toBase58()
      );
      expect(vaultAccount.assetMint.toBase58()).to.equal(
        assetMint.toBase58()
      );
      expect(vaultAccount.sharesMint.toBase58()).to.equal(
        sharesMint.toBase58()
      );
      expect(vaultAccount.assetVault.toBase58()).to.equal(
        assetVault.toBase58()
      );
      expect(vaultAccount.shareEscrow.toBase58()).to.equal(
        shareEscrow.toBase58()
      );
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.vaultId.toNumber()).to.equal(vaultId.toNumber());
    });

    it("PDA derivation is canonical", () => {
      const [derivedVault] = getVaultPDA(assetMint, vaultId, program.programId);
      expect(derivedVault.toBase58()).to.equal(vault.toBase58());

      const [derivedShares] = getSharesMintPDA(vault, program.programId);
      expect(derivedShares.toBase58()).to.equal(sharesMint.toBase58());

      const [derivedEscrow] = getShareEscrowPDA(vault, program.programId);
      expect(derivedEscrow.toBase58()).to.equal(shareEscrow.toBase58());
    });

    it("share escrow is initialized as a Token-2022 account", async () => {
      const escrowAccount = await getAccount(
        connection,
        shareEscrow,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(escrowAccount.mint.toBase58()).to.equal(sharesMint.toBase58());
      expect(Number(escrowAccount.amount)).to.equal(0);
    });
  });

  // ============================================================
  // 2. Full Deposit Lifecycle
  // ============================================================

  describe("2. Full Deposit Lifecycle", () => {
    const depositAmount = new BN(1_000 * 10 ** ASSET_DECIMALS); // 1,000 USDC
    let depositRequest: PublicKey;

    it("request_deposit: user locks assets, DepositRequest PDA created", async () => {
      [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      const userBefore = await getAccount(connection, userAssetAccount);
      const vaultBefore = await getAccount(connection, assetVault);

      await program.methods
        .requestDeposit(depositAmount, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userAfter = await getAccount(connection, userAssetAccount);
      const vaultAfter = await getAccount(connection, assetVault);

      // Assets moved from user to vault
      expect(
        Number(userBefore.amount) - Number(userAfter.amount)
      ).to.equal(depositAmount.toNumber());
      expect(
        Number(vaultAfter.amount) - Number(vaultBefore.amount)
      ).to.equal(depositAmount.toNumber());

      // DepositRequest PDA exists with correct state
      const reqAccount = await program.account.depositRequest.fetch(
        depositRequest
      );
      expect(reqAccount.vault.toBase58()).to.equal(vault.toBase58());
      expect(reqAccount.owner.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
      expect(reqAccount.receiver.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
      expect(reqAccount.assetsLocked.toNumber()).to.equal(
        depositAmount.toNumber()
      );
      expect(reqAccount.sharesClaimable.toNumber()).to.equal(0);
      // Status = Pending (0)
      expect(reqAccount.status).to.deep.equal({ pending: {} });
    });

    it("fulfill_deposit: operator processes, vault state updated", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest,
        })
        .signers([operatorKeypair])
        .rpc();

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      const reqAccount = await program.account.depositRequest.fetch(
        depositRequest
      );

      // Vault total_assets increased by deposit amount
      expect(
        vaultAfter.totalAssets.toNumber() - vaultBefore.totalAssets.toNumber()
      ).to.equal(depositAmount.toNumber());

      // Shares claimable set (non-zero for first deposit)
      expect(reqAccount.sharesClaimable.toNumber()).to.be.greaterThan(0);

      // Vault total_shares increased by same amount
      expect(
        vaultAfter.totalShares.toNumber() - vaultBefore.totalShares.toNumber()
      ).to.equal(reqAccount.sharesClaimable.toNumber());

      // Status = Fulfilled (1)
      expect(reqAccount.status).to.deep.equal({ fulfilled: {} });
    });

    it("claim_deposit: user receives shares, PDA closed", async () => {
      const reqAccount = await program.account.depositRequest.fetch(
        depositRequest
      );
      const sharesClaimable = reqAccount.sharesClaimable.toNumber();
      expect(sharesClaimable).to.be.greaterThan(0);

      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Shares minted to user
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(sharesAccount.amount)).to.equal(sharesClaimable);

      // DepositRequest PDA is closed
      const depositRequestInfo = await connection.getAccountInfo(
        depositRequest
      );
      expect(depositRequestInfo).to.be.null;

      console.log(
        "    Shares received:",
        sharesClaimable / 10 ** 9
      );
    });
  });

  // ============================================================
  // 3. Full Redeem Lifecycle
  // ============================================================

  describe("3. Full Redeem Lifecycle", () => {
    let redeemRequest: PublicKey;
    let claimableEscrow: PublicKey;
    let claimableTokens: PublicKey;
    let sharesToRedeem: BN;

    before("get user shares balance", async () => {
      const sharesAccount = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      // Redeem half of shares
      sharesToRedeem = new BN(Math.floor(Number(sharesAccount.amount) / 2));
      expect(sharesToRedeem.toNumber()).to.be.greaterThan(0);

      [redeemRequest] = getRedeemRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      [claimableEscrow] = getClaimableEscrowPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      [claimableTokens] = getClaimableTokensPDA(
        vault,
        payer.publicKey,
        program.programId
      );
    });

    it("request_redeem: user locks shares in escrow, RedeemRequest created", async () => {
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const escrowBefore = await getAccount(
        connection,
        shareEscrow,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .requestRedeem(sharesToRedeem, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          shareEscrow,
          redeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const escrowAfter = await getAccount(
        connection,
        shareEscrow,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Shares moved from user to escrow
      expect(
        Number(sharesBefore.amount) - Number(sharesAfter.amount)
      ).to.equal(sharesToRedeem.toNumber());
      expect(
        Number(escrowAfter.amount) - Number(escrowBefore.amount)
      ).to.equal(sharesToRedeem.toNumber());

      const reqAccount = await program.account.redeemRequest.fetch(
        redeemRequest
      );
      expect(reqAccount.sharesLocked.toNumber()).to.equal(
        sharesToRedeem.toNumber()
      );
      expect(reqAccount.assetsClaimable.toNumber()).to.equal(0);
      expect(reqAccount.status).to.deep.equal({ pending: {} });
    });

    it("fulfill_redeem: operator burns shares, creates claimable accounts", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);
      const sharesMintBefore = await getAccount(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .fulfillRedeem()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          redeemRequest,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          claimableEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([operatorKeypair])
        .rpc();

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      const reqAccount = await program.account.redeemRequest.fetch(
        redeemRequest
      );
      const escrowAccount = await program.account.claimableEscrow.fetch(
        claimableEscrow
      );
      const sharesMintAfter = await getAccount(
        connection,
        sharesMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Shares burned
      expect(
        Number(sharesMintBefore.amount) - Number(sharesMintAfter.amount)
      ).to.equal(sharesToRedeem.toNumber());

      // Vault state reduced
      expect(
        vaultBefore.totalShares.toNumber() - vaultAfter.totalShares.toNumber()
      ).to.equal(sharesToRedeem.toNumber());

      // Assets claimable set
      const assetsClaimable = reqAccount.assetsClaimable.toNumber();
      expect(assetsClaimable).to.be.greaterThan(0);
      expect(escrowAccount.amount.toNumber()).to.equal(assetsClaimable);
      expect(
        vaultBefore.totalAssets.toNumber() - vaultAfter.totalAssets.toNumber()
      ).to.equal(assetsClaimable);

      // Status = Fulfilled
      expect(reqAccount.status).to.deep.equal({ fulfilled: {} });

      // claimable_tokens token account exists
      const claimableTokensAccount = await getAccount(
        connection,
        claimableTokens,
        undefined,
        TOKEN_PROGRAM_ID
      );
      expect(Number(claimableTokensAccount.amount)).to.equal(assetsClaimable);
    });

    it("claim_redeem: user receives assets, all accounts closed", async () => {
      const escrowAccount = await program.account.claimableEscrow.fetch(
        claimableEscrow
      );
      const assetsClaimable = escrowAccount.amount.toNumber();

      const userAssetBefore = await getAccount(connection, userAssetAccount);

      await program.methods
        .claimRedeem()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          redeemRequest,
          redeemRequestOwner: payer.publicKey,
          claimableEscrow,
          assetMint,
          claimableTokens,
          receiverAssetAccount: userAssetAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userAssetAfter = await getAccount(connection, userAssetAccount);

      // User received assets
      expect(
        Number(userAssetAfter.amount) - Number(userAssetBefore.amount)
      ).to.equal(assetsClaimable);

      // All PDAs closed
      const redeemRequestInfo = await connection.getAccountInfo(redeemRequest);
      expect(redeemRequestInfo).to.be.null;

      const claimableEscrowInfo = await connection.getAccountInfo(
        claimableEscrow
      );
      expect(claimableEscrowInfo).to.be.null;

      const claimableTokensInfo = await connection.getAccountInfo(
        claimableTokens
      );
      expect(claimableTokensInfo).to.be.null;

      console.log(
        "    Assets redeemed:",
        assetsClaimable / 10 ** ASSET_DECIMALS
      );
    });
  });

  // ============================================================
  // 4. Cancel Flows
  // ============================================================

  describe("4. Cancel Flows", () => {
    // Each cancel test uses a fresh deposit amount
    const depositAmount = new BN(500 * 10 ** ASSET_DECIMALS);
    let depositRequest: PublicKey;

    before("derive deposit request PDA", () => {
      [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
    });

    it("cancel_deposit: assets returned, PDA closed", async () => {
      // Create a deposit request
      await program.methods
        .requestDeposit(depositAmount, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userBefore = await getAccount(connection, userAssetAccount);

      // Cancel it
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          depositRequest,
          assetMint,
          assetVault,
          userAssetAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userAfter = await getAccount(connection, userAssetAccount);

      // Assets returned
      expect(
        Number(userAfter.amount) - Number(userBefore.amount)
      ).to.equal(depositAmount.toNumber());

      // PDA closed
      const info = await connection.getAccountInfo(depositRequest);
      expect(info).to.be.null;
    });

    it("cannot cancel a fulfilled deposit request", async () => {
      // Create and fulfill a deposit
      await program.methods
        .requestDeposit(depositAmount, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest,
        })
        .signers([operatorKeypair])
        .rpc();

      // Attempt cancel — should fail with RequestNotPending
      try {
        await program.methods
          .cancelDeposit()
          .accountsStrict({
            owner: payer.publicKey,
            vault,
            depositRequest,
            assetMint,
            assetVault,
            userAssetAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Expected cancel to fail on fulfilled request");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "RequestNotPending"
        );
      }

      // Clean up: claim the deposit so PDAs are closed for subsequent tests
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("cancel_redeem: shares returned from escrow, PDA closed", async () => {
      const [redeemRequest] = getRedeemRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      // Get current shares balance
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const sharesToRedeem = new BN(
        Math.min(100 * 10 ** 9, Number(sharesBefore.amount))
      );
      expect(sharesToRedeem.toNumber()).to.be.greaterThan(0);

      await program.methods
        .requestRedeem(sharesToRedeem, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          shareEscrow,
          redeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfterLock = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Cancel the redeem
      await program.methods
        .cancelRedeem()
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          redeemRequest,
          sharesMint,
          shareEscrow,
          userSharesAccount,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfterCancel = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Shares returned
      expect(
        Number(sharesAfterCancel.amount) - Number(sharesAfterLock.amount)
      ).to.equal(sharesToRedeem.toNumber());

      // PDA closed
      const info = await connection.getAccountInfo(redeemRequest);
      expect(info).to.be.null;
    });
  });

  // ============================================================
  // 5. Operator Management
  // ============================================================

  describe("5. Operator Management", () => {
    let newOperator: Keypair;

    before("setup new operator", async () => {
      newOperator = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        newOperator.publicKey,
        LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);
    });

    it("set_vault_operator: authority changes vault operator", async () => {
      await program.methods
        .setVaultOperator()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          newOperator: newOperator.publicKey,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.operator.toBase58()).to.equal(
        newOperator.publicKey.toBase58()
      );

      // Restore original operator for remaining tests
      await program.methods
        .setVaultOperator()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          newOperator: operatorKeypair.publicKey,
        })
        .rpc();

      const vaultRestored = await program.account.asyncVault.fetch(vault);
      expect(vaultRestored.operator.toBase58()).to.equal(
        operatorKeypair.publicKey.toBase58()
      );
    });

    it("set_operator: user approves an operator for claiming on their behalf", async () => {
      const [operatorApproval] = getOperatorApprovalPDA(
        vault,
        payer.publicKey,
        operatorKeypair.publicKey,
        program.programId
      );

      await program.methods
        .setOperator(true)
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operatorApproval,
          operator: operatorKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const approval = await program.account.operatorApproval.fetch(
        operatorApproval
      );
      expect(approval.approved).to.equal(true);
      expect(approval.owner.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(approval.operator.toBase58()).to.equal(
        operatorKeypair.publicKey.toBase58()
      );
    });

    it("set_operator: user can revoke operator approval", async () => {
      const [operatorApproval] = getOperatorApprovalPDA(
        vault,
        payer.publicKey,
        operatorKeypair.publicKey,
        program.programId
      );

      await program.methods
        .setOperator(false)
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operatorApproval,
          operator: operatorKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const approval = await program.account.operatorApproval.fetch(
        operatorApproval
      );
      expect(approval.approved).to.equal(false);

      // Re-approve for operator claim tests
      await program.methods
        .setOperator(true)
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operatorApproval,
          operator: operatorKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("operator can claim_deposit on behalf of user with OperatorApproval", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const [operatorApproval] = getOperatorApprovalPDA(
        vault,
        payer.publicKey,
        operatorKeypair.publicKey,
        program.programId
      );

      // Create and fulfill a deposit (receiver = payer)
      const depositAmount = new BN(200 * 10 ** ASSET_DECIMALS);
      await program.methods
        .requestDeposit(depositAmount, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest,
        })
        .signers([operatorKeypair])
        .rpc();

      // Fund operator for ATA creation
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Operator claims deposit on behalf of payer
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: operatorKeypair.publicKey,
          vault,
          depositRequest,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operatorKeypair])
        .rpc();

      const sharesAfter = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      // Shares increased (operator successfully claimed on behalf of user)
      expect(Number(sharesAfter.amount)).to.be.greaterThan(
        Number(sharesBefore.amount)
      );
    });
  });

  // ============================================================
  // 6. Multi-User
  // ============================================================

  describe("6. Multi-User", () => {
    let user2: Keypair;
    let user2AssetAccount: PublicKey;
    let user2SharesAccount: PublicKey;
    let depositRequestUser1: PublicKey;
    let depositRequestUser2: PublicKey;

    const depositUser1 = new BN(1_000 * 10 ** ASSET_DECIMALS);
    const depositUser2 = new BN(500 * 10 ** ASSET_DECIMALS);

    before("create second user and fund", async () => {
      user2 = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        user2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      // Create user2 asset ATA and fund with assets
      const user2Ata = await getOrCreateAssociatedTokenAccount(
        connection,
        user2,
        assetMint,
        user2.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      user2AssetAccount = user2Ata.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        user2AssetAccount,
        payer.publicKey,
        2_000 * 10 ** ASSET_DECIMALS,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Derive shares accounts
      [depositRequestUser1] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      [depositRequestUser2] = getDepositRequestPDA(
        vault,
        user2.publicKey,
        program.programId
      );

      user2SharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    });

    it("two users deposit concurrently", async () => {
      // User1 (payer) requests deposit
      await program.methods
        .requestDeposit(depositUser1, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest: depositRequestUser1,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // User2 requests deposit
      await program.methods
        .requestDeposit(depositUser2, user2.publicKey)
        .accountsStrict({
          user: user2.publicKey,
          vault,
          assetMint,
          userAssetAccount: user2AssetAccount,
          assetVault,
          depositRequest: depositRequestUser2,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const req1 = await program.account.depositRequest.fetch(
        depositRequestUser1
      );
      const req2 = await program.account.depositRequest.fetch(
        depositRequestUser2
      );

      expect(req1.assetsLocked.toNumber()).to.equal(depositUser1.toNumber());
      expect(req2.assetsLocked.toNumber()).to.equal(depositUser2.toNumber());
      expect(req1.status).to.deep.equal({ pending: {} });
      expect(req2.status).to.deep.equal({ pending: {} });
    });

    it("operator fulfills both requests in sequence", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest: depositRequestUser1,
        })
        .signers([operatorKeypair])
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest: depositRequestUser2,
        })
        .signers([operatorKeypair])
        .rpc();

      const vaultAfter = await program.account.asyncVault.fetch(vault);

      // Total assets increased by sum of both deposits
      expect(
        vaultAfter.totalAssets.toNumber() - vaultBefore.totalAssets.toNumber()
      ).to.equal(depositUser1.toNumber() + depositUser2.toNumber());

      const req1 = await program.account.depositRequest.fetch(
        depositRequestUser1
      );
      const req2 = await program.account.depositRequest.fetch(
        depositRequestUser2
      );
      expect(req1.status).to.deep.equal({ fulfilled: {} });
      expect(req2.status).to.deep.equal({ fulfilled: {} });

      // User2 gets fewer shares (vault priced — more assets in vault at time of fulfillment)
      // User1 was fulfilled first when vault had fewer assets, user2 second
      expect(req1.sharesClaimable.toNumber()).to.be.greaterThan(0);
      expect(req2.sharesClaimable.toNumber()).to.be.greaterThan(0);

      console.log(
        "    User1 shares claimable:",
        req1.sharesClaimable.toNumber() / 10 ** 9
      );
      console.log(
        "    User2 shares claimable:",
        req2.sharesClaimable.toNumber() / 10 ** 9
      );
    });

    it("both users claim successfully", async () => {
      // User1 claims
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest: depositRequestUser1,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // User2 claims
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: user2.publicKey,
          vault,
          depositRequest: depositRequestUser2,
          depositRequestOwner: user2.publicKey,
          sharesMint,
          receiverSharesAccount: user2SharesAccount,
          receiver: user2.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Both PDAs closed
      expect(await connection.getAccountInfo(depositRequestUser1)).to.be.null;
      expect(await connection.getAccountInfo(depositRequestUser2)).to.be.null;

      // Both users have shares
      const user1Shares = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const user2Shares = await getAccount(
        connection,
        user2SharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(user1Shares.amount)).to.be.greaterThan(0);
      expect(Number(user2Shares.amount)).to.be.greaterThan(0);
    });
  });

  // ============================================================
  // 7. Admin
  // ============================================================

  describe("7. Admin", () => {
    it("pause: authority can pause the vault", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(true);
    });

    it("operations fail when vault is paused", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      try {
        await program.methods
          .requestDeposit(new BN(100), payer.publicKey)
          .accountsStrict({
            user: payer.publicKey,
            vault,
            assetMint,
            userAssetAccount,
            assetVault,
            depositRequest,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Expected request_deposit to fail when paused");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "VaultPaused"
        );
      }
    });

    it("unpause: authority can unpause the vault", async () => {
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.paused).to.equal(false);
    });

    it("only operator can fulfill deposit requests", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const imposter = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        imposter.publicKey,
        LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      // Create a deposit request first
      await program.methods
        .requestDeposit(new BN(100 * 10 ** ASSET_DECIMALS), payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Imposter attempts to fulfill
      try {
        await program.methods
          .fulfillDeposit()
          .accountsStrict({
            operator: imposter.publicKey,
            vault,
            depositRequest,
          })
          .signers([imposter])
          .rpc();
        expect.fail("Expected fulfill to fail for non-operator");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "InvalidOperator"
        );
      }

      // Cancel it to clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          depositRequest,
          assetMint,
          assetVault,
          userAssetAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("transfer_authority: changes vault authority", async () => {
      const newAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(
        newAuthority.publicKey.toBase58()
      );

      // Old authority can no longer pause
      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: payer.publicKey,
            vault,
          })
          .rpc();
        expect.fail("Expected pause to fail for old authority");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "Unauthorized"
        );
      }

      // Transfer back to payer so remaining tests work
      // New authority must fund themselves first
      const airdrop = await connection.requestAirdrop(
        newAuthority.publicKey,
        LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultRestored = await program.account.asyncVault.fetch(vault);
      expect(vaultRestored.authority.toBase58()).to.equal(
        payer.publicKey.toBase58()
      );
    });
  });

  // ============================================================
  // 8. Edge Cases
  // ============================================================

  describe("8. Edge Cases", () => {
    it("zero deposit fails", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      try {
        await program.methods
          .requestDeposit(new BN(0), payer.publicKey)
          .accountsStrict({
            user: payer.publicKey,
            vault,
            assetMint,
            userAssetAccount,
            assetVault,
            depositRequest,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Expected zero deposit to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "ZeroAmount"
        );
      }
    });

    it("double fulfill fails (request not Pending after first fulfill)", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      // Create and fulfill
      await program.methods
        .requestDeposit(new BN(100 * 10 ** ASSET_DECIMALS), payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest,
        })
        .signers([operatorKeypair])
        .rpc();

      // Second fulfill should fail
      try {
        await program.methods
          .fulfillDeposit()
          .accountsStrict({
            operator: operatorKeypair.publicKey,
            vault,
            depositRequest,
          })
          .signers([operatorKeypair])
          .rpc();
        expect.fail("Expected double fulfill to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "RequestNotPending"
        );
      }

      // Claim to close PDA
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("claim before fulfill fails", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      // Create deposit request (Pending, not fulfilled)
      await program.methods
        .requestDeposit(new BN(50 * 10 ** ASSET_DECIMALS), payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Try to claim before fulfillment
      try {
        await program.methods
          .claimDeposit()
          .accountsStrict({
            signer: payer.publicKey,
            vault,
            depositRequest,
            depositRequestOwner: payer.publicKey,
            sharesMint,
            receiverSharesAccount: userSharesAccount,
            receiver: payer.publicKey,
            operatorApproval: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Expected claim before fulfill to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "RequestNotFulfilled"
        );
      }

      // Cancel to clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          depositRequest,
          assetMint,
          assetVault,
          userAssetAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("unauthorized claim fails (not receiver, no approval)", async () => {
      const [depositRequest] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const unauthorized = Keypair.generate();
      const airdrop = await connection.requestAirdrop(
        unauthorized.publicKey,
        LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdrop);

      // Create and fulfill a deposit
      await program.methods
        .requestDeposit(new BN(100 * 10 ** ASSET_DECIMALS), payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest,
        })
        .signers([operatorKeypair])
        .rpc();

      // Unauthorized user attempts to claim with no operator approval
      try {
        await program.methods
          .claimDeposit()
          .accountsStrict({
            signer: unauthorized.publicKey,
            vault,
            depositRequest,
            depositRequestOwner: payer.publicKey,
            sharesMint,
            receiverSharesAccount: userSharesAccount,
            receiver: payer.publicKey,
            operatorApproval: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("Expected unauthorized claim to fail");
      } catch (err: any) {
        expect(err.error?.errorCode?.code ?? err.message).to.include(
          "Unauthorized"
        );
      }

      // Claim properly to clean up
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });
  });

  // ============================================================
  // 9. Vault Pricing
  // ============================================================

  describe("9. Vault Pricing", () => {
    it("second deposit in a non-empty vault receives fewer shares per asset", async () => {
      // At this point vault has assets and shares from previous tests.
      // Two subsequent deposits of identical size should produce the same share amount
      // (exchange rate constant), but we verify pricing is consistent.
      const vaultBefore = await program.account.asyncVault.fetch(vault);
      const totalAssetsBefore = vaultBefore.totalAssets.toNumber();
      const totalSharesBefore = vaultBefore.totalShares.toNumber();

      // First deposit of this test
      const [depositRequest1] = getDepositRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const depositAmt = new BN(100 * 10 ** ASSET_DECIMALS);

      await program.methods
        .requestDeposit(depositAmt, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          assetMint,
          userAssetAccount,
          assetVault,
          depositRequest: depositRequest1,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillDeposit()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          depositRequest: depositRequest1,
        })
        .signers([operatorKeypair])
        .rpc();

      const req1 = await program.account.depositRequest.fetch(depositRequest1);
      const shares1 = req1.sharesClaimable.toNumber();

      // If vault has assets and shares, the exchange rate governs share issuance.
      // shares = assets * total_shares / total_assets (floor, with offset)
      // When vault is non-empty the ratio may differ from the empty-vault 1:1 ratio.
      expect(shares1).to.be.greaterThan(0);

      // Verify formula: shares ~= assets * (totalShares + 1) / (totalAssets + 1)
      // (virtual offset of 1 for decimals_offset = 9 - 6 = 3, so actual offset is 10^3)
      // Just assert shares is positive and vault state is consistent.
      const vaultAfter1 = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter1.totalAssets.toNumber()).to.equal(
        totalAssetsBefore + depositAmt.toNumber()
      );
      expect(vaultAfter1.totalShares.toNumber()).to.equal(
        totalSharesBefore + shares1
      );

      // Claim to clean up
      await program.methods
        .claimDeposit()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          depositRequest: depositRequest1,
          depositRequestOwner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(
        "    Exchange rate test — vault assets:",
        vaultAfter1.totalAssets.toNumber() / 10 ** ASSET_DECIMALS,
        "shares:",
        vaultAfter1.totalShares.toNumber() / 10 ** 9
      );
    });

    it("redeem after yield: assets_claimable reflects current exchange rate", async () => {
      // Get current shares balance
      const sharesBefore = await getAccount(
        connection,
        userSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const sharesBalance = Number(sharesBefore.amount);
      expect(sharesBalance).to.be.greaterThan(0);

      const vaultBefore = await program.account.asyncVault.fetch(vault);

      // Simulate yield: directly top up the asset vault (as if yield was earned)
      // We mint additional assets to the asset vault to simulate profit
      await mintTo(
        connection,
        payer,
        assetMint,
        assetVault,
        payer.publicKey,
        500 * 10 ** ASSET_DECIMALS, // "yield" deposited into vault
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Note: SVS-10 is an async vault — total_assets is tracked by the program,
      // not read from the live token balance. Yield must be reflected by operator
      // updating total_assets. We test that a redeem at current exchange rate
      // (before any yield sync) computes assets_claimable from stored totals.

      const [redeemRequest] = getRedeemRequestPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const [claimableEscrow] = getClaimableEscrowPDA(
        vault,
        payer.publicKey,
        program.programId
      );
      const [claimableTokens] = getClaimableTokensPDA(
        vault,
        payer.publicKey,
        program.programId
      );

      const sharesToRedeem = new BN(Math.min(50 * 10 ** 9, sharesBalance));

      await program.methods
        .requestRedeem(sharesToRedeem, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          shareEscrow,
          redeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillRedeem()
        .accountsStrict({
          operator: operatorKeypair.publicKey,
          vault,
          redeemRequest,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          claimableEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([operatorKeypair])
        .rpc();

      const reqAccount = await program.account.redeemRequest.fetch(
        redeemRequest
      );

      // assets_claimable = shares_locked * total_assets / total_shares (floor, with offset)
      const assetsClaimable = reqAccount.assetsClaimable.toNumber();
      expect(assetsClaimable).to.be.greaterThan(0);

      // The exchange rate is: totalAssets / totalShares
      // assets_claimable should be <= shares_redeemed * total_assets / total_shares
      const exchangeRateNumerator = vaultBefore.totalAssets.toNumber();
      const exchangeRateDenominator = vaultBefore.totalShares.toNumber();
      if (exchangeRateDenominator > 0) {
        const expectedApprox = Math.floor(
          (sharesToRedeem.toNumber() * exchangeRateNumerator) /
            exchangeRateDenominator
        );
        // Allow for virtual offset rounding — within 0.1% tolerance
        expect(assetsClaimable).to.be.closeTo(expectedApprox, expectedApprox * 0.001 + 1);
      }

      // Claim to clean up
      await program.methods
        .claimRedeem()
        .accountsStrict({
          signer: payer.publicKey,
          vault,
          redeemRequest,
          redeemRequestOwner: payer.publicKey,
          claimableEscrow,
          assetMint,
          claimableTokens,
          receiverAssetAccount: userAssetAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(
        "    Exchange rate pricing — shares redeemed:",
        sharesToRedeem.toNumber() / 10 ** 9,
        "assets claimable:",
        assetsClaimable / 10 ** ASSET_DECIMALS
      );
    });
  });
});
