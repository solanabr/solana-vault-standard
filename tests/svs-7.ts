import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddress,
} from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { assert } from "chai";

describe("SVS-7: Native SOL Vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Svs7 as any;
  const authority = provider.wallet as anchor.Wallet;

  const VAULT_ID = new anchor.BN(7002);
  const SOL_VAULT_SEED = Buffer.from("sol_vault");
  const SHARES_MINT_SEED = Buffer.from("shares");

  let vaultPda: PublicKey;
  let sharesMint: PublicKey;
  let wsolVault: PublicKey;

  before(async () => {
    [vaultPda] = PublicKey.findProgramAddressSync(
      [SOL_VAULT_SEED, VAULT_ID.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [sharesMint] = PublicKey.findProgramAddressSync(
      [SHARES_MINT_SEED, vaultPda.toBuffer()],
      program.programId
    );
    wsolVault = await getAssociatedTokenAddress(
      NATIVE_MINT, vaultPda, true, TOKEN_PROGRAM_ID
    );
  });

  it("initializes a Native SOL vault (Live model)", async () => {
    const tx = await program.methods
      .initialize(VAULT_ID, false)
      .accounts({
        authority: authority.publicKey,
        vault: vaultPda,
        nativeMint: NATIVE_MINT,
        sharesMint,
        wsolVault,
        splTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log(`  ✅ SVS-7 vault initialized: ${vaultPda.toBase58()}`);
    const vault = await program.account.solVault.fetch(vaultPda);
    assert.equal(vault.vaultId.toString(), VAULT_ID.toString());
    assert.equal(vault.paused, false);
  });

  it("deposits native SOL and receives shares", async () => {
    const depositLamports = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const tx = await program.methods
      .depositSol(depositLamports, new anchor.BN(0))
      .accounts({
        user: authority.publicKey,
        vault: vaultPda,
        nativeMint: NATIVE_MINT,
        sharesMint,
        wsolVault,
        userSharesAccount,
        splTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  ✅ Deposited 2 SOL, tx: ${tx}`);
    const sharesBalance = await provider.connection.getTokenAccountBalance(userSharesAccount);
    console.log(`  📊 Shares received: ${sharesBalance.value.uiAmount}`);
    assert.isAbove(Number(sharesBalance.value.amount), 0);
  });

  it("previews deposit correctly", async () => {
    await program.methods
      .previewDeposit(new anchor.BN(1 * LAMPORTS_PER_SOL))
      .accounts({ vault: vaultPda, sharesMint, wsolVault })
      .simulate();
    console.log(`  ✅ Preview deposit 1 SOL simulation passed`);
  });

  it("redeems shares for wSOL", async () => {
    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const userWsolAccount = await getAssociatedTokenAddress(
      NATIVE_MINT, authority.publicKey, false, TOKEN_PROGRAM_ID
    );
    const sharesBefore = await provider.connection.getTokenAccountBalance(userSharesAccount);
    const sharesToRedeem = new anchor.BN(sharesBefore.value.amount).divn(2);

    const tx = await program.methods
      .redeemWsol(sharesToRedeem, new anchor.BN(0))
      .accounts({
        user: authority.publicKey,
        vault: vaultPda,
        nativeMint: NATIVE_MINT,
        sharesMint,
        wsolVault,
        userSharesAccount,
        userWsolAccount,
        splTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  ✅ Redeemed shares for wSOL, tx: ${tx}`);
    const sharesAfter = await provider.connection.getTokenAccountBalance(userSharesAccount);
    assert.isBelow(Number(sharesAfter.value.amount), Number(sharesBefore.value.amount));
  });

  it("pauses and unpauses the vault", async () => {
    await program.methods.pause()
      .accounts({ authority: authority.publicKey, vault: vaultPda }).rpc();
    let vault = await program.account.solVault.fetch(vaultPda);
    assert.equal(vault.paused, true);
    console.log("  ✅ Vault paused");

    await program.methods.unpause()
      .accounts({ authority: authority.publicKey, vault: vaultPda }).rpc();
    vault = await program.account.solVault.fetch(vaultPda);
    assert.equal(vault.paused, false);
    console.log("  ✅ Vault unpaused");
  });

  it("rejects deposit when paused", async () => {
    await program.methods.pause()
      .accounts({ authority: authority.publicKey, vault: vaultPda }).rpc();
    const userSharesAccount = getAssociatedTokenAddressSync(
      sharesMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    try {
      await program.methods
        .depositSol(new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(0))
        .accounts({
          user: authority.publicKey,
          vault: vaultPda,
          nativeMint: NATIVE_MINT,
          sharesMint,
          wsolVault,
          userSharesAccount,
          splTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("Should have thrown VaultPaused");
    } catch (e: any) {
      assert.include(e.message.toLowerCase(), "paused");
      console.log("  ✅ Deposit correctly rejected when paused");
    }
    await program.methods.unpause()
      .accounts({ authority: authority.publicKey, vault: vaultPda }).rpc();
  });
});
