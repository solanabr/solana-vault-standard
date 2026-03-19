import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Svs9 } from "../target/types/svs_9";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
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
  const sharesMintKeypair = Keypair.generate();

  // ─── Child Vault (real SVS-1 style mock) ───
  const childVaultMock = Keypair.generate().publicKey;
  const childProgram = program.programId;
  let childAllocationPDA: PublicKey;

  // ─── User Shares Account ───
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
        childVaultMock.toBuffer(),
      ],
      program.programId
    );

    idleVaultATA = anchor.utils.token.associatedAddress({
      mint: assetMint,
      owner: allocatorVaultPDA,
    });

    sharesMint = sharesMintKeypair.publicKey;
  });
  // ─── Helpers ───
  async function getRemainingAccounts(): Promise<anchor.web3.AccountMeta[]> {
    const remainingAccounts: anchor.web3.AccountMeta[] = [];
    const childAllocations = await program.account.childAllocation.all([
      {
        memcmp: {
          offset: 8,
          bytes: allocatorVaultPDA.toBase58(),
        },
      },
    ]);
    for (const alloc of childAllocations) {
      if (alloc.account.enabled) {
        remainingAccounts.push({ pubkey: alloc.publicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childVault as PublicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childSharesAccount as PublicKey, isSigner: false, isWritable: false });
      }
    }
    return remainingAccounts;
  }

  // ═══════════════════════════════════════════
  // 1. Initialize
  // ═══════════════════════════════════════════
  it("Inicializa o SVS-9 Allocator Vault", async () => {
    await (program.methods as any)
      .initialize(vaultId, idleBufferBps, 0) // decimals_offset=0; lint resolves after anchor build
      .accountsPartial({
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
      })
      .signers([authority, sharesMintKeypair])
      .rpc();

    const state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(state.curator.toBase58()).to.equal(curator.publicKey.toBase58());
    expect(state.idleBufferBps).to.equal(idleBufferBps);
    expect(state.numChildren).to.equal(0);
    expect(state.paused).to.be.false;
  });

  // ═══════════════════════════════════════════
  // 2. Add Child
  // ═══════════════════════════════════════════
  it("Registra um cofre filho (Add Child)", async () => {
    await program.methods
      .addChild(5000)
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: childAllocationPDA,
        childVault: childVaultMock,
        childProgram: childProgram,
        systemProgram: SystemProgram.programId,
      })
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
  it("Processa depósito de um usuário", async () => {
    // Create user shares ATA (Token-2022)
    const userSharesAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
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
      .deposit(depositAmount, new BN(0)) // min_shares_out = 0 (first deposit = 1:1)
      .accountsPartial({
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
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(await getRemainingAccounts())
      .signers([user])
      .rpc();

    // Verify idle vault received the assets
    const idleBalance = await provider.connection.getTokenAccountBalance(
      idleVaultATA
    );
    expect(idleBalance.value.amount).to.equal(depositAmount.toString());

    // Verify user received shares
    const sharesBalance = await getAccount(
      provider.connection,
      userSharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(sharesBalance.amount)).to.be.greaterThan(0);
  });

  // ═══════════════════════════════════════════
  // 4. Slippage Exceeded (deposit)
  // ═══════════════════════════════════════════
  it("Rejeita depósito quando slippage é excedido", async () => {
    const depositAmount = new BN(1_000 * 10 ** 6);
    const unreasonableMinShares = new BN(2_000 * 10 ** 6); // Exige mais shares do que possível

    try {
      await program.methods
        .deposit(depositAmount, unreasonableMinShares)
        .accountsPartial({
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
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Deveria ter falhado com SlippageExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });

  // ═══════════════════════════════════════════
  // 5. Zero Amount
  // ═══════════════════════════════════════════
  it("Rejeita depósito de valor zero", async () => {
    try {
      await program.methods
        .deposit(new BN(0), new BN(0))
        .accountsPartial({
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
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Deveria ter falhado com ZeroAmount");
    } catch (err: any) {
      expect(err.toString()).to.include("ZeroAmount");
    }
  });

  // ═══════════════════════════════════════════
  // 6. Unauthorized Curator (allocate)
  // ═══════════════════════════════════════════
  it("Rejeita allocate por conta não autorizada", async () => {
    const allocateAmount = new BN(100 * 10 ** 6);

    try {
      await program.methods
        .allocate(allocateAmount)
        .accountsPartial({
          curator: impostor.publicKey, // NÃO é o curator real
          allocatorVault: allocatorVaultPDA,
          childAllocation: childAllocationPDA,
          idleVault: idleVaultATA,
          childVault: childVaultMock,
          childProgram: childProgram,
          childAssetMint: assetMint,
          childAssetVault: idleVaultATA,
          childSharesMint: sharesMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts(await getRemainingAccounts())
        .signers([impostor])
        .rpc();
      expect.fail("Deveria ter falhado: impostor não é curator");
    } catch (err: any) {
      // Anchor constraint error: has_one = curator
      expect(err.toString()).to.satisfy(
        (msg: string) =>
          msg.includes("ConstraintHasOne") ||
          msg.includes("has_one") ||
          msg.includes("A has one constraint was violated") ||
          msg.includes("2001") // Anchor ConstraintHasOne error code
      );
    }
  });

  // ═══════════════════════════════════════════
  // 7. Admin Controls (Pause / Unpause)
  // ═══════════════════════════════════════════
  it("Pausa e despausa corretamente", async () => {
    // Pause
    await program.methods
      .pause()
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([authority])
      .rpc();

    let state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.paused).to.be.true;

    // Verify deposit fails when paused
    try {
      await program.methods
        .deposit(new BN(100 * 10 ** 6), new BN(0))
        .accountsPartial({
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
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Deveria ter falhado com cofre pausado");
    } catch (err: any) {
      expect(err.toString()).to.include("VaultPaused");
    }

    // Unpause
    await program.methods
      .unpause()
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([authority])
      .rpc();

    state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.paused).to.be.false;
  });

  // ═══════════════════════════════════════════
  // 8. Remove Child
  // ═══════════════════════════════════════════
  it("Remove (desativa) um cofre filho", async () => {
    await program.methods
      .removeChild()
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: childAllocationPDA,
        childVault: childVaultMock,
      })
      .signers([authority])
      .rpc();

    const allocation = await program.account.childAllocation.fetch(
      childAllocationPDA
    );
    expect(allocation.enabled).to.be.false;
    expect(allocation.maxWeightBps).to.equal(0);
    expect(allocation.targetWeightBps).to.equal(0);

    const vaultState = await program.account.allocatorVault.fetch(
      allocatorVaultPDA
    );
    expect(vaultState.numChildren).to.equal(0);
  });

  // ═══════════════════════════════════════════
  // 9. Update Weights
  // ═══════════════════════════════════════════
  it("Re-adiciona child e atualiza pesos", async () => {
    // Re-adicionar child primeiro (o anterior foi desabilitado, não deletado)
    // Precisamos de um novo child vault para criar um novo PDA
    const newChildVault = Keypair.generate().publicKey;
    const [newChildPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("child_allocation"),
        allocatorVaultPDA.toBuffer(),
        newChildVault.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .addChild(3000) // 30% max weight
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: newChildPDA,
        childVault: newChildVault,
        childProgram: childProgram,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    // Update weights to 7000 bps (70%)
    await program.methods
      .updateWeights(7000)
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
        childAllocation: newChildPDA,
        childVault: newChildVault,
      })
      .signers([authority])
      .rpc();

    const allocation = await program.account.childAllocation.fetch(newChildPDA);
    expect(allocation.maxWeightBps).to.equal(7000);
  });

  // ═══════════════════════════════════════════
  // 10. Transfer Authority
  // ═══════════════════════════════════════════
  it("Transfere authority do vault", async () => {
    const newAuthority = Keypair.generate();

    await program.methods
      .transferAuthority(newAuthority.publicKey)
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([authority])
      .rpc();

    const state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.authority.toBase58()).to.equal(
      newAuthority.publicKey.toBase58()
    );

    // Restore original authority for remaining tests
    await program.methods
      .transferAuthority(authority.publicKey)
      .accountsPartial({
        authority: newAuthority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([newAuthority])
      .rpc();
  });

  // ═══════════════════════════════════════════
  // 11. Set Curator
  // ═══════════════════════════════════════════
  it("Define um novo curator", async () => {
    const newCurator = Keypair.generate();

    await program.methods
      .setCurator(newCurator.publicKey)
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([authority])
      .rpc();

    const state = await program.account.allocatorVault.fetch(allocatorVaultPDA);
    expect(state.curator.toBase58()).to.equal(
      newCurator.publicKey.toBase58()
    );

    // Restore original curator for remaining tests
    await program.methods
      .setCurator(curator.publicKey)
      .accountsPartial({
        authority: authority.publicKey,
        allocatorVault: allocatorVaultPDA,
      })
      .signers([authority])
      .rpc();
  });

  // ═══════════════════════════════════════════
  // 12. Redeem (Full Flow)
  // ═══════════════════════════════════════════
  it("Redeem: queima shares e recebe assets de volta", async () => {
    // Get user's current shares balance
    const sharesAccountBefore = await getAccount(
      provider.connection,
      userSharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const sharesToRedeem = new BN(sharesAccountBefore.amount.toString());

    if (sharesToRedeem.isZero()) {
      console.log("    ⚠ Nenhuma share disponível para redeem, pulando...");
      return;
    }

    // Get user asset balance before
    const assetBefore = await provider.connection.getTokenAccountBalance(
      userAssetAccount
    );

    await program.methods
      .redeem(sharesToRedeem, new BN(0)) // min_assets_out = 0
      .accountsPartial({
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
      })
      .remainingAccounts(await getRemainingAccounts())
      .signers([user])
      .rpc();

    // Verify shares were burned
    const sharesAccountAfter = await getAccount(
      provider.connection,
      userSharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(sharesAccountAfter.amount)).to.equal(0);

    // Verify user received assets back
    const assetAfter = await provider.connection.getTokenAccountBalance(
      userAssetAccount
    );
    expect(Number(assetAfter.value.amount)).to.be.greaterThan(
      Number(assetBefore.value.amount)
    );
  });

  // ═══════════════════════════════════════════
  // 13. Slippage Exceeded (redeem)
  // ═══════════════════════════════════════════
  it("Rejeita redeem quando slippage é excedido", async () => {
    // Need shares to test redeem slippage — deposit first
    const depositAmount = new BN(500 * 10 ** 6);
    await program.methods
      .deposit(depositAmount, new BN(0))
      .accountsPartial({
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
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(await getRemainingAccounts())
      .signers([user])
      .rpc();

    const sharesAccount = await getAccount(
      provider.connection,
      userSharesAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const shares = new BN(sharesAccount.amount.toString());

    // Demand more assets than possible
    const unreasonableMinAssets = new BN(999_999 * 10 ** 6);

    try {
      await program.methods
        .redeem(shares, unreasonableMinAssets)
        .accountsPartial({
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
        })
        .remainingAccounts(await getRemainingAccounts())
        .signers([user])
        .rpc();
      expect.fail("Deveria ter falhado com SlippageExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });
});