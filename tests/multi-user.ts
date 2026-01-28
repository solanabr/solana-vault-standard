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
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("Multi-User Scenarios", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Users
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;

  // User A accounts
  let userAAssetAccount: PublicKey;
  let userASharesAccount: PublicKey;

  // User B accounts
  let userBAssetAccount: PublicKey;
  let userBSharesAccount: PublicKey;

  const vaultId = new BN(500);
  const ASSET_DECIMALS = 6;

  const getVaultPDA = (assetMint: PublicKey, vaultId: BN): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  };

  const getSharesMintPDA = (vault: PublicKey): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer()],
      program.programId
    );
  };

  before(async () => {
    // Fund users via SOL transfer from payer (more reliable than airdrop)
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userA.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userB.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, fundTx, [payer]);

    // Create asset mint
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

    // Setup User A
    const userAAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      userA.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    userAAssetAccount = userAAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      userAAssetAccount,
      payer.publicKey,
      1_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Setup User B
    const userBAssetAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      assetMint,
      userB.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    userBAssetAccount = userBAssetAta.address;

    await mintTo(
      connection,
      payer,
      assetMint,
      userBAssetAccount,
      payer.publicKey,
      1_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    userASharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      userA.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    userBSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      userB.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Initialize vault
    await program.methods
      .initialize(vaultId, "Multi-User Vault", "muVault", "https://example.com")
      .accountsStrict({
        authority: payer.publicKey,
        vault: vault,
        assetMint: assetMint,
        sharesMint: sharesMint,
        assetVault: assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    console.log("Setup:");
    console.log("  User A:", userA.publicKey.toBase58());
    console.log("  User B:", userB.publicKey.toBase58());
    console.log("  Vault:", vault.toBase58());
  });

  describe("Proportional Share Distribution", () => {
    it("User A deposits, User B deposits equal amount, both have equal shares", async () => {
      const depositAmount = new BN(100_000 * 10 ** ASSET_DECIMALS);

      // User A deposits first
      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userA])
        .rpc();

      const userAShares = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userASharesNum = Number(userAShares.amount);

      // User B deposits same amount
      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: userB.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userBAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userBSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userB])
        .rpc();

      const userBShares = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBSharesNum = Number(userBShares.amount);

      // Both should have approximately equal shares (slight difference due to virtual offset)
      const ratio = userBSharesNum / userASharesNum;
      expect(ratio).to.be.closeTo(1.0, 0.01);

      console.log("  User A shares:", userASharesNum);
      console.log("  User B shares:", userBSharesNum);
      console.log("  Ratio:", ratio.toFixed(6));
    });

    it("second depositor receives proportional shares", async () => {
      const vaultState = await program.account.vault.fetch(vault);
      const userAShares = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // User A deposits more
      const depositAmount = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const userASharesBefore = Number(userAShares.amount);

      await program.methods
        .deposit(depositAmount, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userA])
        .rpc();

      const userASharesAfter = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const newShares = Number(userASharesAfter.amount) - userASharesBefore;

      // New shares should be proportional to deposit amount vs existing total
      const expectedRatio = depositAmount.toNumber() / vaultState.totalAssets.toNumber();
      const sharesMintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      const actualRatio = newShares / (Number(sharesMintInfo.supply) - newShares);

      expect(actualRatio).to.be.closeTo(expectedRatio, 0.01);
      console.log("  Proportional shares: expected ratio", expectedRatio.toFixed(4), "actual", actualRatio.toFixed(4));
    });
  });

  describe("Multi-User Withdrawals", () => {
    it("User A and User B both redeem proportionally", async () => {
      const userASharesBefore = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBSharesBefore = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const userAAssetsBefore = await getAccount(connection, userAAssetAccount);
      const userBAssetsBefore = await getAccount(connection, userBAssetAccount);

      // Both redeem 10% of their shares
      const userARedeem = new BN(Number(userASharesBefore.amount) / 10);
      const userBRedeem = new BN(Number(userBSharesBefore.amount) / 10);

      await program.methods
        .redeem(userARedeem, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userA])
        .rpc();

      await program.methods
        .redeem(userBRedeem, new BN(0))
        .accountsStrict({
          user: userB.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userBAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userBSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();

      const userAAssetsAfter = await getAccount(connection, userAAssetAccount);
      const userBAssetsAfter = await getAccount(connection, userBAssetAccount);

      const userAReceived = Number(userAAssetsAfter.amount) - Number(userAAssetsBefore.amount);
      const userBReceived = Number(userBAssetsAfter.amount) - Number(userBAssetsBefore.amount);

      // Share ratio should equal asset ratio received
      const shareRatio = userARedeem.toNumber() / userBRedeem.toNumber();
      const assetRatio = userAReceived / userBReceived;

      expect(assetRatio).to.be.closeTo(shareRatio, 0.01);
      console.log("  User A received:", userAReceived, "User B received:", userBReceived);
      console.log("  Asset ratio:", assetRatio.toFixed(4), "Share ratio:", shareRatio.toFixed(4));
    });

    it("User A exits completely while User B remains", async () => {
      const userAShares = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBSharesBefore = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // User A redeems all remaining shares
      await program.methods
        .redeem(new BN(Number(userAShares.amount)), new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userA])
        .rpc();

      const userASharesAfter = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBSharesAfter = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(userASharesAfter.amount)).to.equal(0);
      expect(Number(userBSharesAfter.amount)).to.equal(Number(userBSharesBefore.amount));

      console.log("  User A exited (0 shares), User B still has", Number(userBSharesAfter.amount), "shares");
    });

    it("last user can redeem all remaining shares", async () => {
      const userBShares = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultBefore = await program.account.vault.fetch(vault);

      // User B redeems all
      await program.methods
        .redeem(new BN(Number(userBShares.amount)), new BN(0))
        .accountsStrict({
          user: userB.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userBAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userBSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();

      const userBSharesAfter = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAfter = await program.account.vault.fetch(vault);

      expect(Number(userBSharesAfter.amount)).to.equal(0);
      expect(vaultAfter.totalAssets.toNumber()).to.equal(0);

      console.log("  Last user exited, vault now empty");
      console.log("  Vault total_assets:", vaultAfter.totalAssets.toNumber());
    });
  });

  describe("Share Accounting Integrity", () => {
    before(async () => {
      // Refill for new tests
      const depositA = new BN(50_000 * 10 ** ASSET_DECIMALS);
      const depositB = new BN(75_000 * 10 ** ASSET_DECIMALS);

      await program.methods
        .deposit(depositA, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userA])
        .rpc();

      await program.methods
        .deposit(depositB, new BN(0))
        .accountsStrict({
          user: userB.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userBAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userBSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userB])
        .rpc();
    });

    it("total shares equals sum of all user shares", async () => {
      const sharesMintInfo = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      const userAShares = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBShares = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      const sumOfShares = Number(userAShares.amount) + Number(userBShares.amount);

      expect(Number(sharesMintInfo.supply)).to.equal(sumOfShares);
      console.log("  Total supply:", Number(sharesMintInfo.supply));
      console.log("  Sum of user shares:", sumOfShares);
    });

    it("total assets equals sum of expected user assets", async () => {
      const vaultState = await program.account.vault.fetch(vault);
      const assetVaultAccount = await getAccount(connection, assetVault);

      expect(vaultState.totalAssets.toNumber()).to.equal(Number(assetVaultAccount.amount));
      console.log("  Vault total_assets:", vaultState.totalAssets.toNumber());
      console.log("  Actual vault balance:", Number(assetVaultAccount.amount));
    });

    it("no shares created from nothing", async () => {
      const sharesMintBefore = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultBefore = await program.account.vault.fetch(vault);

      // Small deposit from User A
      const smallDeposit = new BN(1001);
      await program.methods
        .deposit(smallDeposit, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userA])
        .rpc();

      const sharesMintAfter = await getMint(connection, sharesMint, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultAfter = await program.account.vault.fetch(vault);

      const sharesCreated = Number(sharesMintAfter.supply) - Number(sharesMintBefore.supply);
      const assetsAdded = vaultAfter.totalAssets.toNumber() - vaultBefore.totalAssets.toNumber();

      // Shares should only be created when assets are added
      expect(assetsAdded).to.equal(smallDeposit.toNumber());
      expect(sharesCreated).to.be.greaterThan(0);
      console.log("  Assets added:", assetsAdded, "Shares created:", sharesCreated);
    });

    it("no assets lost in multi-user operations", async () => {
      const vaultBefore = await program.account.vault.fetch(vault);
      const userAAssetsBefore = await getAccount(connection, userAAssetAccount);
      const userBAssetsBefore = await getAccount(connection, userBAssetAccount);
      const userASharesBefore = await getAccount(connection, userASharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userBSharesBefore = await getAccount(connection, userBSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      // User A redeems small amount
      const redeemAmount = new BN(1000 * 10 ** 9);
      await program.methods
        .redeem(redeemAmount, new BN(0))
        .accountsStrict({
          user: userA.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userASharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userA])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vault);
      const userAAssetsAfter = await getAccount(connection, userAAssetAccount);
      const userBAssetsAfter = await getAccount(connection, userBAssetAccount);

      const vaultDecrease = vaultBefore.totalAssets.toNumber() - vaultAfter.totalAssets.toNumber();
      const userAIncrease = Number(userAAssetsAfter.amount) - Number(userAAssetsBefore.amount);
      const userBChange = Number(userBAssetsAfter.amount) - Number(userBAssetsBefore.amount);

      // Vault decrease should equal user A increase
      expect(vaultDecrease).to.equal(userAIncrease);
      // User B should be unaffected
      expect(userBChange).to.equal(0);

      console.log("  Vault decrease:", vaultDecrease);
      console.log("  User A increase:", userAIncrease);
      console.log("  User B change:", userBChange);
    });
  });
});
