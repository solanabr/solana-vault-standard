import * as anchor from "@coral-xyz/anchor";
import { BN, Idl, Program } from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { expect } from "chai";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
} from "spl-token-bankrun";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("2iu8yL4cuJkG5aYQWpn5Tos5mJfsR1D2JibVWA8E3UiT");
const IDL_PATH = resolve("target/idl/svs_10.json");
const PROGRAM_SO_PATH = resolve("target/deploy/svs_10.so");
const ASSET_DECIMALS = 6;
const DEPOSIT_AMOUNT = 250_000n * 10n ** BigInt(ASSET_DECIMALS);

const getVaultPda = (assetMint: PublicKey, vaultId: BN): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("async_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  )[0];

const getSharesMintPda = (vault: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], PROGRAM_ID)[0];

const getShareEscrowPda = (vault: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("share_escrow"), vault.toBuffer()], PROGRAM_ID)[0];

const getDepositRequestPda = (vault: PublicKey, owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_request"), vault.toBuffer(), owner.toBuffer()],
    PROGRAM_ID
  )[0];

const getRedeemRequestPda = (vault: PublicKey, owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_request"), vault.toBuffer(), owner.toBuffer()],
    PROGRAM_ID
  )[0];

const getClaimableEscrowPda = (vault: PublicKey, owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("claimable"), vault.toBuffer(), owner.toBuffer()],
    PROGRAM_ID
  )[0];

interface AsyncVaultAccountView {
  assetMint: PublicKey;
  totalAssets: BN;
  totalShares: BN;
  pendingDepositAssets: BN;
  pendingClaimShares: BN;
  paused: boolean;
}

const fetchAsyncVault = async (
  program: Program<Idl>,
  vault: PublicKey
): Promise<AsyncVaultAccountView> => {
  const accountNamespace = program.account as Record<
    string,
    { fetch(address: PublicKey): Promise<unknown> }
  >;
  const account = await accountNamespace["asyncVault"].fetch(vault);
  return account as AsyncVaultAccountView;
};

describe("svs-10 bankrun", function () {
  let context: Awaited<ReturnType<typeof startAnchor>>;
  let provider: BankrunProvider;
  let program: Program<Idl>;
  let payer: Keypair;
  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let shareEscrow: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  let depositRequest: PublicKey;
  let redeemRequest: PublicKey;
  let claimableEscrow: PublicKey;
  let claimableTokens: PublicKey;
  const vaultId = new BN(10);

  before(async function () {
    if (!existsSync(IDL_PATH) || !existsSync(PROGRAM_SO_PATH)) {
      this.skip();
    }

    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;
    context = await startAnchor(resolve("."), [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new Program(idl, provider);
    payer = provider.wallet.payer;

    assetMint = await createMint(
      context.banksClient,
      payer,
      payer.publicKey,
      null,
      ASSET_DECIMALS
    );

    vault = getVaultPda(assetMint, vaultId);
    sharesMint = getSharesMintPda(vault);
    shareEscrow = getShareEscrowPda(vault);
    depositRequest = getDepositRequestPda(vault, payer.publicKey);
    redeemRequest = getRedeemRequestPda(vault, payer.publicKey);
    claimableEscrow = getClaimableEscrowPda(vault, payer.publicKey);

    assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    claimableTokens = getAssociatedTokenAddressSync(
      assetMint,
      claimableEscrow,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    userAssetAccount = await createAssociatedTokenAccount(
      context.banksClient,
      payer,
      assetMint,
      payer.publicKey
    );

    await mintTo(
      context.banksClient,
      payer,
      assetMint,
      userAssetAccount,
      payer,
      1_000_000n * 10n ** BigInt(ASSET_DECIMALS)
    );

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it("initializes an async vault", async function () {
    await program.methods
      .initialize(vaultId, "SVS-10 Async", "svAsync", "https://example.com/svs10.json", new BN(3600))
      .accountsStrict({
        authority: payer.publicKey,
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
      .signers([payer])
      .rpc();

    const vaultAccount = await fetchAsyncVault(program, vault);
    expect(vaultAccount.assetMint.toBase58()).to.equal(assetMint.toBase58());
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
    expect(vaultAccount.pendingDepositAssets.toNumber()).to.equal(0);
    expect(vaultAccount.pendingClaimShares.toNumber()).to.equal(0);
    expect(vaultAccount.paused).to.equal(false);
  });

  it("executes request -> fulfill -> claim for deposits", async function () {
    await program.methods
      .requestDeposit(new BN(DEPOSIT_AMOUNT.toString()), payer.publicKey)
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
      .signers([payer])
      .rpc();

    let vaultAccount = await fetchAsyncVault(program, vault);
    expect(vaultAccount.pendingDepositAssets.toString()).to.equal(DEPOSIT_AMOUNT.toString());
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);

    await program.methods
      .fulfillDeposit()
      .accounts({
        operator: payer.publicKey,
        vault,
        depositRequest,
        sharesMint,
      })
      .signers([payer])
      .rpc();

    vaultAccount = await fetchAsyncVault(program, vault);
    expect(vaultAccount.pendingDepositAssets.toNumber()).to.equal(0);
    expect(vaultAccount.totalAssets.toString()).to.equal(DEPOSIT_AMOUNT.toString());
    expect(vaultAccount.pendingClaimShares.toNumber()).to.be.greaterThan(0);

    await program.methods
      .claimDeposit()
      .accounts({
        claimant: payer.publicKey,
        owner: payer.publicKey,
        receiver: payer.publicKey,
        vault,
        depositRequest,
        sharesMint,
        receiverSharesAccount: userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const shareAccount = await getAccount(context.banksClient, userSharesAccount);
    vaultAccount = await fetchAsyncVault(program, vault);

    expect(Number(shareAccount.amount)).to.be.greaterThan(0);
    expect(vaultAccount.pendingClaimShares.toNumber()).to.equal(0);
    expect(vaultAccount.totalShares.toNumber()).to.equal(Number(shareAccount.amount));
  });

  it("executes request -> fulfill -> claim for redeems", async function () {
    const sharesBefore = await getAccount(context.banksClient, userSharesAccount);
    const redeemAmount = BigInt(sharesBefore.amount) / 2n;
    expect(redeemAmount > 0n).to.equal(true);

    await program.methods
      .requestRedeem(new BN(redeemAmount.toString()), payer.publicKey)
      .accountsStrict({
        user: payer.publicKey,
        vault,
        sharesMint,
        userSharesAccount: userSharesAccount,
        shareEscrow,
        redeemRequest,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    await program.methods
      .fulfillRedeem()
      .accounts({
        operator: payer.publicKey,
        vault,
        redeemRequest,
        assetMint,
        assetVault,
        sharesMint,
        shareEscrow,
        claimableEscrow,
        claimableTokens,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const userAssetsBefore = await getAccount(context.banksClient, userAssetAccount);

    await program.methods
      .claimRedeem()
      .accounts({
        claimant: payer.publicKey,
        owner: payer.publicKey,
        receiver: payer.publicKey,
        vault,
        redeemRequest,
        claimableEscrow,
        assetMint,
        claimableTokens,
        receiverAssetAccount: userAssetAccount,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const userAssetsAfter = await getAccount(context.banksClient, userAssetAccount);
    const vaultAccount = await fetchAsyncVault(program, vault);

    expect(BigInt(userAssetsAfter.amount) > BigInt(userAssetsBefore.amount)).to.equal(true);
    expect(vaultAccount.totalAssets.toString()).to.not.equal(DEPOSIT_AMOUNT.toString());
  });
});
