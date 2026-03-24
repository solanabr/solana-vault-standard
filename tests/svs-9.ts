import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Svs9 } from "../target/types/svs_9";
import { Svs1 } from "../target/types/svs_1";
import { SolanaVault } from "../sdk/core/src/vault";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

describe("svs-9", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs9 as Program<Svs9>;
  const svs1Program = anchor.workspace.Svs1 as Program<Svs1>;

  // ─── Keypairs ───
  const authority = Keypair.generate();
  const curator = Keypair.generate();
  const user = Keypair.generate();
  const impostor = Keypair.generate(); // Unauthorized actor

  // ─── Asset Mint (Mock USDC, 6 decimals) ───
  let assetMint: PublicKey;
  let userAssetAccount: PublicKey;

  // ─── SVS-9 State ───
  const vaultId = new BN(1);
  const idleBufferBps = 1000; // 10%
  let allocatorVaultPDA: PublicKey;
  let idleVaultATA: PublicKey;
  let sharesMint: PublicKey;

  // ─── Child Vault (real SVS-1 vault) ───
  let childVaultAddress: PublicKey;
  let childSharesMintAddress: PublicKey;
  const SVS1_ID = new PublicKey("Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC");
  
  // ─── PDAs and Derived Accounts ───
  let childAllocationPDA: PublicKey;
  let userSharesAccount: PublicKey;

  // ═══════════════════════════════════════════
  // Setup
  // ═══════════════════════════════════════════
  before(async () => {
    // Airdrop SOL to all actors
    const airdropAmount = 5 * LAMPORTS_PER_SOL;
    for (const kp of [authority, curator, user, impostor]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        airdropAmount
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create Asset Mint (SPL Token, 6 decimals)
    assetMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Initialize a real SVS-1 Vault for child vault testing
    const childVaultClient = await SolanaVault.create(svs1Program as any, {
      assetMint,
      vaultId: new BN(123),
      name: "SVS-1 Child Vault",
      symbol: "SVS1",
      uri: "https://svs.example.com",
    });
    // @ts-ignore - The client might not have authority field exposed if type is narrow
    const childAuthority = (childVaultClient as any).authority || authority.publicKey;
    childVaultAddress = childVaultClient.vault;
    childSharesMintAddress = childVaultClient.sharesMint;

    // Mint 10,000 USDC to user
    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      assetMint,
      user.publicKey
    );
    userAssetAccount = userAta.address;

    await mintTo(
      provider.connection,
      authority,
      assetMint,
      userAssetAccount,
      authority,
      10_000 * 10 ** 6
    );

    // Derive PDAs
    [allocatorVaultPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("allocator_vault"),
        assetMint.toBuffer(),
        vaultId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [childAllocationPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("child_allocation"),
        allocatorVaultPDA.toBuffer(),
        childVaultAddress.toBuffer(),
      ],
      program.programId
    );

    sharesMint = PublicKey.findProgramAddressSync(
      [Buffer.from("shares_mint"), allocatorVaultPDA.toBuffer()],
      program.programId
    )[0];

    idleVaultATA = getAssociatedTokenAddressSync(
      assetMint,
      allocatorVaultPDA,
      true
    );
  });

  async function getRemainingAccounts() {
    const childAllocations = await program.account.childAllocation.all([
      {
        memcmp: {
          offset: 8, // Discrim
          bytes: allocatorVaultPDA.toBase58(),
        },
      },
    ]);

    const remainingAccounts = [];
    for (const alloc of childAllocations) {
      if (alloc.account.enabled) {
        remainingAccounts.push({ pubkey: alloc.publicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childVault as PublicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childSharesAccount as PublicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: idleVaultATA, isSigner: false, isWritable: false }); // mock asset vault
        remainingAccounts.push({ pubkey: sharesMint, isSigner: false, isWritable: false }); // mock shares mint
      }
    }
    return remainingAccounts;
  }

  // ═══════════════════════════════════════════
  // 1. Initialize
  // ═══════════════════════════════════════════
  it("Initializes the SVS-9 Allocator Vault", async () => {
    await program.methods
      .initialize(vaultId, idleBufferBps)
      .accounts({
        authority: authority.publicKey,
        curator: curator.publicKey,
        allocatorVault: allocatorVaultPDA,
        assetMint: assetMint,
        sharesMint: sharesMint,
        idleVault: idleVaultATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
      .rpc();

    const state: any = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(state.curator.toBase58()).to.equal(curator.publicKey.toBase58());
    expect(state.vaultId.toNumber()).to.equal(1);
    expect(state.idleBufferBps).to.equal(idleBufferBps);
    expect(state.numChildren).to.equal(0);
    expect(state.paused).to.be.false;
  });

  // ═══════════════════════════════════════════
  // 2. Add Child (Register child vault)
  // ═══════════════════════════════════════════
  it("Adds a child vault", async () => {
    const allocatorChildSharesAccount = getAssociatedTokenAddressSync(
      childSharesMintAddress,
      allocatorVaultPDA,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .addChild(5000, 0)
      .accounts({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: childAllocationPDA,
        childVault: childVaultAddress,
        childProgram: SVS1_ID,
        childSharesMint: childSharesMintAddress,
        allocatorChildSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
      .rpc();

    const allocation = await program.account.childAllocation.fetch(
      childAllocationPDA
    );
    expect(allocation.maxWeightBps).to.equal(5000);
    expect(allocation.enabled).to.be.true;
    expect(allocation.depositedAssets.toNumber()).to.equal(0);

    const vaultState = await program.account.allocatorVault.fetch(
      allocatorVaultPDA
    );
    expect(vaultState.numChildren).to.equal(1);
  });

  // ═══════════════════════════════════════════
  // 3. Deposit (with user shares ATA creation)
  // ═══════════════════════════════════════════
  it("Processes user deposit successfully", async () => {
    // Create user shares ATA (Token-2022)
    const userSharesAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      sharesMint,
      user.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    userSharesAccount = userSharesAta.address;

    const depositAmount = new BN(1_000 * 10 ** 6); // 1,000 USDC

    await program.methods
      .deposit(depositAmount, new BN(0))
      .accounts({
        caller: user.publicKey,
        owner: user.publicKey,
        allocatorVault: allocatorVaultPDA,
        idleVault: idleVaultATA,
        sharesMint: sharesMint,
        callerAssetAccount: userAssetAccount,
        ownerSharesAccount: userSharesAccount,
        assetMint: assetMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      } as any)
      .remainingAccounts(await getRemainingAccounts())
      .signers([user])
      .rpc();

    const vaultState: any = await program.account.allocatorVault.fetch(
      allocatorVaultPDA
    );
    expect(vaultState.totalShares?.toNumber() || 0).to.equal(1_000 * 10 ** 9);

    const idleBalance = await provider.connection.getTokenAccountBalance(
      idleVaultATA
    );
    expect(idleBalance.value.amount).to.equal((1_000 * 10 ** 6).toString());
  });

  it("Rejects deposit when slippage is exceeded", async () => {
    const depositAmount = new BN(100 * 10 ** 6);
    const minSharesOut = new BN(200 * 10 ** 9); // Impossible (actual ~100e9)

    try {
      await program.methods
        .deposit(depositAmount, minSharesOut)
        .accounts({
          caller: user.publicKey,
          owner: user.publicKey,
          allocatorVault: allocatorVaultPDA,
          idleVault: idleVaultATA,
          sharesMint: sharesMint,
          callerAssetAccount: userAssetAccount,
          ownerSharesAccount: userSharesAccount,
          assetMint: assetMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        } as any)
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Should have failed with slippage error");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });

  it("Rejects deposit below minimum amount", async () => {
    const tinyAmount = new BN(100); 

    try {
      await program.methods
        .deposit(tinyAmount, new BN(0))
        .accounts({
          caller: user.publicKey,
          owner: user.publicKey,
          allocatorVault: allocatorVaultPDA,
          idleVault: idleVaultATA,
          sharesMint: sharesMint,
          callerAssetAccount: userAssetAccount,
          ownerSharesAccount: userSharesAccount,
          assetMint: assetMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        } as any)
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Should have failed with insufficient amount");
    } catch (err: any) {
      expect(err.toString()).to.include("DepositTooSmall");
    }
  });

  // ═══════════════════════════════════════════
  // 6. Access Control
  // ═══════════════════════════════════════════
  it("Rejects allocate from unauthorized curator", async () => {
    const allocateAmount = new BN(100 * 10 ** 6);
    try {
      await program.methods
        .allocate(allocateAmount, new BN(0))
        .accounts({
          curator: impostor.publicKey,
          allocatorVault: allocatorVaultPDA,
          childAllocation: childAllocationPDA,
          idleVault: idleVaultATA,
          childVault: childVaultAddress,
          childProgram: SVS1_ID,
          childAssetMint: assetMint,
          childAssetVault: idleVaultATA,
          childSharesMint: childSharesMintAddress,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          allocatorChildSharesAccount: getAssociatedTokenAddressSync(childSharesMintAddress, allocatorVaultPDA, true, TOKEN_2022_PROGRAM_ID),
        } as any)
        .remainingAccounts(await getRemainingAccounts())
        .signers([impostor])
        .rpc();
      expect.fail("Should have failed: impostor is not curator");
    } catch (err: any) {
      expect(err.toString()).to.satisfy(
        (msg: string) =>
          msg.includes("Unauthorized") ||
          msg.includes("has_one") ||
          msg.includes("6004") ||
          msg.includes("2001")
      );
    }
  });

  // ═══════════════════════════════════════════
  // 7. Admin Controls (Pause / Unpause)
  // ═══════════════════════════════════════════
  it("Pauses and unpauses correctly", async () => {
    // Pause
    await program.methods
      .pause()
      .accounts({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      } as any)
      .signers([authority])
      .rpc();

    let state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.paused).to.be.true;

    // Reject deposit when paused
    try {
      await program.methods
        .deposit(new BN(1000 * 10 ** 6), new BN(0))
        .accounts({
          caller: user.publicKey,
          owner: user.publicKey,
          allocatorVault: allocatorVaultPDA,
          idleVault: idleVaultATA,
          sharesMint: sharesMint,
          callerAssetAccount: userAssetAccount,
          ownerSharesAccount: userSharesAccount,
          assetMint: assetMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();
      expect.fail("Should have failed: vault is paused");
    } catch (err: any) {
      expect(err.toString()).to.include("VaultPaused");
    }

    // Unpause
    await program.methods
      .unpause()
      .accounts({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      } as any)
      .signers([authority])
      .rpc();

    state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.paused).to.be.false;
  });

  // ═══════════════════════════════════════════
  // 8. Management
  // ═══════════════════════════════════════════
  it("Removes/disables a child vault", async () => {
    await program.methods
      .removeChild()
      .accounts({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: childAllocationPDA,
        childVault: childVaultAddress,
        allocatorChildSharesAccount: getAssociatedTokenAddressSync(childSharesMintAddress, allocatorVaultPDA, true, TOKEN_2022_PROGRAM_ID),
      } as any)
      .signers([authority])
      .rpc();

    try {
      await program.account.childAllocation.fetch(childAllocationPDA);
      expect.fail("Account should have been closed");
    } catch (err: any) {
      expect(err.toString()).to.include("Account does not exist");
    }

    const state: any = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.numChildren).to.equal(0);
    expect(state.totalShares.toNumber()).to.equal(1_000 * 10 ** 9);
  });

  it("Sets a new curator", async () => {
    const newCurator = Keypair.generate().publicKey;
    await program.methods
      .setCurator(newCurator)
      .accounts({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      } as any)
      .signers([authority])
      .rpc();

    const state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.curator.toBase58()).to.equal(newCurator.toBase58());
  });

  // ═══════════════════════════════════════════
  // 10. Withdraw / Redeem Logic
  // ═══════════════════════════════════════════
  it("Redeems shares for assets", async () => {
    const redeemAmount = new BN(100 * 10 ** 9);
    const initialUserIdle = (await provider.connection.getTokenAccountBalance(userAssetAccount)).value.uiAmount;

    await program.methods
      .redeem(redeemAmount, new BN(0))
      .accounts({
        caller: user.publicKey,
        owner: user.publicKey,
        allocatorVault: allocatorVaultPDA,
        assetMint: assetMint,
        sharesMint: sharesMint,
        idleVault: idleVaultATA,
        ownerSharesAccount: userSharesAccount,
        callerAssetAccount: userAssetAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      } as any)
      .remainingAccounts(await getRemainingAccounts())
      .signers([user])
      .rpc();

    const currentUserIdle = (await provider.connection.getTokenAccountBalance(userAssetAccount)).value.uiAmount;
    expect(currentUserIdle!).to.be.approximately(initialUserIdle! + 100, 0.001);
  });
});