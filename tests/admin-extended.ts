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
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { expect } from "chai";
import { Svs1 } from "../target/types/svs_1";

describe("Admin Extended", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs1 as Program<Svs1>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const newAuthority = Keypair.generate();

  let assetMint: PublicKey;
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let assetVault: PublicKey;
  let userAssetAccount: PublicKey;
  let userSharesAccount: PublicKey;

  const vaultId = new BN(700);
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
    // Fund new authority via SOL transfer from payer (more reliable than airdrop)
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: newAuthority.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(connection, fundTx, [payer]);

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
      10_000_000 * 10 ** ASSET_DECIMALS,
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
      .initialize(vaultId, "Admin Test Vault", "admVault", "https://example.com")
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

    // Initial deposit for testing
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

    console.log("Setup:");
    console.log("  Vault:", vault.toBase58());
    console.log("  Original Authority:", payer.publicKey.toBase58());
    console.log("  New Authority:", newAuthority.publicKey.toBase58());
  });

  describe("Pause Coverage", () => {
    it("pause blocks deposit", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      try {
        await program.methods
          .deposit(new BN(1001), new BN(0))
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
        expect.fail("Should reject deposit when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Deposit blocked when paused");
      }
    });

    it("pause blocks mint", async () => {
      try {
        await program.methods
          .mint(new BN(1000 * 10 ** 9), new BN("999999999999999999"))
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
        expect.fail("Should reject mint when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Mint blocked when paused");
      }
    });

    it("pause blocks withdraw", async () => {
      try {
        await program.methods
          .withdraw(new BN(1000), new BN("999999999999999999"))
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
        expect.fail("Should reject withdraw when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Withdraw blocked when paused");
      }
    });

    it("pause blocks redeem", async () => {
      try {
        await program.methods
          .redeem(new BN(1000), new BN(0))
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
        expect.fail("Should reject redeem when paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Redeem blocked when paused");
      }
    });

    it("pause does NOT block view functions", async () => {
      // View functions should work even when paused
      const result = await program.methods
        .previewDeposit(new BN(10_000 * 10 ** ASSET_DECIMALS))
        .accountsStrict({
          vault: vault,
          sharesMint: sharesMint,
        })
        .simulate();

      expect(result.events).to.not.be.undefined;
      console.log("  View functions work when paused");

      // Unpause for next tests
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });
  });

  describe("Pause Edge Cases", () => {
    it("double pause fails (already paused)", async () => {
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
          })
          .rpc();
        expect.fail("Should reject double pause");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Double pause correctly rejected");
      }

      // Unpause
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();
    });

    it("double unpause fails (not paused)", async () => {
      // Vault should be unpaused now
      try {
        await program.methods
          .unpause()
          .accountsStrict({
            authority: payer.publicKey,
            vault: vault,
          })
          .rpc();
        expect.fail("Should reject unpause when not paused");
      } catch (err: any) {
        expect(err.toString()).to.include("VaultPaused");
        console.log("  Double unpause correctly rejected");
      }
    });

    it("unpause then immediate deposit works", async () => {
      // Pause
      await program.methods
        .pause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      // Unpause
      await program.methods
        .unpause()
        .accountsStrict({
          authority: payer.publicKey,
          vault: vault,
        })
        .rpc();

      // Immediate deposit should work
      await program.methods
        .deposit(new BN(1001), new BN(0))
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

      console.log("  Immediate deposit after unpause works");
    });
  });

  describe("Authority Transfer", () => {
    let transferVault: PublicKey;
    let transferSharesMint: PublicKey;
    let transferAssetVault: PublicKey;
    let transferUserSharesAccount: PublicKey;
    const transferVaultId = new BN(701);

    before(async () => {
      [transferVault] = getVaultPDA(assetMint, transferVaultId);
      [transferSharesMint] = getSharesMintPDA(transferVault);

      transferAssetVault = anchor.utils.token.associatedAddress({
        mint: assetMint,
        owner: transferVault,
      });

      transferUserSharesAccount = getAssociatedTokenAddressSync(
        transferSharesMint,
        payer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(transferVaultId, "Transfer Test Vault", "trfVault", "https://example.com")
        .accountsStrict({
          authority: payer.publicKey,
          vault: transferVault,
          assetMint: assetMint,
          sharesMint: transferSharesMint,
          assetVault: transferAssetVault,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    });

    it("successfully transfers authority to new keypair", async () => {
      const vaultBefore = await program.account.vault.fetch(transferVault);
      expect(vaultBefore.authority.toBase58()).to.equal(payer.publicKey.toBase58());

      await program.methods
        .transferAuthority(newAuthority.publicKey)
        .accountsStrict({
          authority: payer.publicKey,
          vault: transferVault,
        })
        .rpc();

      const vaultAfter = await program.account.vault.fetch(transferVault);
      expect(vaultAfter.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
      console.log("  Authority transferred to:", newAuthority.publicKey.toBase58());
    });

    it("old authority cannot operate after transfer", async () => {
      try {
        await program.methods
          .pause()
          .accountsStrict({
            authority: payer.publicKey,
            vault: transferVault,
          })
          .rpc();
        expect.fail("Old authority should be rejected");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
        console.log("  Old authority correctly rejected");
      }
    });

    it("new authority can pause/unpause", async () => {
      // Pause with new authority
      await program.methods
        .pause()
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: transferVault,
        })
        .signers([newAuthority])
        .rpc();

      let vaultState = await program.account.vault.fetch(transferVault);
      expect(vaultState.paused).to.equal(true);
      console.log("  New authority can pause");

      // Unpause with new authority
      await program.methods
        .unpause()
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: transferVault,
        })
        .signers([newAuthority])
        .rpc();

      vaultState = await program.account.vault.fetch(transferVault);
      expect(vaultState.paused).to.equal(false);
      console.log("  New authority can unpause");
    });

    it("new authority can transfer again", async () => {
      const thirdAuthority = Keypair.generate();

      await program.methods
        .transferAuthority(thirdAuthority.publicKey)
        .accountsStrict({
          authority: newAuthority.publicKey,
          vault: transferVault,
        })
        .signers([newAuthority])
        .rpc();

      const vaultState = await program.account.vault.fetch(transferVault);
      expect(vaultState.authority.toBase58()).to.equal(thirdAuthority.publicKey.toBase58());
      console.log("  Authority transferred again to:", thirdAuthority.publicKey.toBase58());
    });
  });
});
