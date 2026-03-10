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
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs10 } from "../target/types/svs_10";

describe("svs-10 (Async Vault - ERC-7540)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs10 as Program<Svs10>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const operator = Keypair.generate();
  const vaultId = new BN(1);
  const ASSET_DECIMALS = 6;
  const DECIMALS_OFFSET = 3; // 9 - 6

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let shareEscrow: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  let depositRequest: PublicKey;
  let redeemRequest: PublicKey;

  // PDA helpers
  const getVaultPDA = (am: PublicKey, vid: BN): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), am.toBuffer(), vid.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  };

  const getSharesMintPDA = (v: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), v.toBuffer()],
      program.programId
    );
  };

  const getShareEscrowPDA = (v: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("share_escrow"), v.toBuffer()],
      program.programId
    );
  };

  const getDepositRequestPDA = (v: PublicKey, user: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("deposit_request"), v.toBuffer(), user.toBuffer()],
      program.programId
    );
  };

  const getRedeemRequestPDA = (v: PublicKey, user: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("redeem_request"), v.toBuffer(), user.toBuffer()],
      program.programId
    );
  };

  const getClaimableTokensPDA = (v: PublicKey, owner: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claimable_tokens"), v.toBuffer(), owner.toBuffer()],
      program.programId
    );
  };

  const getOperatorApprovalPDA = (v: PublicKey, owner: PublicKey, op: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("operator_approval"), v.toBuffer(), owner.toBuffer(), op.toBuffer()],
      program.programId
    );
  };

  /**
   * Compute the vault's internal price per share (in PRICE_SCALE units).
   * vault_price = PRICE_SCALE * (total_assets + 1) / (total_shares + 10^offset)
   */
  const computeVaultPrice = (totalAssets: BN, totalShares: BN): BN => {
    const PRICE_SCALE = new BN(1_000_000_000);
    const offset = new BN(10).pow(new BN(DECIMALS_OFFSET));
    const virtualAssets = totalAssets.add(new BN(1));
    const virtualShares = totalShares.add(offset);
    return PRICE_SCALE.mul(virtualAssets).div(virtualShares);
  };

  before(async () => {
    const airdropSig = await connection.requestAirdrop(operator.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig);
    await new Promise((r) => setTimeout(r, 1000));

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
    [shareEscrow] = getShareEscrowPDA(vault);

    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

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

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);
    [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Asset Mint:", assetMint.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Operator:", operator.publicKey.toBase58());
  });

  // =========================================================================
  // Initialization
  // =========================================================================
  describe("Initialization", () => {
    it("initializes vault correctly", async () => {
      await program.methods
        .initialize(vaultId, "Async Vault", "svASYNC", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          operator: operator.publicKey,
          vault,
          assetMint,
          sharesMint,
          assetVault,
          shareEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.operator.toBase58()).to.equal(operator.publicKey.toBase58());
      expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
    });

    it("sets decimals_offset = MAX_DECIMALS - asset_decimals", async () => {
      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.decimalsOffset).to.equal(DECIMALS_OFFSET);
    });

    it("sets max_deviation_bps to default 500", async () => {
      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.maxDeviationBps).to.equal(500);
    });
  });

  // =========================================================================
  // Deposit Flow
  // =========================================================================
  describe("Deposit Flow", () => {
    const depositAmount = 100_000 * 10 ** ASSET_DECIMALS;

    it("user requests deposit", async () => {
      await program.methods
        .requestDeposit(new BN(depositAmount), payer.publicKey)
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

      const req = await program.account.depositRequest.fetch(depositRequest);
      expect(req.owner.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(req.assetsLocked.toNumber()).to.equal(depositAmount);
      expect(req.sharesClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(req.status)).to.include("pending");
    });

    it("increments total_pending_deposits on request", async () => {
      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(depositAmount);
    });

    it("operator fulfills deposit (vault-priced, oracle_price = null)", async () => {
      await program.methods
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const req = await program.account.depositRequest.fetch(depositRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);
      console.log("  Shares claimable:", req.sharesClaimable.toNumber());
    });

    it("decrements total_pending_deposits on fulfill", async () => {
      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(depositAmount);
    });

    it("receiver claims deposit (shares minted)", async () => {
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          depositRequest,
          owner: payer.publicKey,
          sharesMint,
          receiverSharesAccount: userSharesAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
      console.log("  Shares received:", Number(sharesAccount.amount));
    });

    it("request PDA closed after claim", async () => {
      const accountInfo = await connection.getAccountInfo(depositRequest);
      expect(accountInfo).to.be.null;
    });
  });

  // =========================================================================
  // Deposit Cancellation
  // =========================================================================
  describe("Deposit Cancellation", () => {
    const cancelDepositAmount = 50_000 * 10 ** ASSET_DECIMALS;

    it("user cancels pending deposit", async () => {
      await program.methods
        .requestDeposit(new BN(cancelDepositAmount), payer.publicKey)
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

      const vaultBefore = await program.account.asyncVault.fetch(vault);
      expect(vaultBefore.totalPendingDeposits.toNumber()).to.equal(cancelDepositAmount);

      const userAssetBefore = await getAccount(connection, userAssetAccount);

      await program.methods
        .cancelDeposit()
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

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      const returned = Number(userAssetAfter.amount) - Number(userAssetBefore.amount);
      expect(returned).to.equal(cancelDepositAmount);
    });

    it("assets returned to user", async () => {
      const accountInfo = await connection.getAccountInfo(depositRequest);
      expect(accountInfo).to.be.null;
    });

    it("decrements total_pending_deposits on cancel", async () => {
      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.totalPendingDeposits.toNumber()).to.equal(0);
    });

    it("rejects cancel on non-existent request", async () => {
      try {
        await program.methods
          .cancelDeposit()
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AccountNotInitialized");
      }
    });
  });

  // =========================================================================
  // Redeem Flow
  // =========================================================================
  describe("Redeem Flow", () => {
    let sharesToRedeem: BN;
    let claimableTokens: PublicKey;

    it("user requests redemption", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      sharesToRedeem = new BN(Math.floor(Number(sharesAccount.amount) / 2));

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
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(req.sharesLocked.toNumber()).to.equal(sharesToRedeem.toNumber());
      expect(JSON.stringify(req.status)).to.include("pending");
    });

    it("operator fulfills redemption (vault-priced)", async () => {
      [claimableTokens] = getClaimableTokensPDA(vault, payer.publicKey);

      await program.methods
        .fulfillRedeem(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          redeemRequest,
          operatorApproval: null,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.assetsClaimable.toNumber()).to.be.greaterThan(0);
      console.log("  Assets claimable:", req.assetsClaimable.toNumber());
    });

    it("receiver claims redemption", async () => {
      const userAssetBefore = await getAccount(connection, userAssetAccount);

      await program.methods
        .claimRedeem()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          assetMint,
          redeemRequest,
          owner: payer.publicKey,
          claimableTokens,
          receiverAssetAccount: userAssetAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      expect(Number(userAssetAfter.amount)).to.be.greaterThan(Number(userAssetBefore.amount));
    });

    it("claimable_tokens and RedeemRequest PDAs closed after claim", async () => {
      const reqInfo = await connection.getAccountInfo(redeemRequest);
      expect(reqInfo).to.be.null;

      const claimableInfo = await connection.getAccountInfo(claimableTokens);
      expect(claimableInfo).to.be.null;
    });
  });

  // =========================================================================
  // Redeem Cancellation
  // =========================================================================
  describe("Redeem Cancellation", () => {
    it("user cancels pending redemption", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToLock = new BN(Math.floor(Number(sharesAccount.amount) / 4));

      await program.methods
        .requestRedeem(sharesToLock, payer.publicKey)
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          shareEscrow,
          redeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .cancelRedeem()
        .accountsStrict({
          user: payer.publicKey,
          vault,
          sharesMint,
          userSharesAccount,
          shareEscrow,
          redeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAfter.amount) - Number(sharesBefore.amount)).to.equal(sharesToLock.toNumber());
    });

    it("shares returned to user", async () => {
      const reqInfo = await connection.getAccountInfo(redeemRequest);
      expect(reqInfo).to.be.null;
    });
  });

  // =========================================================================
  // Oracle-Priced Fulfillment
  // =========================================================================
  describe("Oracle-Priced Fulfillment", () => {
    it("fulfill_deposit with oracle price", async () => {
      // Read vault state to compute matching oracle price
      const vaultState = await program.account.asyncVault.fetch(vault);
      const oraclePrice = computeVaultPrice(vaultState.totalAssets, vaultState.totalShares);
      console.log("  Vault price for oracle deposit:", oraclePrice.toString());

      const oracleDepositAmount = 10_000 * 10 ** ASSET_DECIMALS;

      await program.methods
        .requestDeposit(new BN(oracleDepositAmount), payer.publicKey)
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
        .fulfillDeposit(oraclePrice)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const req = await program.account.depositRequest.fetch(depositRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);

      // Claim to clean up
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          depositRequest,
          owner: payer.publicKey,
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

    it("fulfill_redeem with oracle price", async () => {
      // Read vault state to compute matching oracle price
      const vaultState = await program.account.asyncVault.fetch(vault);
      const oraclePrice = computeVaultPrice(vaultState.totalAssets, vaultState.totalShares);
      console.log("  Vault price for oracle redeem:", oraclePrice.toString());

      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToRedeem = new BN(Math.floor(Number(sharesAccount.amount) / 10));
      const [claimableTokens] = getClaimableTokensPDA(vault, payer.publicKey);

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
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .fulfillRedeem(oraclePrice)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          redeemRequest,
          operatorApproval: null,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.assetsClaimable.toNumber()).to.be.greaterThan(0);

      // Claim to clean up
      await program.methods
        .claimRedeem()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          assetMint,
          redeemRequest,
          owner: payer.publicKey,
          claimableTokens,
          receiverAssetAccount: userAssetAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("rejects oracle price of zero", async () => {
      const amount = 10_000 * 10 ** ASSET_DECIMALS;

      await program.methods
        .requestDeposit(new BN(amount), payer.publicKey)
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

      try {
        await program.methods
          .fulfillDeposit(new BN(0))
          .accountsStrict({
            operator: operator.publicKey,
            vault,
            depositRequest,
            operatorApproval: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([operator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }

      // Cancel to clean up the deposit request
      await program.methods
        .cancelDeposit()
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
    });
  });

  // =========================================================================
  // Operator Approval
  // =========================================================================
  describe("Operator Approval", () => {
    const user2 = Keypair.generate();
    let user2AssetAccount: PublicKey;
    let user2SharesAccount: PublicKey;
    let user2DepositRequest: PublicKey;
    let operatorApprovalPDA: PublicKey;

    before(async () => {
      const airdropSig = await connection.requestAirdrop(user2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      const user2AssetAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        assetMint,
        user2.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      user2AssetAccount = user2AssetAta.address;

      await mintTo(
        connection,
        payer,
        assetMint,
        user2AssetAccount,
        payer.publicKey,
        1_000_000 * 10 ** ASSET_DECIMALS,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      user2SharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      [user2DepositRequest] = getDepositRequestPDA(vault, user2.publicKey);
      [operatorApprovalPDA] = getOperatorApprovalPDA(vault, user2.publicKey, payer.publicKey);
    });

    it("user sets operator approval", async () => {
      await program.methods
        .setOperator(payer.publicKey, true, true, true)
        .accountsStrict({
          owner: user2.publicKey,
          vault,
          operatorApproval: operatorApprovalPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const approval = await program.account.operatorApproval.fetch(operatorApprovalPDA);
      expect(approval.canClaim).to.equal(true);
      expect(approval.canFulfillDeposit).to.equal(true);
      expect(approval.canFulfillRedeem).to.equal(true);
      expect(approval.operator.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(approval.owner.toBase58()).to.equal(user2.publicKey.toBase58());
    });

    it("operator claims deposit on behalf of user", async () => {
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      await program.methods
        .requestDeposit(depositAmount, user2.publicKey)
        .accountsStrict({
          user: user2.publicKey,
          vault,
          assetMint,
          userAssetAccount: user2AssetAccount,
          assetVault,
          depositRequest: user2DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      await program.methods
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest: user2DepositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      // payer (approved operator) claims on behalf of user2
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          depositRequest: user2DepositRequest,
          owner: user2.publicKey,
          sharesMint,
          receiverSharesAccount: user2SharesAccount,
          receiver: user2.publicKey,
          operatorApproval: operatorApprovalPDA,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const sharesAccount = await getAccount(connection, user2SharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
    });

    it("unapproved operator rejected", async () => {
      const rando = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(rando.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      // user2 does another deposit
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      await program.methods
        .requestDeposit(depositAmount, user2.publicKey)
        .accountsStrict({
          user: user2.publicKey,
          vault,
          assetMint,
          userAssetAccount: user2AssetAccount,
          assetVault,
          depositRequest: user2DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      await program.methods
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest: user2DepositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      // rando tries to claim without approval
      try {
        await program.methods
          .claimDeposit()
          .accountsStrict({
            claimant: rando.publicKey,
            vault,
            depositRequest: user2DepositRequest,
            owner: user2.publicKey,
            sharesMint,
            receiverSharesAccount: user2SharesAccount,
            receiver: user2.publicKey,
            operatorApproval: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([rando])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OperatorNotApproved");
      }

      // Clean up: user2 claims themselves
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: user2.publicKey,
          vault,
          depositRequest: user2DepositRequest,
          owner: user2.publicKey,
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
    });
  });

  // =========================================================================
  // Admin
  // =========================================================================
  describe("Admin", () => {
    it("pauses vault", async () => {
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

    it("rejects requests when paused", async () => {
      try {
        await program.methods
          .requestDeposit(new BN(10_000 * 10 ** ASSET_DECIMALS), payer.publicKey)
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }
    });

    it("unpauses vault", async () => {
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

    it("transfers authority", async () => {
      const newAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());

      // Transfer back
      const airdropSig = await connection.requestAirdrop(newAuthority.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter.authority.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("changes vault operator", async () => {
      const newOperator = Keypair.generate();

      await program.methods
        .setVaultOperator(newOperator.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.operator.toBase58()).to.equal(newOperator.publicKey.toBase58());

      // Change back
      await program.methods
        .setVaultOperator(operator.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault,
        })
        .rpc();
    });
  });

  // =========================================================================
  // Permission Checks
  // =========================================================================
  describe("Permission Checks", () => {
    it("rejects fulfill from non-operator", async () => {
      const amount = 10_000 * 10 ** ASSET_DECIMALS;

      await program.methods
        .requestDeposit(new BN(amount), payer.publicKey)
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

      const rando = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(rando.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      try {
        await program.methods
          .fulfillDeposit(null)
          .accountsStrict({
            operator: rando.publicKey,
            vault,
            depositRequest,
            operatorApproval: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([rando])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("OperatorNotApproved");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
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
    });

    it("rejects cancel from non-owner", async () => {
      const rando = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(rando.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      const amount = 10_000 * 10 ** ASSET_DECIMALS;
      await program.methods
        .requestDeposit(new BN(amount), payer.publicKey)
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

      // rando tries to cancel payer's request; PDA seeds use rando's key so it won't exist
      const [randoDepositRequest] = getDepositRequestPDA(vault, rando.publicKey);
      try {
        await program.methods
          .cancelDeposit()
          .accountsStrict({
            user: rando.publicKey,
            vault,
            assetMint,
            userAssetAccount,
            assetVault,
            depositRequest: randoDepositRequest,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([rando])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("AccountNotInitialized");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
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
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe("Edge Cases", () => {
    it("rejects zero amount deposit", async () => {
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("rejects deposit below minimum", async () => {
      try {
        await program.methods
          .requestDeposit(new BN(999), payer.publicKey) // MIN_DEPOSIT_AMOUNT = 1000
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
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("DepositTooSmall");
      }
    });

    it("rounding favors vault on fulfill", async () => {
      const smallAmount = 1_001; // just above minimum
      await program.methods
        .requestDeposit(new BN(smallAmount), payer.publicKey)
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
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const req = await program.account.depositRequest.fetch(depositRequest);
      // Floor rounding: shares_claimable > 0 but floored
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);
      console.log("  Small deposit shares:", req.sharesClaimable.toNumber());

      // Claim to clean up
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          depositRequest,
          owner: payer.publicKey,
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

  // =========================================================================
  // Delegated Operator Fulfill
  // =========================================================================
  describe("Delegated Operator Fulfill", () => {
    const delegatedOp = Keypair.generate();
    const user3 = Keypair.generate();
    let user3AssetAccount: PublicKey;
    let user3SharesAccount: PublicKey;
    let user3DepositRequest: PublicKey;
    let user3RedeemRequest: PublicKey;
    let fulfillApprovalPDA: PublicKey;

    before(async () => {
      const airdrop1 = await connection.requestAirdrop(delegatedOp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      const airdrop2 = await connection.requestAirdrop(user3.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdrop1);
      await connection.confirmTransaction(airdrop2);
      await new Promise((r) => setTimeout(r, 1000));

      const user3AssetAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, assetMint, user3.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
      );
      user3AssetAccount = user3AssetAta.address;

      await mintTo(
        connection, payer, assetMint, user3AssetAccount, payer.publicKey,
        1_000_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
      );

      user3SharesAccount = getAssociatedTokenAddressSync(
        sharesMint, user3.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      [user3DepositRequest] = getDepositRequestPDA(vault, user3.publicKey);
      [user3RedeemRequest] = getRedeemRequestPDA(vault, user3.publicKey);
      [fulfillApprovalPDA] = getOperatorApprovalPDA(vault, user3.publicKey, delegatedOp.publicKey);
    });

    it("delegated operator fulfills deposit via OperatorApproval", async () => {
      // user3 grants delegatedOp fulfill permissions
      await program.methods
        .setOperator(delegatedOp.publicKey, true, true, false)
        .accountsStrict({
          owner: user3.publicKey,
          vault,
          operatorApproval: fulfillApprovalPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      const approval = await program.account.operatorApproval.fetch(fulfillApprovalPDA);
      expect(approval.canFulfillDeposit).to.equal(true);
      expect(approval.canFulfillRedeem).to.equal(true);
      expect(approval.canClaim).to.equal(false);

      // user3 requests deposit
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      await program.methods
        .requestDeposit(depositAmount, user3.publicKey)
        .accountsStrict({
          user: user3.publicKey,
          vault,
          assetMint,
          userAssetAccount: user3AssetAccount,
          assetVault,
          depositRequest: user3DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      // delegatedOp fulfills (not the vault operator)
      await program.methods
        .fulfillDeposit(null)
        .accountsStrict({
          operator: delegatedOp.publicKey,
          vault,
          depositRequest: user3DepositRequest,
          operatorApproval: fulfillApprovalPDA,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([delegatedOp])
        .rpc();

      const req = await program.account.depositRequest.fetch(user3DepositRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);

      // user3 claims their own deposit
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: user3.publicKey,
          vault,
          depositRequest: user3DepositRequest,
          owner: user3.publicKey,
          sharesMint,
          receiverSharesAccount: user3SharesAccount,
          receiver: user3.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();
    });

    it("delegated operator fulfills redeem via OperatorApproval", async () => {
      const sharesAccount = await getAccount(connection, user3SharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToRedeem = new BN(Math.floor(Number(sharesAccount.amount) / 2));
      const [claimableTokens] = getClaimableTokensPDA(vault, user3.publicKey);

      await program.methods
        .requestRedeem(sharesToRedeem, user3.publicKey)
        .accountsStrict({
          user: user3.publicKey,
          vault,
          sharesMint,
          userSharesAccount: user3SharesAccount,
          shareEscrow,
          redeemRequest: user3RedeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      // delegatedOp fulfills redeem
      await program.methods
        .fulfillRedeem(null)
        .accountsStrict({
          operator: delegatedOp.publicKey,
          vault,
          redeemRequest: user3RedeemRequest,
          operatorApproval: fulfillApprovalPDA,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([delegatedOp])
        .rpc();

      const req = await program.account.redeemRequest.fetch(user3RedeemRequest);
      expect(JSON.stringify(req.status)).to.include("fulfilled");
      expect(req.assetsClaimable.toNumber()).to.be.greaterThan(0);

      // Clean up: user3 claims
      await program.methods
        .claimRedeem()
        .accountsStrict({
          claimant: user3.publicKey,
          vault,
          assetMint,
          redeemRequest: user3RedeemRequest,
          owner: user3.publicKey,
          claimableTokens,
          receiverAssetAccount: user3AssetAccount,
          receiver: user3.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();
    });

    it("rejects delegated fulfill without can_fulfill_deposit", async () => {
      const noFulfillOp = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(noFulfillOp.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      // user3 grants claim-only approval (no fulfill)
      const [claimOnlyApproval] = getOperatorApprovalPDA(vault, user3.publicKey, noFulfillOp.publicKey);
      await program.methods
        .setOperator(noFulfillOp.publicKey, false, false, true)
        .accountsStrict({
          owner: user3.publicKey,
          vault,
          operatorApproval: claimOnlyApproval,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      // user3 requests deposit
      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      await program.methods
        .requestDeposit(depositAmount, user3.publicKey)
        .accountsStrict({
          user: user3.publicKey,
          vault,
          assetMint,
          userAssetAccount: user3AssetAccount,
          assetVault,
          depositRequest: user3DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();

      // noFulfillOp tries to fulfill — should fail
      try {
        await program.methods
          .fulfillDeposit(null)
          .accountsStrict({
            operator: noFulfillOp.publicKey,
            vault,
            depositRequest: user3DepositRequest,
            operatorApproval: claimOnlyApproval,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([noFulfillOp])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OperatorNotApproved");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
        .accountsStrict({
          user: user3.publicKey,
          vault,
          assetMint,
          userAssetAccount: user3AssetAccount,
          assetVault,
          depositRequest: user3DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user3])
        .rpc();
    });
  });

  // =========================================================================
  // Oracle Deviation Rejection
  // =========================================================================
  describe("Oracle Deviation Rejection", () => {
    it("rejects oracle price exceeding max_deviation_bps", async () => {
      const vaultState = await program.account.asyncVault.fetch(vault);
      const vaultPrice = computeVaultPrice(vaultState.totalAssets, vaultState.totalShares);

      // max_deviation_bps = 500 (5%). Use 10% deviation to ensure rejection.
      const deviatedPrice = vaultPrice.mul(new BN(110)).div(new BN(100));

      const depositAmount = new BN(10_000 * 10 ** ASSET_DECIMALS);
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

      try {
        await program.methods
          .fulfillDeposit(deviatedPrice)
          .accountsStrict({
            operator: operator.publicKey,
            vault,
            depositRequest,
            operatorApproval: null,
            clock: SYSVAR_CLOCK_PUBKEY,
          })
          .signers([operator])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("OracleDeviationExceeded");
      }

      // Clean up
      await program.methods
        .cancelDeposit()
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
    });
  });

  // =========================================================================
  // Receiver != Owner
  // =========================================================================
  describe("Receiver != Owner", () => {
    const receiver = Keypair.generate();
    let receiverSharesAccount: PublicKey;

    before(async () => {
      const airdropSig = await connection.requestAirdrop(receiver.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      receiverSharesAccount = getAssociatedTokenAddressSync(
        sharesMint, receiver.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
    });

    it("deposit with different receiver gets shares minted to receiver", async () => {
      const depositAmount = new BN(20_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .requestDeposit(depositAmount, receiver.publicKey)
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
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      // receiver claims (receiver is claimant since receiver == deposit_request.receiver)
      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: receiver.publicKey,
          vault,
          depositRequest,
          owner: payer.publicKey,
          sharesMint,
          receiverSharesAccount,
          receiver: receiver.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([receiver])
        .rpc();

      const sharesAccount = await getAccount(connection, receiverSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAccount.amount)).to.be.greaterThan(0);
      console.log("  Receiver got shares:", Number(sharesAccount.amount));
    });

    it("redeem with different receiver gets assets sent to receiver", async () => {
      const sharesAccount = await getAccount(connection, receiverSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToRedeem = new BN(Number(sharesAccount.amount));
      const [receiverRedeemRequest] = getRedeemRequestPDA(vault, receiver.publicKey);
      const [claimableTokens] = getClaimableTokensPDA(vault, receiver.publicKey);

      // receiver requests redeem with payer as asset receiver
      await program.methods
        .requestRedeem(sharesToRedeem, payer.publicKey)
        .accountsStrict({
          user: receiver.publicKey,
          vault,
          sharesMint,
          userSharesAccount: receiverSharesAccount,
          shareEscrow,
          redeemRequest: receiverRedeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([receiver])
        .rpc();

      await program.methods
        .fulfillRedeem(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          redeemRequest: receiverRedeemRequest,
          operatorApproval: null,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      const userAssetBefore = await getAccount(connection, userAssetAccount);

      // payer claims (payer is the receiver for this redeem)
      await program.methods
        .claimRedeem()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          assetMint,
          redeemRequest: receiverRedeemRequest,
          owner: receiver.publicKey,
          claimableTokens,
          receiverAssetAccount: userAssetAccount,
          receiver: payer.publicKey,
          operatorApproval: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const userAssetAfter = await getAccount(connection, userAssetAccount);
      expect(Number(userAssetAfter.amount)).to.be.greaterThan(Number(userAssetBefore.amount));
      console.log("  Receiver got assets:", Number(userAssetAfter.amount) - Number(userAssetBefore.amount));
    });
  });

  // =========================================================================
  // Operator Claim for Redeem
  // =========================================================================
  describe("Operator Claim for Redeem", () => {
    it("approved operator claims redeem on behalf of user", async () => {
      const user4 = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(user4.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSig);
      await new Promise((r) => setTimeout(r, 1000));

      // Fund user4 with assets
      const user4AssetAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, assetMint, user4.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
      );
      await mintTo(
        connection, payer, assetMint, user4AssetAta.address, payer.publicKey,
        500_000 * 10 ** ASSET_DECIMALS, [], undefined, TOKEN_PROGRAM_ID
      );

      const user4SharesAccount = getAssociatedTokenAddressSync(
        sharesMint, user4.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Deposit flow for user4
      const [user4DepositRequest] = getDepositRequestPDA(vault, user4.publicKey);
      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .requestDeposit(depositAmount, user4.publicKey)
        .accountsStrict({
          user: user4.publicKey,
          vault,
          assetMint,
          userAssetAccount: user4AssetAta.address,
          assetVault,
          depositRequest: user4DepositRequest,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user4])
        .rpc();

      await program.methods
        .fulfillDeposit(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          depositRequest: user4DepositRequest,
          operatorApproval: null,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      await program.methods
        .claimDeposit()
        .accountsStrict({
          claimant: user4.publicKey,
          vault,
          depositRequest: user4DepositRequest,
          owner: user4.publicKey,
          sharesMint,
          receiverSharesAccount: user4SharesAccount,
          receiver: user4.publicKey,
          operatorApproval: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user4])
        .rpc();

      // User4 approves payer as claim operator
      const [claimApproval] = getOperatorApprovalPDA(vault, user4.publicKey, payer.publicKey);
      await program.methods
        .setOperator(payer.publicKey, false, false, true)
        .accountsStrict({
          owner: user4.publicKey,
          vault,
          operatorApproval: claimApproval,
          systemProgram: SystemProgram.programId,
        })
        .signers([user4])
        .rpc();

      // Redeem flow
      const sharesAccount = await getAccount(connection, user4SharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesToRedeem = new BN(Number(sharesAccount.amount));
      const [user4RedeemRequest] = getRedeemRequestPDA(vault, user4.publicKey);
      const [claimableTokens] = getClaimableTokensPDA(vault, user4.publicKey);

      await program.methods
        .requestRedeem(sharesToRedeem, user4.publicKey)
        .accountsStrict({
          user: user4.publicKey,
          vault,
          sharesMint,
          userSharesAccount: user4SharesAccount,
          shareEscrow,
          redeemRequest: user4RedeemRequest,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user4])
        .rpc();

      await program.methods
        .fulfillRedeem(null)
        .accountsStrict({
          operator: operator.publicKey,
          vault,
          redeemRequest: user4RedeemRequest,
          operatorApproval: null,
          assetMint,
          assetVault,
          sharesMint,
          shareEscrow,
          claimableTokens,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          clock: SYSVAR_CLOCK_PUBKEY,
        })
        .signers([operator])
        .rpc();

      // payer (approved operator) claims redeem on behalf of user4
      const user4AssetBefore = await getAccount(connection, user4AssetAta.address);

      await program.methods
        .claimRedeem()
        .accountsStrict({
          claimant: payer.publicKey,
          vault,
          assetMint,
          redeemRequest: user4RedeemRequest,
          owner: user4.publicKey,
          claimableTokens,
          receiverAssetAccount: user4AssetAta.address,
          receiver: user4.publicKey,
          operatorApproval: claimApproval,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const user4AssetAfter = await getAccount(connection, user4AssetAta.address);
      expect(Number(user4AssetAfter.amount)).to.be.greaterThan(Number(user4AssetBefore.amount));
      console.log("  Operator claimed assets for user4:", Number(user4AssetAfter.amount) - Number(user4AssetBefore.amount));
    });
  });
});
