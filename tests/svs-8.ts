import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { Svs8 } from "../target/types/svs_8";

describe("svs-8 (Multi Asset Basket)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs8 as Program<Svs8>;

  const user = provider.wallet as anchor.Wallet;
  const vault = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;

  it("create mints", async () => {
    mintA = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      user.payer,
      user.publicKey,
      null,
      6
    );

    expect(mintA).to.not.be.null;
    expect(mintB).to.not.be.null;
  });

  it("initialize vault", async () => {
    await program.methods
      .initialize()
      .accounts({
        vault: vault.publicKey,
        payer: user.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([vault])
      .rpc();
  });

  it("deposit proportional", async () => {
    await program.methods
      .depositProportional(new BN(1_000_000), new BN(1))
      .accounts({
        vault: vault.publicKey,
        user: user.publicKey,
      })
      .rpc();
  });

  it("redeem proportional", async () => {
    await program.methods
      .redeemProportional(new BN(1), new BN(1))
      .accounts({
        vault: vault.publicKey,
        user: user.publicKey,
      })
      .rpc();
  });
});
