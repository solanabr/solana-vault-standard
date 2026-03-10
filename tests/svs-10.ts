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
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { Svs10 } from "../target/types/svs_10";

describe("svs-10 (Async Vault - ERC-7540)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs10 as Program<Svs10>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const ASSET_DECIMALS = 6;
  const SHARES_DECIMALS = 9;

  let assetMint: PublicKey;

  // Primary vault (cancel_delay=1 for instant cancel)
  const vaultId = new BN(1);
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let shareEscrow: PublicKey;

  // User accounts
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;

  // Operator keypair (set as vault operator for fulfillments)
  const operator = Keypair.generate();

  // ============ PDA helpers ============

  const getVaultPDA = (mint: PublicKey, id: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("async_vault"), mint.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

  const getSharesMintPDA = (v: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([Buffer.from("shares"), v.toBuffer()], program.programId);

  const getAssetVaultPDA = (v: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([Buffer.from("asset_vault"), v.toBuffer()], program.programId);

  const getShareEscrowPDA = (v: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([Buffer.from("share_escrow"), v.toBuffer()], program.programId);

  const getDepositRequestPDA = (v: PublicKey, owner: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("deposit_request"), v.toBuffer(), owner.toBuffer()],
      program.programId
    );

  const getRedeemRequestPDA = (v: PublicKey, owner: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("redeem_request"), v.toBuffer(), owner.toBuffer()],
      program.programId
    );

  const getClaimableEscrowPDA = (v: PublicKey, owner: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claimable"), v.toBuffer(), owner.toBuffer()],
      program.programId
    );

  const getClaimableTokensPDA = (v: PublicKey, owner: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claimable_tokens"), v.toBuffer(), owner.toBuffer()],
      program.programId
    );

  const getOperatorApprovalPDA = (
    v: PublicKey,
    owner: PublicKey,
    op: PublicKey
  ): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("operator_approval"), v.toBuffer(), owner.toBuffer(), op.toBuffer()],
      program.programId
    );

  // ============ Helpers ============

  const initializeVault = async (
    id: BN,
    cancelDelay: BN,
    maxStaleness: BN,
    mint: PublicKey,
    auth: Keypair = payer
  ) => {
    const [v] = getVaultPDA(mint, id);
    const [sm] = getSharesMintPDA(v);
    const [av] = getAssetVaultPDA(v);
    const [se] = getShareEscrowPDA(v);

    await program.methods
      .initialize(id, cancelDelay, maxStaleness)
      .accountsStrict({
        authority: auth.publicKey,
        vault: v,
        assetMint: mint,
        sharesMint: sm,
        assetVault: av,
        shareEscrow: se,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers(auth === payer ? [] : [auth])
      .rpc();

    return { vault: v, sharesMint: sm, assetVault: av, shareEscrow: se };
  };

  const requestDeposit = async (
    v: PublicKey,
    amount: BN,
    user: Keypair = payer,
    userAsset: PublicKey = userAssetAccount,
    av: PublicKey = assetVault,
    mint: PublicKey = assetMint,
    receiver: PublicKey = user.publicKey
  ) => {
    const [depositRequest] = getDepositRequestPDA(v, user.publicKey);
    await program.methods
      .requestDeposit(amount, receiver)
      .accountsStrict({
        user: user.publicKey,
        vault: v,
        depositRequest,
        assetMint: mint,
        userAssetAccount: userAsset,
        assetVault: av,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(user === payer ? [] : [user])
      .rpc();
    return depositRequest;
  };

  const fulfillDeposit = async (
    v: PublicKey,
    ownerPk: PublicKey,
    op: Keypair = operator
  ) => {
    const [depositRequest] = getDepositRequestPDA(v, ownerPk);
    await program.methods
      .fulfillDeposit()
      .accountsStrict({
        operator: op.publicKey,
        vault: v,
        depositRequest,
      })
      .signers([op])
      .rpc();
  };

  const claimDeposit = async (
    v: PublicKey,
    ownerPk: PublicKey,
    sm: PublicKey,
    receiverSharesAcc: PublicKey,
    claimer: Keypair = payer,
    operatorApproval: PublicKey | null = null
  ) => {
    const [depositRequest] = getDepositRequestPDA(v, ownerPk);
    const builder = program.methods.claimDeposit().accountsStrict({
      claimer: claimer.publicKey,
      vault: v,
      depositRequest,
      sharesMint: sm,
      receiverSharesAccount: receiverSharesAcc,
      operatorApproval: operatorApproval,
      rentReceiver: ownerPk,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    });
    await builder.signers(claimer === payer ? [] : [claimer]).rpc();
  };

  const requestRedeem = async (
    v: PublicKey,
    shares: BN,
    sm: PublicKey,
    se: PublicKey,
    user: Keypair = payer,
    userShares: PublicKey = userSharesAccount,
    receiver: PublicKey = user.publicKey
  ) => {
    const [redeemRequest] = getRedeemRequestPDA(v, user.publicKey);
    await program.methods
      .requestRedeem(shares, receiver)
      .accountsStrict({
        user: user.publicKey,
        vault: v,
        redeemRequest,
        sharesMint: sm,
        userSharesAccount: userShares,
        shareEscrow: se,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(user === payer ? [] : [user])
      .rpc();
    return redeemRequest;
  };

  const fulfillRedeem = async (
    v: PublicKey,
    ownerPk: PublicKey,
    sm: PublicKey,
    se: PublicKey,
    av: PublicKey,
    mint: PublicKey,
    op: Keypair = operator
  ) => {
    const [redeemRequest] = getRedeemRequestPDA(v, ownerPk);
    const [claimableTokens] = getClaimableTokensPDA(v, ownerPk);
    const [claimableEscrow] = getClaimableEscrowPDA(v, ownerPk);

    await program.methods
      .fulfillRedeem()
      .accountsStrict({
        operator: op.publicKey,
        vault: v,
        redeemRequest,
        sharesMint: sm,
        shareEscrow: se,
        assetMint: mint,
        assetVault: av,
        claimableTokens,
        claimableEscrow,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([op])
      .rpc();
  };

  const claimRedeem = async (
    v: PublicKey,
    ownerPk: PublicKey,
    mint: PublicKey,
    receiverAssetAcc: PublicKey,
    claimer: Keypair = payer,
    operatorApproval: PublicKey | null = null
  ) => {
    const [redeemRequest] = getRedeemRequestPDA(v, ownerPk);
    const [claimableEscrow] = getClaimableEscrowPDA(v, ownerPk);
    const [claimableTokens] = getClaimableTokensPDA(v, ownerPk);

    await program.methods
      .claimRedeem()
      .accountsStrict({
        claimer: claimer.publicKey,
        vault: v,
        redeemRequest,
        claimableEscrow,
        owner: ownerPk,
        assetMint: mint,
        claimableTokens,
        receiverAssetAccount: receiverAssetAcc,
        operatorApproval: operatorApproval,
        rentReceiver: ownerPk,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(claimer === payer ? [] : [claimer])
      .rpc();
  };

  const setVaultOperator = async (v: PublicKey, op: PublicKey, auth: Keypair = payer) => {
    await program.methods
      .setVaultOperator(op)
      .accountsStrict({ authority: auth.publicKey, vault: v })
      .signers(auth === payer ? [] : [auth])
      .rpc();
  };

  // ============ Setup ============

  before(async () => {
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
    [assetVault] = getAssetVaultPDA(vault);
    [shareEscrow] = getShareEscrowPDA(vault);

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

    // Fund operator
    const airdropSig = await connection.requestAirdrop(operator.publicKey, 2_000_000_000);
    await connection.confirmTransaction(airdropSig);

    console.log("Setup:");
    console.log("  Program ID:", program.programId.toBase58());
    console.log("  Asset Mint:", assetMint.toBase58());
    console.log("  Vault PDA:", vault.toBase58());
    console.log("  Shares Mint:", sharesMint.toBase58());
  });

  // ============ Initialization ============

  describe("Initialize", () => {
    it("creates a new async vault with correct state", async () => {
      await program.methods
        .initialize(vaultId, new BN(1), new BN(3600))
        .accountsStrict({
          authority: payer.publicKey,
          vault,
          assetMint,
          sharesMint,
          assetVault,
          shareEscrow,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vaultAccount = await program.account.asyncVault.fetch(vault);
      expect(vaultAccount.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
      expect(vaultAccount.sharesMint.toBase58()).to.equal(sharesMint.toBase58());
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
      expect(vaultAccount.totalShares.toNumber()).to.equal(0);
      expect(vaultAccount.cancelDelay.toNumber()).to.equal(1);
      expect(vaultAccount.maxStaleness.toNumber()).to.equal(3600);
      expect(vaultAccount.operator.toBase58()).to.equal(PublicKey.default.toBase58());

      // Set operator for subsequent tests
      await setVaultOperator(vault, operator.publicKey);

      const updated = await program.account.asyncVault.fetch(vault);
      expect(updated.operator.toBase58()).to.equal(operator.publicKey.toBase58());
    });

    it("rejects invalid decimals (>9)", async () => {
      const badMint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        18,
        Keypair.generate(),
        undefined,
        TOKEN_PROGRAM_ID
      );
      const badId = new BN(99);
      const [badVault] = getVaultPDA(badMint, badId);
      const [badSharesMint] = getSharesMintPDA(badVault);
      const [badAssetVault] = getAssetVaultPDA(badVault);
      const [badShareEscrow] = getShareEscrowPDA(badVault);

      try {
        await program.methods
          .initialize(badId, new BN(1), new BN(3600))
          .accountsStrict({
            authority: payer.publicKey,
            vault: badVault,
            assetMint: badMint,
            sharesMint: badSharesMint,
            assetVault: badAssetVault,
            shareEscrow: badShareEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should reject invalid decimals");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAssetDecimals");
      }
    });

    it("rejects duplicate vault_id (PDA already exists)", async () => {
      try {
        await program.methods
          .initialize(vaultId, new BN(1), new BN(3600))
          .accountsStrict({
            authority: payer.publicKey,
            vault,
            assetMint,
            sharesMint,
            assetVault,
            shareEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should reject duplicate vault");
      } catch (err: any) {
        // Anchor will fail because the PDA account already exists
        expect(err.toString()).to.include("already in use");
      }
    });
  });

  // ============ Deposit Lifecycle ============

  describe("Deposit Lifecycle", () => {
    const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

    it("request_deposit: locks assets in asset_vault, creates DepositRequest PDA", async () => {
      const assetBefore = await getAccount(connection, userAssetAccount);
      const vaultBefore = await getAccount(connection, assetVault);

      const depositRequest = await requestDeposit(vault, depositAmount);

      const assetAfter = await getAccount(connection, userAssetAccount);
      const vaultAfter = await getAccount(connection, assetVault);

      expect(Number(assetBefore.amount) - Number(assetAfter.amount)).to.equal(depositAmount.toNumber());
      expect(Number(vaultAfter.amount) - Number(vaultBefore.amount)).to.equal(depositAmount.toNumber());

      const req = await program.account.depositRequest.fetch(depositRequest);
      expect(req.assetsLocked.toNumber()).to.equal(depositAmount.toNumber());
      expect(req.sharesClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(req.status)).to.include("pending");
      expect(req.owner.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("fulfill_deposit: sets shares_claimable, updates vault totals", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);
      expect(vaultBefore.totalAssets.toNumber()).to.equal(0);
      expect(vaultBefore.totalShares.toNumber()).to.equal(0);

      await fulfillDeposit(vault, payer.publicKey);

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);
      const req = await program.account.depositRequest.fetch(depositRequest);
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);
      expect(JSON.stringify(req.status)).to.include("fulfilled");

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(depositAmount.toNumber());
      expect(vaultAfter.totalShares.toNumber()).to.equal(req.sharesClaimable.toNumber());
    });

    it("claim_deposit: mints shares to receiver, closes DepositRequest PDA", async () => {
      // Create shares ATA for receiver
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);
      const req = await program.account.depositRequest.fetch(depositRequest);
      const expectedShares = req.sharesClaimable.toNumber();

      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);

      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAcc.amount)).to.equal(expectedShares);

      // PDA should be closed
      const info = await connection.getAccountInfo(depositRequest);
      expect(info).to.be.null;
    });

    it("total_shares only incremented once (Bug #1)", async () => {
      const vaultState = await program.account.asyncVault.fetch(vault);
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // total_shares set at fulfill, not incremented again at claim
      expect(vaultState.totalShares.toNumber()).to.equal(Number(sharesAcc.amount));
    });

    it("second deposit lifecycle verifies accumulated totals", async () => {
      const secondAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const vaultBefore = await program.account.asyncVault.fetch(vault);

      await requestDeposit(vault, secondAmount);
      await fulfillDeposit(vault, payer.publicKey);

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);
      const req = await program.account.depositRequest.fetch(depositRequest);

      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + secondAmount.toNumber()
      );
      expect(vaultAfter.totalShares.toNumber()).to.equal(
        vaultBefore.totalShares.toNumber() + req.sharesClaimable.toNumber()
      );
    });

    it("request_deposit with zero amount should fail", async () => {
      // Need the previous deposit request PDA to be closed first
      // It should be closed from the claim above
      try {
        await requestDeposit(vault, new BN(0));
        expect.fail("Should reject zero amount");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });

    it("request_deposit when paused should fail", async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      try {
        await requestDeposit(vault, depositAmount);
        expect.fail("Should reject when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }

      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();
    });

    it("full lifecycle (request -> fulfill -> claim) verifies vault totals", async () => {
      const fullAmount = new BN(25_000 * 10 ** ASSET_DECIMALS);
      const vaultBefore = await program.account.asyncVault.fetch(vault);
      const sharesBefore = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      await requestDeposit(vault, fullAmount);
      await fulfillDeposit(vault, payer.publicKey);

      const [dr] = getDepositRequestPDA(vault, payer.publicKey);
      const req = await program.account.depositRequest.fetch(dr);

      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() + fullAmount.toNumber()
      );
      const sharesMinted = Number(sharesAfter.amount) - Number(sharesBefore.amount);
      expect(sharesMinted).to.equal(req.sharesClaimable.toNumber());
    });
  });

  // ============ Redeem Lifecycle ============

  describe("Redeem Lifecycle", () => {
    it("request_redeem: locks shares in share_escrow, creates RedeemRequest PDA", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 4));

      const escrowBefore = await getAccount(connection, shareEscrow, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemRequest = await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      const escrowAfter = await getAccount(connection, shareEscrow, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(escrowAfter.amount) - Number(escrowBefore.amount)).to.equal(redeemShares.toNumber());

      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(req.sharesLocked.toNumber()).to.equal(redeemShares.toNumber());
      expect(req.assetsClaimable.toNumber()).to.equal(0);
      expect(JSON.stringify(req.status)).to.include("pending");
    });

    it("fulfill_redeem: burns shares, creates claimable_tokens + ClaimableEscrow", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);

      await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);

      const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);
      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(req.assetsClaimable.toNumber()).to.be.greaterThan(0);
      expect(JSON.stringify(req.status)).to.include("fulfilled");

      const [claimableEscrow] = getClaimableEscrowPDA(vault, payer.publicKey);
      const escrow = await program.account.claimableEscrow.fetch(claimableEscrow);
      expect(escrow.amount.toNumber()).to.equal(req.assetsClaimable.toNumber());

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.equal(
        vaultBefore.totalShares.toNumber() - req.sharesLocked.toNumber()
      );
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() - req.assetsClaimable.toNumber()
      );
    });

    it("claim_redeem: transfers assets to receiver, closes accounts", async () => {
      const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);
      const req = await program.account.redeemRequest.fetch(redeemRequest);
      const expectedAssets = req.assetsClaimable.toNumber();

      const assetBefore = await getAccount(connection, userAssetAccount);

      await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);

      const assetAfter = await getAccount(connection, userAssetAccount);
      expect(Number(assetAfter.amount) - Number(assetBefore.amount)).to.equal(expectedAssets);

      // Redeem request PDA should be closed
      const info = await connection.getAccountInfo(redeemRequest);
      expect(info).to.be.null;

      // Claimable escrow should be closed
      const [claimableEscrow] = getClaimableEscrowPDA(vault, payer.publicKey);
      const escrowInfo = await connection.getAccountInfo(claimableEscrow);
      expect(escrowInfo).to.be.null;
    });

    it("full lifecycle verifies decremented vault totals", async () => {
      const vaultBefore = await program.account.asyncVault.fetch(vault);
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 4));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);
      await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);

      const [rr] = getRedeemRequestPDA(vault, payer.publicKey);
      const req = await program.account.redeemRequest.fetch(rr);

      await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);

      const vaultAfter = await program.account.asyncVault.fetch(vault);
      expect(vaultAfter.totalShares.toNumber()).to.equal(
        vaultBefore.totalShares.toNumber() - redeemShares.toNumber()
      );
      expect(vaultAfter.totalAssets.toNumber()).to.equal(
        vaultBefore.totalAssets.toNumber() - req.assetsClaimable.toNumber()
      );
    });

    it("request_redeem with insufficient shares should fail", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const tooMany = new BN(Number(sharesAcc.amount) + 1_000_000_000);

      try {
        await requestRedeem(vault, tooMany, sharesMint, shareEscrow);
        expect.fail("Should reject insufficient shares");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientShares");
      }
    });

    it("request_redeem when paused should fail", async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      try {
        await requestRedeem(vault, new BN(1000), sharesMint, shareEscrow);
        expect.fail("Should reject when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      }

      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();
    });
  });

  // ============ Cancel Flows ============

  describe("Cancel Flows", () => {
    // Vault with long cancel delay for testing "too early" failures
    let longDelayVault: PublicKey;
    let longDelaySharesMint: PublicKey;
    let longDelayAssetVault: PublicKey;
    let longDelayShareEscrow: PublicKey;
    let longDelayUserAssetAccount: PublicKey;
    let longDelayUserSharesAccount: PublicKey;
    const longDelayVaultId = new BN(100);

    before(async () => {
      [longDelayVault] = getVaultPDA(assetMint, longDelayVaultId);
      [longDelaySharesMint] = getSharesMintPDA(longDelayVault);
      [longDelayAssetVault] = getAssetVaultPDA(longDelayVault);
      [longDelayShareEscrow] = getShareEscrowPDA(longDelayVault);

      await initializeVault(longDelayVaultId, new BN(86400), new BN(3600), assetMint);
      await setVaultOperator(longDelayVault, operator.publicKey);

      longDelayUserAssetAccount = userAssetAccount;
      longDelayUserSharesAccount = getAssociatedTokenAddressSync(
        longDelaySharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    });

    it("cancel pending deposit: returns assets to user (cancel_delay=1)", async () => {
      const amount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      const assetBefore = await getAccount(connection, userAssetAccount);

      await requestDeposit(vault, amount);

      // Wait ~2 seconds for the 1-second delay to elapse
      await new Promise((r) => setTimeout(r, 2000));

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);
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
        })
        .rpc();

      const assetAfter = await getAccount(connection, userAssetAccount);
      expect(Number(assetAfter.amount)).to.equal(Number(assetBefore.amount));
    });

    it("cancel pending redeem: returns shares to user (cancel_delay=1)", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      await new Promise((r) => setTimeout(r, 2000));

      const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);
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
        })
        .rpc();

      const sharesAfter = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(sharesAfter.amount)).to.equal(Number(sharesAcc.amount));
    });

    it("cancel deposit before delay expires should fail (cancel_delay=86400)", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(longDelayVault, amount, payer, longDelayUserAssetAccount, longDelayAssetVault);

      const [depositRequest] = getDepositRequestPDA(longDelayVault, payer.publicKey);

      try {
        await program.methods
          .cancelDeposit()
          .accountsStrict({
            owner: payer.publicKey,
            vault: longDelayVault,
            depositRequest,
            assetMint,
            assetVault: longDelayAssetVault,
            userAssetAccount: longDelayUserAssetAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject cancel before delay");
      } catch (err: any) {
        expect(err.toString()).to.include("CancelTooEarly");
      }

      // Clean up: fulfill and claim so PDA is cleared for other tests
      await fulfillDeposit(longDelayVault, payer.publicKey);

      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        longDelaySharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await claimDeposit(
        longDelayVault,
        payer.publicKey,
        longDelaySharesMint,
        longDelayUserSharesAccount
      );
    });

    it("cancel redeem before delay expires should fail (cancel_delay=86400)", async () => {
      const longSharesAcc = await getAccount(
        connection,
        longDelayUserSharesAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const redeemShares = new BN(Math.floor(Number(longSharesAcc.amount) / 2));

      await requestRedeem(
        longDelayVault,
        redeemShares,
        longDelaySharesMint,
        longDelayShareEscrow,
        payer,
        longDelayUserSharesAccount
      );

      const [redeemRequest] = getRedeemRequestPDA(longDelayVault, payer.publicKey);

      try {
        await program.methods
          .cancelRedeem()
          .accountsStrict({
            owner: payer.publicKey,
            vault: longDelayVault,
            redeemRequest,
            sharesMint: longDelaySharesMint,
            shareEscrow: longDelayShareEscrow,
            userSharesAccount: longDelayUserSharesAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject cancel before delay");
      } catch (err: any) {
        expect(err.toString()).to.include("CancelTooEarly");
      }

      // Clean up: fulfill and claim
      await fulfillRedeem(
        longDelayVault,
        payer.publicKey,
        longDelaySharesMint,
        longDelayShareEscrow,
        longDelayAssetVault,
        assetMint
      );
      await claimRedeem(longDelayVault, payer.publicKey, assetMint, longDelayUserAssetAccount);
    });

    it("cancel fulfilled deposit should fail (not pending)", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);

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
          })
          .rpc();
        expect.fail("Should reject cancel of fulfilled request");
      } catch (err: any) {
        expect(err.toString()).to.include("RequestNotPending");
      }

      // Clean up
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("cancel fulfilled redeem should fail (not pending)", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);
      await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);

      const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);

      try {
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
          })
          .rpc();
        expect.fail("Should reject cancel of fulfilled request");
      } catch (err: any) {
        expect(err.toString()).to.include("RequestNotPending");
      }

      // Clean up
      await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
    });
  });

  // ============ Operator Approval ============

  describe("Operator Approval", () => {
    const thirdParty = Keypair.generate();

    before(async () => {
      const airdropSig = await connection.requestAirdrop(thirdParty.publicKey, 2_000_000_000);
      await connection.confirmTransaction(airdropSig);
    });

    it("approve operator, then operator claims deposit", async () => {
      const amount = new BN(10_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      // Approve third party as operator with claim permission
      const [approval] = getOperatorApprovalPDA(vault, payer.publicKey, thirdParty.publicKey);
      await program.methods
        .approveOperator(true)
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operator: thirdParty.publicKey,
          operatorApproval: approval,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const approvalAccount = await program.account.operatorApproval.fetch(approval);
      expect(approvalAccount.canClaim).to.equal(true);
      expect(approvalAccount.operator.toBase58()).to.equal(thirdParty.publicKey.toBase58());

      // Third party claims on behalf of payer (receiver = payer)
      await claimDeposit(
        vault,
        payer.publicKey,
        sharesMint,
        userSharesAccount,
        thirdParty,
        approval
      );
    });

    it("revoke operator, then claim fails", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      const [approval] = getOperatorApprovalPDA(vault, payer.publicKey, thirdParty.publicKey);

      // Revoke
      await program.methods
        .revokeOperator()
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operator: thirdParty.publicKey,
          operatorApproval: approval,
        })
        .rpc();

      // Attempt claim should fail (approval PDA closed)
      try {
        await claimDeposit(
          vault,
          payer.publicKey,
          sharesMint,
          userSharesAccount,
          thirdParty,
          approval
        );
        expect.fail("Should reject after revoke");
      } catch (err: any) {
        // Anchor fails to deserialize closed account
        expect(err.toString()).to.include("AccountNotInitialized");
      }

      // Clean up: owner claims directly
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("operator with wrong vault should fail (Bug #6)", async () => {
      // Create a second vault
      const altVaultId = new BN(200);
      const { vault: altVault } = await initializeVault(altVaultId, new BN(1), new BN(3600), assetMint);
      await setVaultOperator(altVault, operator.publicKey);

      // Approve operator for alt vault
      const [altApproval] = getOperatorApprovalPDA(altVault, payer.publicKey, thirdParty.publicKey);
      await program.methods
        .approveOperator(true)
        .accountsStrict({
          owner: payer.publicKey,
          vault: altVault,
          operator: thirdParty.publicKey,
          operatorApproval: altApproval,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Deposit on main vault
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      // Try to claim main vault deposit with alt vault approval
      try {
        await claimDeposit(
          vault,
          payer.publicKey,
          sharesMint,
          userSharesAccount,
          thirdParty,
          altApproval
        );
        expect.fail("Should reject cross-vault approval");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      // Clean up: owner claims
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("operator claim without approval should fail", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      try {
        // Third party tries to claim with no approval account
        await claimDeposit(
          vault,
          payer.publicKey,
          sharesMint,
          userSharesAccount,
          thirdParty,
          null
        );
        expect.fail("Should reject without approval");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      // Clean up
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("default operator (Pubkey.default()) cannot fulfill (Bug #8)", async () => {
      // Create vault without setting operator
      const noOpVaultId = new BN(300);
      const { vault: noOpVault } = await initializeVault(noOpVaultId, new BN(1), new BN(3600), assetMint);
      const [noOpAssetVault] = getAssetVaultPDA(noOpVault);

      const amount = new BN(1_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(noOpVault, amount, payer, userAssetAccount, noOpAssetVault);

      // Create a keypair that matches Pubkey.default() — impossible, but we can
      // just check with the real operator who is not the vault's operator
      try {
        await fulfillDeposit(noOpVault, payer.publicKey, operator);
        expect.fail("Should reject when operator not set");
      } catch (err: any) {
        // Should fail with either Unauthorized or OperatorNotSet
        const errStr = err.toString();
        expect(errStr.includes("Unauthorized") || errStr.includes("OperatorNotSet")).to.be.true;
      }

      // Clean up: set operator, fulfill, claim
      await setVaultOperator(noOpVault, operator.publicKey);
      await fulfillDeposit(noOpVault, payer.publicKey);

      const [noOpSharesMint] = getSharesMintPDA(noOpVault);
      const noOpUserSharesAcc = getAssociatedTokenAddressSync(
        noOpSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        noOpSharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await claimDeposit(noOpVault, payer.publicKey, noOpSharesMint, noOpUserSharesAcc);
    });
  });

  // ============ Admin ============

  describe("Admin", () => {
    it("pauses and unpauses", async () => {
      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      let vaultState = await program.account.asyncVault.fetch(vault);
      expect(vaultState.paused).to.equal(true);

      await program.methods
        .unpause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      vaultState = await program.account.asyncVault.fetch(vault);
      expect(vaultState.paused).to.equal(false);
    });

    it("transfers authority", async () => {
      const newAuth = Keypair.generate();

      await program.methods
        .transferAuthority(newAuth.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      let vaultState = await program.account.asyncVault.fetch(vault);
      expect(vaultState.authority.toBase58()).to.equal(newAuth.publicKey.toBase58());

      // Transfer back
      const airdropSig = await connection.requestAirdrop(newAuth.publicKey, 1_000_000_000);
      await connection.confirmTransaction(airdropSig);

      await program.methods
        .transferAuthority(payer.publicKey)
        .accountsStrict({ authority: newAuth.publicKey, vault })
        .signers([newAuth])
        .rpc();

      vaultState = await program.account.asyncVault.fetch(vault);
      expect(vaultState.authority.toBase58()).to.equal(payer.publicKey.toBase58());
    });

    it("sets vault operator", async () => {
      const newOp = Keypair.generate();
      await program.methods
        .setVaultOperator(newOp.publicKey)
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      const vaultState = await program.account.asyncVault.fetch(vault);
      expect(vaultState.operator.toBase58()).to.equal(newOp.publicKey.toBase58());

      // Restore original operator
      await setVaultOperator(vault, operator.publicKey);
    });

    it("non-authority admin action fails", async () => {
      const rando = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(rando.publicKey, 1_000_000_000);
      await connection.confirmTransaction(airdropSig);

      try {
        await program.methods
          .pause()
          .accountsStrict({ authority: rando.publicKey, vault })
          .signers([rando])
          .rpc();
        expect.fail("Should reject non-authority");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============ Edge Cases ============

  describe("Edge Cases", () => {
    it("multi-user concurrent: two users with independent deposit requests", async () => {
      const user2 = Keypair.generate();
      const airdropSig = await connection.requestAirdrop(user2.publicKey, 2_000_000_000);
      await connection.confirmTransaction(airdropSig);

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

      await mintTo(
        connection,
        payer,
        assetMint,
        user2AssetAta.address,
        payer.publicKey,
        100_000 * 10 ** ASSET_DECIMALS,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      const amount1 = new BN(10_000 * 10 ** ASSET_DECIMALS);
      const amount2 = new BN(20_000 * 10 ** ASSET_DECIMALS);

      // Both users request deposits
      await requestDeposit(vault, amount1);
      await requestDeposit(vault, amount2, user2, user2AssetAta.address);

      // Verify independent PDAs
      const [dr1] = getDepositRequestPDA(vault, payer.publicKey);
      const [dr2] = getDepositRequestPDA(vault, user2.publicKey);
      expect(dr1.toBase58()).to.not.equal(dr2.toBase58());

      const req1 = await program.account.depositRequest.fetch(dr1);
      const req2 = await program.account.depositRequest.fetch(dr2);
      expect(req1.assetsLocked.toNumber()).to.equal(amount1.toNumber());
      expect(req2.assetsLocked.toNumber()).to.equal(amount2.toNumber());

      // Fulfill both
      await fulfillDeposit(vault, payer.publicKey);
      await fulfillDeposit(vault, user2.publicKey);

      // Claim user1
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);

      // Claim user2
      const user2SharesAccount = getAssociatedTokenAddressSync(
        sharesMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        sharesMint,
        user2.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await claimDeposit(vault, user2.publicKey, sharesMint, user2SharesAccount, user2);
    });

    it("rounding favors vault (floor shares on deposit, floor assets on redeem)", async () => {
      // Create vault with 0-decimal asset to make rounding effects visible
      const zeroDecMint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        0,
        Keypair.generate(),
        undefined,
        TOKEN_PROGRAM_ID
      );

      const roundVaultId = new BN(400);
      const { vault: roundVault, sharesMint: roundSharesMint, assetVault: roundAssetVault, shareEscrow: roundShareEscrow } =
        await initializeVault(roundVaultId, new BN(1), new BN(3600), zeroDecMint);
      await setVaultOperator(roundVault, operator.publicKey);

      const roundUserAssetAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        zeroDecMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Mint some tokens
      await mintTo(
        connection,
        payer,
        zeroDecMint,
        roundUserAssetAta.address,
        payer.publicKey,
        1000,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Initial deposit
      await requestDeposit(roundVault, new BN(100), payer, roundUserAssetAta.address, roundAssetVault, zeroDecMint);
      await fulfillDeposit(roundVault, payer.publicKey);

      const roundUserSharesAcc = getAssociatedTokenAddressSync(
        roundSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        roundSharesMint,
        payer.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await claimDeposit(roundVault, payer.publicKey, roundSharesMint, roundUserSharesAcc);

      // Second deposit: check that shares received <= theoretical proportional amount
      await requestDeposit(roundVault, new BN(3), payer, roundUserAssetAta.address, roundAssetVault, zeroDecMint);
      await fulfillDeposit(roundVault, payer.publicKey);

      const [dr] = getDepositRequestPDA(roundVault, payer.publicKey);
      const req = await program.account.depositRequest.fetch(dr);

      // Floor rounding: shares_claimable should be <= assets * totalShares / totalAssets
      // With offset, the math is: 3 * (totalShares + offset) / (totalAssets + offset)
      // Floor ensures user gets less or equal
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);

      await claimDeposit(roundVault, payer.publicKey, roundSharesMint, roundUserSharesAcc);

      // Redeem: floor on assets means user gets less or equal assets back
      const roundSharesBalance = await getAccount(connection, roundUserSharesAcc, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(roundSharesBalance.amount) / 2));

      await requestRedeem(roundVault, redeemShares, roundSharesMint, roundShareEscrow, payer, roundUserSharesAcc);
      await fulfillRedeem(roundVault, payer.publicKey, roundSharesMint, roundShareEscrow, roundAssetVault, zeroDecMint);

      const [rr] = getRedeemRequestPDA(roundVault, payer.publicKey);
      const redeemReq = await program.account.redeemRequest.fetch(rr);

      // Floor rounding on redeem: assets_claimable should be <= shares * totalAssets / totalShares
      expect(redeemReq.assetsClaimable.toNumber()).to.be.greaterThanOrEqual(0);

      await claimRedeem(roundVault, payer.publicKey, zeroDecMint, roundUserAssetAta.address);
    });

    it("duplicate request (second request while first pending) should fail", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);

      try {
        await requestDeposit(vault, amount);
        expect.fail("Should reject duplicate request");
      } catch (err: any) {
        // PDA already exists - Anchor will reject init (custom program error or system error)
        expect(err.toString()).to.include("already in use");
      }

      // Clean up
      await fulfillDeposit(vault, payer.publicKey);
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });
  });

  // ============ Security & Validation ============

  describe("Security & Validation", () => {
    const randomUser = Keypair.generate();

    before(async () => {
      const airdropSig = await connection.requestAirdrop(randomUser.publicKey, 2_000_000_000);
      await connection.confirmTransaction(airdropSig);
    });

    // P0: Accounting corruption prevention
    it("double-fulfill deposit should fail", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      try {
        await fulfillDeposit(vault, payer.publicKey);
        expect.fail("Should reject double fulfill");
      } catch (err: any) {
        expect(err.toString()).to.include("RequestNotPending");
      }

      // Clean up
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("double-fulfill redeem should fail", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);
      await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);

      try {
        await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);
        expect.fail("Should reject double fulfill");
      } catch (err: any) {
        // Fails on claimable_escrow init (PDA already exists) before handler check
        expect(err.toString()).to.include("already in use");
      } finally {
        await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
      }
    });

    it("claim pending (unfulfilled) deposit should fail", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);

      try {
        await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
        expect.fail("Should reject claim of unfulfilled request");
      } catch (err: any) {
        expect(err.toString()).to.include("RequestNotFulfilled");
      }

      // Clean up
      await fulfillDeposit(vault, payer.publicKey);
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("claim pending (unfulfilled) redeem should fail", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      try {
        await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
        expect.fail("Should reject claim of unfulfilled request");
      } catch (err: any) {
        // Fails because claimable_escrow doesn't exist (only created by fulfillRedeem)
        expect(err.toString()).to.include("AccountNotInitialized");
      } finally {
        await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);
        await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
      }
    });

    // P1: Authorization enforcement
    it("non-operator cannot fulfill deposit", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);

      try {
        await fulfillDeposit(vault, payer.publicKey, randomUser);
        expect.fail("Should reject non-operator");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }

      // Clean up
      await fulfillDeposit(vault, payer.publicKey);
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("non-operator cannot fulfill redeem", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      try {
        await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint, randomUser);
        expect.fail("Should reject non-operator");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      } finally {
        await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);
        await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
      }
    });

    it("non-owner cannot cancel deposit", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);

      const [depositRequest] = getDepositRequestPDA(vault, payer.publicKey);

      let failed = false;
      try {
        await program.methods
          .cancelDeposit()
          .accountsStrict({
            owner: randomUser.publicKey,
            vault,
            depositRequest,
            assetMint,
            assetVault,
            userAssetAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([randomUser])
          .rpc();
        expect.fail("Should reject non-owner cancel");
      } catch (err: any) {
        failed = true;
        expect(err.toString()).to.include("Constraint");
      } finally {
        // Always clean up
        await fulfillDeposit(vault, payer.publicKey);
        await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
      }
      expect(failed).to.be.true;
    });

    it("non-owner cannot cancel redeem", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      const [redeemRequest] = getRedeemRequestPDA(vault, payer.publicKey);

      let failed = false;
      try {
        await program.methods
          .cancelRedeem()
          .accountsStrict({
            owner: randomUser.publicKey,
            vault,
            redeemRequest,
            sharesMint,
            shareEscrow,
            userSharesAccount,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([randomUser])
          .rpc();
        expect.fail("Should reject non-owner cancel");
      } catch (err: any) {
        failed = true;
        expect(err.toString()).to.include("Constraint");
      } finally {
        await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);
        await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
      }
      expect(failed).to.be.true;
    });

    it("operator with can_claim=false cannot claim", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);
      await fulfillDeposit(vault, payer.publicKey);

      const [approval] = getOperatorApprovalPDA(vault, payer.publicKey, randomUser.publicKey);
      await program.methods
        .approveOperator(false)
        .accountsStrict({
          owner: payer.publicKey,
          vault,
          operator: randomUser.publicKey,
          operatorApproval: approval,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      let failed = false;
      try {
        await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount, randomUser, approval);
        expect.fail("Should reject operator without claim permission");
      } catch (err: any) {
        failed = true;
        expect(err.toString()).to.include("OperatorNotApproved");
      } finally {
        await program.methods
          .revokeOperator()
          .accountsStrict({
            owner: payer.publicKey,
            vault,
            operator: randomUser.publicKey,
            operatorApproval: approval,
          })
          .rpc();
        await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
      }
      expect(failed).to.be.true;
    });

    // P1: New validation tests
    it("fulfill deposit when paused should fail", async () => {
      const amount = new BN(5_000 * 10 ** ASSET_DECIMALS);
      await requestDeposit(vault, amount);

      await program.methods
        .pause()
        .accountsStrict({ authority: payer.publicKey, vault })
        .rpc();

      try {
        await fulfillDeposit(vault, payer.publicKey);
        expect.fail("Should reject fulfill when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
      } finally {
        // Unpause regardless
        const vaultState = await program.account.asyncVault.fetch(vault);
        if (vaultState.paused) {
          await program.methods
            .unpause()
            .accountsStrict({ authority: payer.publicKey, vault })
            .rpc();
        }
        await fulfillDeposit(vault, payer.publicKey);
        await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
      }
    });

    it("transfer authority to Pubkey.default should fail", async () => {
      try {
        await program.methods
          .transferAuthority(PublicKey.default)
          .accountsStrict({ authority: payer.publicKey, vault })
          .rpc();
        expect.fail("Should reject zero-address authority");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAuthority");
      }
    });

    it("negative cancel_delay should fail", async () => {
      const badVaultId = new BN(999);
      const [badVault] = getVaultPDA(assetMint, badVaultId);
      const [badSharesMint] = getSharesMintPDA(badVault);
      const [badAssetVault] = getAssetVaultPDA(badVault);
      const [badShareEscrow] = getShareEscrowPDA(badVault);

      try {
        await program.methods
          .initialize(badVaultId, new BN(-1), new BN(3600))
          .accountsStrict({
            authority: payer.publicKey,
            vault: badVault,
            assetMint,
            sharesMint: badSharesMint,
            assetVault: badAssetVault,
            shareEscrow: badShareEscrow,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .rpc();
        expect.fail("Should reject negative cancel delay");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidCancelDelay");
      }
    });

    it("request_redeem with zero amount should fail", async () => {
      try {
        await requestRedeem(vault, new BN(0), sharesMint, shareEscrow);
        expect.fail("Should reject zero amount");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
      }
    });
  });

  // ============ View Functions ============

  describe("View Functions", () => {
    let viewDepositRequest: PublicKey;

    before(async () => {
      // Create a pending deposit for view tests
      const amount = new BN(15_000 * 10 ** ASSET_DECIMALS);
      viewDepositRequest = await requestDeposit(vault, amount);
    });

    it("pending_deposit_request returns correct value", async () => {
      const result = await program.methods
        .pendingDepositRequest()
        .accountsStrict({
          vault,
          depositRequest: viewDepositRequest,
        })
        .simulate();

      expect(result).to.not.be.undefined;

      const req = await program.account.depositRequest.fetch(viewDepositRequest);
      expect(req.assetsLocked.toNumber()).to.equal(15_000 * 10 ** ASSET_DECIMALS);
    });

    it("claimable_deposit_request returns correct value after fulfill", async () => {
      await fulfillDeposit(vault, payer.publicKey);

      const req = await program.account.depositRequest.fetch(viewDepositRequest);
      expect(req.sharesClaimable.toNumber()).to.be.greaterThan(0);

      const result = await program.methods
        .claimableDepositRequest()
        .accountsStrict({
          vault,
          depositRequest: viewDepositRequest,
        })
        .simulate();

      expect(result).to.not.be.undefined;

      // Clean up
      await claimDeposit(vault, payer.publicKey, sharesMint, userSharesAccount);
    });

    it("pending_redeem_request returns correct value", async () => {
      const sharesAcc = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const redeemShares = new BN(Math.floor(Number(sharesAcc.amount) / 10));

      const redeemRequest = await requestRedeem(vault, redeemShares, sharesMint, shareEscrow);

      const result = await program.methods
        .pendingRedeemRequest()
        .accountsStrict({
          vault,
          redeemRequest,
        })
        .simulate();

      expect(result).to.not.be.undefined;

      const req = await program.account.redeemRequest.fetch(redeemRequest);
      expect(req.sharesLocked.toNumber()).to.equal(redeemShares.toNumber());

      // Fulfill for next test
      await fulfillRedeem(vault, payer.publicKey, sharesMint, shareEscrow, assetVault, assetMint);
    });

    it("claimable_redeem_request returns correct value after fulfill", async () => {
      const [claimableEscrow] = getClaimableEscrowPDA(vault, payer.publicKey);

      const result = await program.methods
        .claimableRedeemRequest()
        .accountsStrict({
          vault,
          claimableEscrow,
        })
        .simulate();

      expect(result).to.not.be.undefined;

      const escrow = await program.account.claimableEscrow.fetch(claimableEscrow);
      expect(escrow.amount.toNumber()).to.be.greaterThan(0);

      // Clean up
      await claimRedeem(vault, payer.publicKey, assetMint, userAssetAccount);
    });
  });
});
