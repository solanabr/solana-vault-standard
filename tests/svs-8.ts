import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMintToInstruction,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { Svs8 } from "../target/types/svs_8";

const MULTI_VAULT_SEED = Buffer.from("multi_vault");
const ASSET_ENTRY_SEED = Buffer.from("asset_entry");
const SHARES_SEED = Buffer.from("shares");

describe("svs-8 (Multi Asset Basket)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Svs8 as Program<Svs8>;
  const user = provider.wallet as anchor.Wallet;

  const VAULT_ID = new BN(1);
  let vaultPda: PublicKey;
  let sharesMint: PublicKey;
  let mintA: PublicKey;
  let assetEntryA: PublicKey;
  let assetVaultA: PublicKey;
  let userAtaA: PublicKey;
  const oracleA = Keypair.generate();

  before(async () => {
    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [MULTI_VAULT_SEED, VAULT_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Derive shares mint PDA
    [sharesMint] = PublicKey.findProgramAddressSync(
      [SHARES_SEED, vaultPda.toBuffer()],
      program.programId
    );
  });

  it("creates mint A", async () => {
    mintA = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    expect(mintA).to.not.be.null;
    console.log("mintA:", mintA.toBase58());
  });

  it("initializes vault", async () => {
    await program.methods
      .initialize(VAULT_ID, "Test Basket", "BSKT", "https://example.com", 6)
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        sharesMint: sharesMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vault.vaultId.toString()).to.equal(VAULT_ID.toString());
    expect(vault.paused).to.be.false;
    expect(vault.numAssets).to.equal(0);
    console.log("vault initialized:", vaultPda.toBase58());
  });

  it("adds asset A", async () => {
    // Derive asset entry PDA
    [assetEntryA] = PublicKey.findProgramAddressSync(
      [ASSET_ENTRY_SEED, vaultPda.toBuffer(), mintA.toBuffer()],
      program.programId
    );

    // Generate a keypair for the vault token account
    const assetVaultKeypair = Keypair.generate();
    assetVaultA = assetVaultKeypair.publicKey;

    await program.methods
      .addAsset(10_000) // 100% weight (single asset)
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        assetMint: mintA,
        oracle: oracleA.publicKey,
        assetEntry: assetEntryA,
        assetVault: assetVaultA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([assetVaultKeypair])
      .rpc();

    const entry = await program.account.assetEntry.fetch(assetEntryA);
    expect(entry.targetWeightBps).to.equal(10_000);
    console.log("asset entry:", assetEntryA.toBase58());
    console.log("asset vault:", assetVaultA.toBase58());
  });

  it("mints tokens to user and deposits single", async () => {
    // Create user ATA for mintA
    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      mintA,
      user.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    userAtaA = userAta.address;

    // Mint 10 tokens to user
    await mintTo(
      provider.connection,
      user.payer,
      mintA,
      userAtaA,
      user.publicKey,
      10_000_000, // 10 tokens (6 decimals)
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Get user shares ATA
    const userSharesAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      sharesMint,
      user.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .depositSingle(new BN(1_000_000), new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        assetEntry: assetEntryA,
        assetMint: mintA,
        assetVaultAccount: assetVaultA,
        sharesMint: sharesMint,
        userAssetAccount: userAtaA,
        userSharesAccount: userSharesAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vault.totalShares.toNumber()).to.be.greaterThan(0);
    console.log("total shares after deposit:", vault.totalShares.toString());
  });

  it("redeems proportional", async () => {
    const vaultBefore = await program.account.multiAssetVault.fetch(vaultPda);
    const sharesToRedeem = vaultBefore.totalShares.divn(2); // redeem half

    const userSharesAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer,
      sharesMint,
      user.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .redeemProportional(sharesToRedeem, new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        assetEntry: assetEntryA,
        assetMint: mintA,
        assetVaultAta: assetVaultA,
        userAssetAta: userAtaA,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAfter = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vaultAfter.totalShares.toNumber()).to.be.lessThan(vaultBefore.totalShares.toNumber());
    console.log("total shares after redeem:", vaultAfter.totalShares.toString());
  });
});
