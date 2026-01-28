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
import { Svs1 } from "../target/types/svs_1";

describe("svs-1 edge cases", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;
  const vaultId = new BN(2); // Different vault ID for this test suite
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
      1_000_000 * 10 ** ASSET_DECIMALS,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    assetVault = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: vault,
    });

    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Initialize vault
    await program.methods
      .initialize(vaultId, "Edge Case Vault", "ecVault", "https://example.com")
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
  });

  describe("Zero Amount Validation", () => {
    it("rejects deposit with zero amount", async () => {
      try {
        await program.methods
          .deposit(new BN(0), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should reject zero deposit");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
        console.log("  Zero deposit correctly rejected");
      }
    });

    it("rejects mint with zero shares", async () => {
      try {
        await program.methods
          .mint(new BN(0), new BN(1000000))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should reject zero mint");
      } catch (err: any) {
        expect(err.toString()).to.include("ZeroAmount");
        console.log("  Zero mint correctly rejected");
      }
    });
  });

  describe("Minimum Deposit Validation", () => {
    it("rejects deposit below minimum", async () => {
      try {
        // MIN_DEPOSIT_AMOUNT is 1000 in constants.rs
        await program.methods
          .deposit(new BN(500), new BN(0))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should reject small deposit");
      } catch (err: any) {
        expect(err.toString()).to.include("DepositTooSmall");
        console.log("  Small deposit correctly rejected");
      }
    });
  });

  describe("Slippage Protection", () => {
    before(async () => {
      // Make initial deposit
      await program.methods
        .deposit(new BN(100_000 * 10 ** ASSET_DECIMALS), new BN(0))
        .accountsStrict({
          user: payer.publicKey,
          vault: vault,
          assetMint: assetMint,
          userAssetAccount: userAssetAccount,
          assetVault: assetVault,
          sharesMint: sharesMint,
          userSharesAccount: userSharesAccount,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

    it("rejects deposit when shares below minimum", async () => {
      try {
        // Request impossibly high min shares
        await program.methods
          .deposit(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN("999999999999999999"))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
        console.log("  Deposit slippage protection works");
      }
    });

    it("rejects redeem when assets below minimum", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);

      try {
        // Request impossibly high min assets
        await program.methods
          .redeem(new BN(1000 * 10 ** 9), new BN("999999999999999999"))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
        console.log("  Redeem slippage protection works");
      }
    });

    it("rejects withdraw when shares exceed maximum", async () => {
      try {
        // Request withdraw but with very low max shares
        await program.methods
          .withdraw(new BN(10_000 * 10 ** ASSET_DECIMALS), new BN(1))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
        console.log("  Withdraw slippage protection works");
      }
    });

    it("rejects mint when assets exceed maximum", async () => {
      try {
        // Request mint but with very low max assets
        await program.methods
          .mint(new BN(10_000 * 10 ** 9), new BN(1))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should reject due to slippage");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
        console.log("  Mint slippage protection works");
      }
    });
  });

  describe("Insufficient Balance", () => {
    it("rejects redeem with insufficient shares", async () => {
      const sharesAccount = await getAccount(connection, userSharesAccount, undefined, TOKEN_2022_PROGRAM_ID);
      const userShares = Number(sharesAccount.amount);

      try {
        await program.methods
          .redeem(new BN(userShares + 10 ** 9), new BN(0)) // More than user has
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject insufficient shares");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientShares");
        console.log("  Insufficient shares correctly rejected");
      }
    });

    it("rejects withdraw exceeding vault assets", async () => {
      const vaultAccount = await program.account.vault.fetch(vault);
      const vaultAssets = vaultAccount.totalAssets.toNumber();

      try {
        await program.methods
          .withdraw(new BN(vaultAssets * 2), new BN("999999999999999999"))
          .accountsStrict({
            user: payer.publicKey,
            vault: vault,
            assetMint: assetMint,
            userAssetAccount: userAssetAccount,
            assetVault: assetVault,
            sharesMint: sharesMint,
            userSharesAccount: userSharesAccount,
            assetTokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should reject exceeding vault assets");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientAssets");
        console.log("  Excess withdraw correctly rejected");
      }
    });
  });

  describe("Authority Validation", () => {
    it("rejects pause from non-authority", async () => {
      const fakeAuthority = Keypair.generate();

      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: fakeAuthority.publicKey,
            vault: vault,
          })
          .signers([fakeAuthority])
          .rpc();
        expect.fail("Should reject non-authority");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Non-authority pause correctly rejected");
      }
    });

    it("rejects transfer_authority from non-authority", async () => {
      const fakeAuthority = Keypair.generate();
      const newAuthority = Keypair.generate();

      try {
        await program.methods
          .transferAuthority(newAuthority.publicKey)
          .accountsStrict({
            authority: fakeAuthority.publicKey,
            vault: vault,
          })
          .signers([fakeAuthority])
          .rpc();
        expect.fail("Should reject non-authority");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Non-authority transfer correctly rejected");
      }
    });
  });

  describe("Multi-vault Support", () => {
    it("creates second vault for same asset", async () => {
      const vaultId3 = new BN(3);
      const [vault3] = getVaultPDA(assetMint, vaultId3);
      const [sharesMint3] = getSharesMintPDA(vault3);
      const assetVault3 = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: vault3,
      });

      await program.methods
        .initialize(vaultId3, "Second Vault", "sv2", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault3,
          assetMint: assetMint,
          sharesMint: sharesMint3,
          assetVault: assetVault3,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const vault3Account = await program.account.vault.fetch(vault3);
      expect(vault3Account.vaultId.toNumber()).to.equal(3);
      console.log("  Multiple vaults for same asset works");
    });
  });
});
