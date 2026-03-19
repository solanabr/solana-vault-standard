import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { Svs6 } from "../target/types/svs_6";

describe("svs-6 (Native SOL Streaming Yield)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs6 as Program<Svs6>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultId = new BN(1);
  let vault: PublicKey;
  let sharesMint: PublicKey;
  let userSharesAccount: PublicKey;

  const getVaultPda = (id: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("native_sol_stream_vault"), id.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

  const getSharesMintPda = (vaultPk: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vaultPk.toBuffer()],
      program.programId,
    );

  before(async () => {
    [vault] = getVaultPda(vaultId);
    [sharesMint] = getSharesMintPda(vault);
    userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  });

  it("initializes, deposits SOL, streams yield, accrues, and withdraws", async () => {
    await program.methods
      .initialize(
        vaultId,
        "SVS-6 Native SOL",
        "svSOL6",
        "https://example.com/svs6.json",
      )
      .accountsStrict({
        authority: payer.publicKey,
        vault,
        sharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const initialVault = await program.account.nativeSolStreamVault.fetch(vault);
    expect(initialVault.vaultId.toNumber()).to.equal(1);
    expect(initialVault.paused).to.equal(false);

    const depositLamports = new BN(1_000_000_000);
    await program.methods
      .deposit(depositLamports, new BN(900_000_000))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        sharesMint,
        userSharesAccount,
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

    const yieldAmount = new BN(500_000_000);
    await program.methods
      .distributeYield(yieldAmount, new BN(60))
      .accountsStrict({
        vault,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await program.methods
      .accrueYield()
      .accountsStrict({
        vault,
      })
      .rpc();

    const afterAccrue = await program.account.nativeSolStreamVault.fetch(vault);
    expect(afterAccrue.baseAssets.toNumber()).to.be.greaterThan(
      depositLamports.toNumber(),
    );

    await program.methods
      .withdraw(new BN(100_000_000), new BN(200_000_000))
      .accountsStrict({
        user: payer.publicKey,
        vault,
        sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const afterWithdraw = await program.account.nativeSolStreamVault.fetch(vault);
    expect(afterWithdraw.baseAssets.toNumber()).to.be.lessThan(
      afterAccrue.baseAssets.toNumber(),
    );
  });
});
