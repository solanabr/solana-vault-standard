import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs7 } from "../target/types/svs_7";

describe("svs-7 (Native SOL Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs7 as Program<Svs7>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const liveVaultId = new BN(701);
  const storedVaultId = new BN(702);

  const getVaultPda = (id: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), id.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

  const getSharesMintPda = (vaultPk: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vaultPk.toBuffer()],
      program.programId,
    );

  it("supports Live mode with deposit_sol and withdraw_sol", async () => {
    const [vault] = getVaultPda(liveVaultId);
    const [sharesMint] = getSharesMintPda(vault);
    const wsolVault = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(
        liveVaultId,
        "SVS-7 Live",
        "svSOL7L",
        "https://example.com/svs7-live.json",
        { live: {} },
      )
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        wsolMint: NATIVE_MINT,
        sharesMint,
        wsolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const depositLamports = new BN(1_000_000_000);

    await program.methods
      .depositSol(depositLamports, new BN(1))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        wsolVault,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const sharesAfterDeposit = await getAccount(
      connection,
      userSharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(Number(sharesAfterDeposit.amount)).to.be.greaterThan(0);

    const vaultBeforeWithdraw = await getAccount(
      connection,
      wsolVault,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    const tempWsolAccount = Keypair.generate();

    await program.methods
      .withdrawSol(new BN(100_000_000), new BN(200_000_000))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        wsolMint: NATIVE_MINT,
        wsolVault,
        tempWsolAccount: tempWsolAccount.publicKey,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([tempWsolAccount])
      .rpc();

    const vaultAfterWithdraw = await getAccount(
      connection,
      wsolVault,
      undefined,
      TOKEN_PROGRAM_ID,
    );

    expect(Number(vaultAfterWithdraw.amount)).to.be.lessThan(
      Number(vaultBeforeWithdraw.amount),
    );
  });

  it("supports Stored mode with sync after external donation", async () => {
    const [vault] = getVaultPda(storedVaultId);
    const [sharesMint] = getSharesMintPda(vault);
    const wsolVault = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(
        storedVaultId,
        "SVS-7 Stored",
        "svSOL7S",
        "https://example.com/svs7-stored.json",
        { stored: {} },
      )
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        wsolMint: NATIVE_MINT,
        sharesMint,
        wsolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const initialDeposit = new BN(500_000_000);

    await program.methods
      .depositSol(initialDeposit, new BN(1))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        wsolVault,
        sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let vaultState = await program.account.solVault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.equal(initialDeposit.toNumber());

    const donatedLamports = 123_456_789;
    const donationTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wsolVault,
        lamports: donatedLamports,
      }),
      createSyncNativeInstruction(wsolVault, TOKEN_PROGRAM_ID),
    );
    await provider.sendAndConfirm(donationTx, []);

    vaultState = await program.account.solVault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.equal(initialDeposit.toNumber());

    await program.methods
      .sync()
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        wsolVault,
      })
      .rpc();

    vaultState = await program.account.solVault.fetch(vault);
    expect(vaultState.totalAssets.toNumber()).to.equal(
      initialDeposit.toNumber() + donatedLamports,
    );
  });
});
