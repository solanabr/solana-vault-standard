import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { Svs8 } from "../target/types/svs_8";

const MULTI_VAULT_SEED = Buffer.from("multi_vault");
const ASSET_ENTRY_SEED = Buffer.from("asset_entry");
const SHARES_SEED = Buffer.from("shares");
const ORACLE_PRICE_SEED = Buffer.from("oracle_price");

describe("svs-8 (Multi Asset Basket)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Svs8 as Program<Svs8>;
  const user = provider.wallet as anchor.Wallet;

  const VAULT_ID = new BN(1);
  let vaultPda: PublicKey;
  let sharesMint: PublicKey;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let assetEntryA: PublicKey;
  let assetEntryB: PublicKey;
  let assetVaultA: PublicKey;
  let assetVaultB: PublicKey;
  let userAtaA: PublicKey;
  let userAtaB: PublicKey;
  let oraclePriceA: PublicKey;
  let oraclePriceB: PublicKey;
  let userSharesAta: PublicKey;

  before(async () => {
    [vaultPda] = PublicKey.findProgramAddressSync(
      [MULTI_VAULT_SEED, VAULT_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [sharesMint] = PublicKey.findProgramAddressSync(
      [SHARES_SEED, vaultPda.toBuffer()],
      program.programId
    );
  });

  it("creates mint A and mint B", async () => {
    mintA = await createMint(provider.connection, user.payer, user.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    mintB = await createMint(provider.connection, user.payer, user.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    expect(mintA).to.not.be.null;
    expect(mintB).to.not.be.null;
    console.log("mintA:", mintA.toBase58());
    console.log("mintB:", mintB.toBase58());
  });

  it("initializes vault", async () => {
    await program.methods
      .initialize(VAULT_ID, 6)
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
  });

  it("adds asset A (50% weight)", async () => {
    [assetEntryA] = PublicKey.findProgramAddressSync(
      [ASSET_ENTRY_SEED, vaultPda.toBuffer(), mintA.toBuffer()],
      program.programId
    );
    const assetVaultKeypair = Keypair.generate();
    assetVaultA = assetVaultKeypair.publicKey;

    await program.methods
      .addAsset(5_000)
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        assetMint: mintA,
        oracle: Keypair.generate().publicKey,
        assetEntry: assetEntryA,
        assetVault: assetVaultA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([assetVaultKeypair])
      .rpc();

    const entry = await program.account.assetEntry.fetch(assetEntryA);
    expect(entry.targetWeightBps).to.equal(5_000);
  });

  it("adds asset B (50% weight)", async () => {
    [assetEntryB] = PublicKey.findProgramAddressSync(
      [ASSET_ENTRY_SEED, vaultPda.toBuffer(), mintB.toBuffer()],
      program.programId
    );
    const assetVaultKeypair = Keypair.generate();
    assetVaultB = assetVaultKeypair.publicKey;

    await program.methods
      .addAsset(5_000)
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        assetMint: mintB,
        oracle: Keypair.generate().publicKey,
        assetEntry: assetEntryB,
        assetVault: assetVaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([assetVaultKeypair])
      .rpc();

    const vault = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vault.numAssets).to.equal(2);
  });

  it("sets oracle price for asset A", async () => {
    [oraclePriceA] = PublicKey.findProgramAddressSync(
      [ORACLE_PRICE_SEED, vaultPda.toBuffer(), mintA.toBuffer()],
      program.programId
    );

    // price = 1.0 = 1_000_000_000 (PRICE_SCALE)
    await program.methods
      .updateOracle(new BN(1_000_000_000))
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        assetMint: mintA,
        oraclePrice: oraclePriceA,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const oracle = await program.account.oraclePrice.fetch(oraclePriceA);
    expect(oracle.price.toString()).to.equal("1000000000");
    console.log("oracle A set:", oracle.price.toString());
  });

  it("sets oracle price for asset B", async () => {
    [oraclePriceB] = PublicKey.findProgramAddressSync(
      [ORACLE_PRICE_SEED, vaultPda.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    await program.methods
      .updateOracle(new BN(1_000_000_000))
      .accounts({
        vault: vaultPda,
        authority: user.publicKey,
        assetMint: mintB,
        oraclePrice: oraclePriceB,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const oracle = await program.account.oraclePrice.fetch(oraclePriceB);
    expect(oracle.price.toString()).to.equal("1000000000");
  });

  it("mints tokens to user", async () => {
    const ataA = await getOrCreateAssociatedTokenAccount(
      provider.connection, user.payer, mintA, user.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );
    userAtaA = ataA.address;

    const ataB = await getOrCreateAssociatedTokenAccount(
      provider.connection, user.payer, mintB, user.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID
    );
    userAtaB = ataB.address;

    await mintTo(provider.connection, user.payer, mintA, userAtaA, user.publicKey, 10_000_000, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(provider.connection, user.payer, mintB, userAtaB, user.publicKey, 10_000_000, [], undefined, TOKEN_PROGRAM_ID);

    const balA = await getAccount(provider.connection, userAtaA, undefined, TOKEN_PROGRAM_ID);
    expect(Number(balA.amount)).to.equal(10_000_000);
  });

  it("deposits single asset A using oracle price", async () => {
    const sharesAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, user.payer, sharesMint, user.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    userSharesAta = sharesAta.address;

    await program.methods
      .depositSingle(new BN(1_000_000), new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        assetEntry: assetEntryA,
        assetMint: mintA,
        oraclePrice: oraclePriceA,
        assetVaultAccount: assetVaultA,
        sharesMint: sharesMint,
        userAssetAccount: userAtaA,
        userSharesAccount: userSharesAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetEntryB, isWritable: false, isSigner: false },
        { pubkey: oraclePriceB, isWritable: false, isSigner: false },
        { pubkey: assetVaultB, isWritable: true, isSigner: false },
      ])
      .rpc();

    const mintInfo = await getMint(provider.connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    expect(Number(mintInfo.supply)).to.be.greaterThan(0);
    console.log("shares after deposit:", mintInfo.supply.toString());
  });

  it("rejects deposit when oracle is stale (simulated by invalid account)", async () => {
    // This test verifies oracle validation exists in the code
    // In localnet, prices are fresh so we just verify the account constraint works
    const [fakeOracle] = PublicKey.findProgramAddressSync(
      [ORACLE_PRICE_SEED, vaultPda.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    // Should fail if we pass wrong oracle for wrong mint
    try {
      await program.methods
        .depositSingle(new BN(1_000_000), new BN(0))
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          assetEntry: assetEntryA,
          assetMint: mintA,
          oraclePrice: fakeOracle, // wrong oracle (mintB's oracle for mintA deposit)
          assetVaultAccount: assetVaultA,
          sharesMint: sharesMint,
          userAssetAccount: userAtaA,
          userSharesAccount: userSharesAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e.message).to.include("Error");
      console.log("correctly rejected wrong oracle");
    }
  });

  it("rejects deposit below minimum", async () => {
    try {
      await program.methods
        .depositSingle(new BN(10), new BN(0)) // below MIN_DEPOSIT=1000
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          assetEntry: assetEntryA,
          assetMint: mintA,
          oraclePrice: oraclePriceA,
          assetVaultAccount: assetVaultA,
          sharesMint: sharesMint,
          userAssetAccount: userAtaA,
          userSharesAccount: userSharesAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e) {
      const msg = e.logs ? e.logs.join(" ") : e.message;
      expect(msg).to.include("DepositTooSmall");
      console.log("correctly rejected small deposit");
    }
  });

  it("pauses vault and rejects deposit", async () => {
    await program.methods.pause().accounts({
      vault: vaultPda,
      authority: user.publicKey,
    }).rpc();

    const vault = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vault.paused).to.be.true;

    try {
      await program.methods
        .depositSingle(new BN(1_000_000), new BN(0))
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          assetEntry: assetEntryA,
          assetMint: mintA,
          oraclePrice: oraclePriceA,
          assetVaultAccount: assetVaultA,
          sharesMint: sharesMint,
          userAssetAccount: userAtaA,
          userSharesAccount: userSharesAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e) {
      const msg = e.logs ? e.logs.join(" ") : e.message;
      expect(msg).to.include("VaultPaused");
      console.log("correctly rejected deposit on paused vault");
    }
  });

  it("unpauses vault", async () => {
    await program.methods.unpause().accounts({
      vault: vaultPda,
      authority: user.publicKey,
    }).rpc();

    const vault = await program.account.multiAssetVault.fetch(vaultPda);
    expect(vault.paused).to.be.false;
  });

  it("deposits proportional across all assets atomically", async () => {
    // deposit_proportional: pass base_amount, splits across assets by weight
    const vaultBefore = await program.account.multiAssetVault.fetch(vaultPda);
    const mintInfoBefore = await getMint(provider.connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    const sharesBefore = Number(mintInfoBefore.supply);

    await program.methods
      .depositProportional(new BN(2_000_000), new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        // Asset A: [AssetEntry, OraclePrice, vault_ata, user_ata, mint]
        { pubkey: assetEntryA, isWritable: false, isSigner: false },
        { pubkey: oraclePriceA, isWritable: false, isSigner: false },
        { pubkey: assetVaultA, isWritable: true, isSigner: false },
        { pubkey: userAtaA, isWritable: true, isSigner: false },
        { pubkey: mintA, isWritable: false, isSigner: false },
        // Asset B: [AssetEntry, OraclePrice, vault_ata, user_ata, mint]
        { pubkey: assetEntryB, isWritable: false, isSigner: false },
        { pubkey: oraclePriceB, isWritable: false, isSigner: false },
        { pubkey: assetVaultB, isWritable: true, isSigner: false },
        { pubkey: userAtaB, isWritable: true, isSigner: false },
        { pubkey: mintB, isWritable: false, isSigner: false },
      ])
      .rpc();

    const vaultAfter = await program.account.multiAssetVault.fetch(vaultPda);
    const mintInfoAfter = await getMint(provider.connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    expect(Number(mintInfoAfter.supply)).to.be.greaterThan(sharesBefore);
    console.log("shares after proportional deposit:", mintInfoAfter.supply.toString());
  });
  it("redeems proportional across all assets", async () => {
    // First deposit again to ensure we have shares
    await program.methods
      .depositSingle(new BN(1_000_000), new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        assetEntry: assetEntryA,
        assetMint: mintA,
        oraclePrice: oraclePriceA,
        assetVaultAccount: assetVaultA,
        sharesMint: sharesMint,
        userAssetAccount: userAtaA,
        userSharesAccount: userSharesAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetEntryB, isWritable: false, isSigner: false },
        { pubkey: oraclePriceB, isWritable: false, isSigner: false },
        { pubkey: assetVaultB, isWritable: true, isSigner: false },
      ])
      .rpc();

    const vaultBefore = await program.account.multiAssetVault.fetch(vaultPda);
    const mintBefore = await getMint(provider.connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    const sharesToRedeem = new anchor.BN(Number(mintBefore.supply) / 2);
    expect(sharesToRedeem.toNumber()).to.be.greaterThan(0);

    await program.methods
      .redeemProportional(sharesToRedeem, new BN(0))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        sharesMint: sharesMint,
        userSharesAccount: userSharesAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        sharesTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: assetEntryA, isWritable: false, isSigner: false },
        { pubkey: oraclePriceA, isWritable: false, isSigner: false },
        { pubkey: assetVaultA, isWritable: true, isSigner: false },
        { pubkey: userAtaA, isWritable: true, isSigner: false },
        { pubkey: mintA, isWritable: false, isSigner: false },
        { pubkey: assetEntryB, isWritable: false, isSigner: false },
        { pubkey: oraclePriceB, isWritable: false, isSigner: false },
        { pubkey: assetVaultB, isWritable: true, isSigner: false },
        { pubkey: userAtaB, isWritable: true, isSigner: false },
        { pubkey: mintB, isWritable: false, isSigner: false },
      ])
      .rpc();
    const mintAfter = await getMint(provider.connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
    expect(Number(mintAfter.supply)).to.be.lessThan(Number(mintBefore.supply));
    console.log("shares after redeem:", mintAfter.supply.toString());
  });

  it("redeems single asset", async () => {
    // Use a fresh vault to avoid accumulated state from previous tests
    const VAULT_ID_SINGLE = new BN(999);
    const [vaultSingle] = PublicKey.findProgramAddressSync(
      [Buffer.from("multi_vault"), VAULT_ID_SINGLE.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [sharesMintSingle] = PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vaultSingle.toBuffer()],
      program.programId
    );
    const [assetEntrySingle] = PublicKey.findProgramAddressSync(
      [Buffer.from("asset_entry"), vaultSingle.toBuffer(), mintA.toBuffer()],
      program.programId
    );
    const [oracleSingle] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_price"), vaultSingle.toBuffer(), mintA.toBuffer()],
      program.programId
    );
    const assetVaultSingleKeypair = anchor.web3.Keypair.generate();

    // Initialize fresh vault
    await program.methods.initialize(VAULT_ID_SINGLE, 6)
      .accountsPartial({ authority: user.publicKey, sharesMint: sharesMintSingle, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .rpc();

    await program.methods.addAsset(10_000)
      .accountsPartial({ vault: vaultSingle, authority: user.publicKey, assetMint: mintA, oracle: anchor.web3.Keypair.generate().publicKey, assetEntry: assetEntrySingle, assetVault: assetVaultSingleKeypair.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .signers([assetVaultSingleKeypair]).rpc();

    await program.methods.updateOracle(new BN(1_000_000_000))
      .accountsPartial({ vault: vaultSingle, assetMint: mintA, systemProgram: SystemProgram.programId })
      .rpc();

    const userSharesSingle = await getOrCreateAssociatedTokenAccount(
      provider.connection, user.payer, sharesMintSingle, user.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID
    );

    // Deposit 1 token
    await program.methods.depositSingle(new BN(1_000_000), new BN(0))
      .accountsPartial({ user: user.publicKey, vault: vaultSingle, assetEntry: assetEntrySingle, assetMint: mintA, oraclePrice: oracleSingle, assetVaultAccount: assetVaultSingleKeypair.publicKey, sharesMint: sharesMintSingle, userAssetAccount: userAtaA, userSharesAccount: userSharesSingle.address, tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();

    const vaultBefore = await program.account.multiAssetVault.fetch(vaultSingle);
    const mintSingleBefore = await getMint(provider.connection, sharesMintSingle, undefined, TOKEN_2022_PROGRAM_ID);
    const sharesToRedeem = new anchor.BN(Number(mintSingleBefore.supply) / 2);
    expect(sharesToRedeem.toNumber()).to.be.greaterThan(0);

    await program.methods.redeemSingle(sharesToRedeem, new BN(0))
      .accounts({ user: user.publicKey, vault: vaultSingle, assetEntry: assetEntrySingle, assetMint: mintA, oraclePrice: oracleSingle, assetVaultAccount: assetVaultSingleKeypair.publicKey, userAssetAccount: userAtaA, sharesMint: sharesMintSingle, userSharesAccount: userSharesSingle.address, tokenProgram: TOKEN_PROGRAM_ID, sharesTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc();

    const vaultAfter = await program.account.multiAssetVault.fetch(vaultSingle);
    const mintSingleAfter = await getMint(provider.connection, sharesMintSingle, undefined, TOKEN_2022_PROGRAM_ID);
    expect(Number(mintSingleAfter.supply)).to.be.lessThan(Number(mintSingleBefore.supply));
    console.log("shares after redeem_single:", mintSingleAfter.supply.toString());
  });
});
