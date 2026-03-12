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
import { Svs12 } from "../target/types/svs_12";

describe("svs-12 (Tranched Vault)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Svs12 as Program<Svs12>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let assetMint: PublicKey;
  let vault: PublicKey;
  let assetVault: PublicKey;
  let userAssetAta: PublicKey;
  const vaultId = new BN(1);
  const ASSET_DECIMALS = 6;
  const LAMPORTS = 10 ** ASSET_DECIMALS;

  // Tranche PDAs
  let seniorTranche: PublicKey;
  let juniorTranche: PublicKey;
  let seniorSharesMint: PublicKey;
  let juniorSharesMint: PublicKey;

  const getVaultPDA = (assetMint: PublicKey, vaultId: BN): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tranched_vault"), assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  };

  const getTranchePDA = (vault: PublicKey, index: number): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tranche"), vault.toBuffer(), Buffer.from([index])],
      program.programId
    );
  };

  const getSharesMintPDA = (vault: PublicKey, index: number): [PublicKey, number] => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), vault.toBuffer(), Buffer.from([index])],
      program.programId
    );
  };

  before(async () => {
    assetMint = await createMint(
      connection, payer, payer.publicKey, null, ASSET_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );

    [vault] = getVaultPDA(assetMint, vaultId);

    assetVault = getAssociatedTokenAddressSync(
      assetMint, vault, true, TOKEN_PROGRAM_ID
    );

    // Mint 10M assets to payer
    const userAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection, payer, assetMint, payer.publicKey, false,
      undefined, undefined, TOKEN_PROGRAM_ID
    );
    userAssetAta = userAtaAccount.address;
    await mintTo(
      connection, payer, assetMint, userAssetAta,
      payer.publicKey, 10_000_000 * LAMPORTS,
      [], undefined, TOKEN_PROGRAM_ID
    );

    // Derive tranche PDAs
    [seniorTranche] = getTranchePDA(vault, 0);
    [juniorTranche] = getTranchePDA(vault, 1);
    [seniorSharesMint] = getSharesMintPDA(vault, 0);
    [juniorSharesMint] = getSharesMintPDA(vault, 1);
  });

  // ======================== Initialize ========================

  it("initializes vault with sequential waterfall", async () => {
    await program.methods
      .initialize(vaultId, 0)
      .accounts({
        authority: payer.publicKey,
        vault,
        assetMint,
        assetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(payer.publicKey.toString());
    expect(vaultAccount.numTranches).to.equal(0);
    expect(vaultAccount.paused).to.be.false;
    expect(vaultAccount.wiped).to.be.false;
    expect(vaultAccount.priorityBitmap).to.equal(0);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(0);
  });

  // ======================== Add Tranches ========================

  it("adds senior tranche (priority=0, sub=2000bps)", async () => {
    await program.methods
      .addTranche(0, 2000, 500, 10000)  // priority=0, sub=20%, yield=5%, cap=100%
      .accounts({
        authority: payer.publicKey,
        vault,
        tranche: seniorTranche,
        sharesMint: seniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const tranche = await program.account.tranche.fetch(seniorTranche);
    expect(tranche.priority).to.equal(0);
    expect(tranche.subordinationBps).to.equal(2000);
    expect(tranche.index).to.equal(0);

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.numTranches).to.equal(1);
    expect(vaultAccount.priorityBitmap).to.equal(1); // bit 0 set
  });

  it("adds junior tranche (priority=1, sub=0)", async () => {
    await program.methods
      .addTranche(1, 0, 0, 10000)  // priority=1, sub=0%, yield=0% (equity), cap=100%
      .accounts({
        authority: payer.publicKey,
        vault,
        tranche: juniorTranche,
        sharesMint: juniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.numTranches).to.equal(2);
    expect(vaultAccount.priorityBitmap).to.equal(3); // bits 0,1 set
  });

  it("rejects duplicate priority", async () => {
    const [fakeTranche] = getTranchePDA(vault, 2);
    const [fakeSharesMint] = getSharesMintPDA(vault, 2);

    try {
      await program.methods
        .addTranche(0, 0, 0, 10000)  // priority=0 already taken
        .accounts({
          authority: payer.publicKey,
          vault,
          tranche: fakeTranche,
          sharesMint: fakeSharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("DuplicatePriority");
    }
  });

  // ======================== Deposit ========================

  it("deposits into junior tranche", async () => {
    // Create user shares ATA for junior
    await getOrCreateAssociatedTokenAccount(
      connection, payer, juniorSharesMint, payer.publicKey, false,
      undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .deposit(new BN(500_000 * LAMPORTS), new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: juniorTranche,
        tranche1: seniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAssetAta,
        assetVault,
        sharesMint: juniorSharesMint,
        userSharesAccount: userSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const tranche = await program.account.tranche.fetch(juniorTranche);
    expect(tranche.totalAssetsAllocated.toNumber()).to.equal(500_000 * LAMPORTS);
    expect(tranche.totalShares.toNumber()).to.be.greaterThan(0);
  });

  it("deposits into senior tranche", async () => {
    // Create user shares ATA for senior
    await getOrCreateAssociatedTokenAccount(
      connection, payer, seniorSharesMint, payer.publicKey, false,
      undefined, undefined, TOKEN_2022_PROGRAM_ID
    );
    const userSharesAta = getAssociatedTokenAddressSync(
      seniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    await program.methods
      .deposit(new BN(1_000_000 * LAMPORTS), new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAssetAta,
        assetVault,
        sharesMint: seniorSharesMint,
        userSharesAccount: userSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(1_500_000 * LAMPORTS);
  });

  // ======================== Distribute Yield ========================

  it("distributes yield via sequential waterfall", async () => {
    // Manager needs to deposit yield tokens first
    const yieldAmount = new BN(100_000 * LAMPORTS);

    await program.methods
      .distributeYield(yieldAmount)
      .accounts({
        manager: payer.publicKey,
        vault,
        assetMint,
        managerAssetAccount: userAssetAta,
        assetVault,
        tranche0: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(1_600_000 * LAMPORTS);

    // Senior should get target yield (5% of 1M = 50K), junior gets remainder (50K)
    const senior = await program.account.tranche.fetch(seniorTranche);
    const junior = await program.account.tranche.fetch(juniorTranche);
    expect(senior.totalAssetsAllocated.toNumber()).to.equal(1_050_000 * LAMPORTS);
    expect(junior.totalAssetsAllocated.toNumber()).to.equal(550_000 * LAMPORTS);
  });

  // ======================== Record Loss ========================

  it("records loss with bottom-up absorption", async () => {
    const lossAmount = new BN(100_000 * LAMPORTS);

    await program.methods
      .recordLoss(lossAmount)
      .accounts({
        manager: payer.publicKey,
        vault,
        tranche0: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
      })
      .rpc();

    // Junior absorbs first
    const junior = await program.account.tranche.fetch(juniorTranche);
    expect(junior.totalAssetsAllocated.toNumber()).to.equal(450_000 * LAMPORTS);

    // Senior should be untouched
    const senior = await program.account.tranche.fetch(seniorTranche);
    expect(senior.totalAssetsAllocated.toNumber()).to.equal(1_050_000 * LAMPORTS);

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.totalAssets.toNumber()).to.equal(1_500_000 * LAMPORTS);
    expect(vaultAccount.wiped).to.be.false;
  });

  // ======================== Redeem ========================

  it("redeems from junior tranche", async () => {
    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const sharesAccount = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
    // Redeem a small amount
    const redeemShares = new BN(Number(sharesAccount.amount) / 10);

    await program.methods
      .redeem(redeemShares, new BN(0))
      .accounts({
        user: payer.publicKey,
        vault,
        targetTranche: juniorTranche,
        tranche1: seniorTranche,
        tranche2: null,
        tranche3: null,
        assetMint,
        userAssetAccount: userAssetAta,
        assetVault,
        sharesMint: juniorSharesMint,
        userSharesAccount: userSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const tranche = await program.account.tranche.fetch(juniorTranche);
    expect(tranche.totalAssetsAllocated.toNumber()).to.be.lessThan(450_000 * LAMPORTS);
  });

  // ======================== Rebalance ========================

  it("rebalances between tranches", async () => {
    const amount = new BN(50_000 * LAMPORTS);

    await program.methods
      .rebalanceTranches(amount)
      .accounts({
        manager: payer.publicKey,
        vault,
        fromTranche: seniorTranche,
        toTranche: juniorTranche,
        otherTranche0: null,
        otherTranche1: null,
      })
      .rpc();

    const senior = await program.account.tranche.fetch(seniorTranche);
    expect(senior.totalAssetsAllocated.toNumber()).to.equal(1_000_000 * LAMPORTS);
  });

  // ======================== Admin ========================

  it("pauses and unpauses vault", async () => {
    await program.methods
      .pause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();

    let vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.paused).to.be.true;

    await program.methods
      .unpause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();

    vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.paused).to.be.false;
  });

  it("updates tranche config", async () => {
    await program.methods
      .updateTrancheConfig(new BN(600) as any, null, null)
      .accounts({
        authority: payer.publicKey,
        vault,
        targetTranche: seniorTranche,
        tranche1: juniorTranche,
        tranche2: null,
        tranche3: null,
      })
      .rpc();

    const senior = await program.account.tranche.fetch(seniorTranche);
    expect(senior.targetYieldBps).to.equal(600);
  });

  // ======================== Error Cases ========================

  it("rejects deposit when paused", async () => {
    await program.methods
      .pause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();

    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    try {
      await program.methods
        .deposit(new BN(1000), new BN(0))
        .accounts({
          user: payer.publicKey,
          vault,
          targetTranche: juniorTranche,
          tranche1: seniorTranche,
          tranche2: null,
          tranche3: null,
          assetMint,
          userAssetAccount: userAssetAta,
          assetVault,
          sharesMint: juniorSharesMint,
          userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultPaused");
    }

    // Unpause for remaining tests
    await program.methods
      .unpause()
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
  });

  it("rejects zero amount deposit", async () => {
    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    try {
      await program.methods
        .deposit(new BN(0), new BN(0))
        .accounts({
          user: payer.publicKey,
          vault,
          targetTranche: juniorTranche,
          tranche1: seniorTranche,
          tranche2: null,
          tranche3: null,
          assetMint,
          userAssetAccount: userAssetAta,
          assetVault,
          sharesMint: juniorSharesMint,
          userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("ZeroAmount");
    }
  });

  it("rejects unauthorized manager", async () => {
    const fakeManager = Keypair.generate();
    const sig = await connection.requestAirdrop(fakeManager.publicKey, 1_000_000_000);
    await connection.confirmTransaction(sig);

    try {
      await program.methods
        .distributeYield(new BN(1000))
        .accounts({
          manager: fakeManager.publicKey,
          vault,
          assetMint,
          managerAssetAccount: userAssetAta,
          assetVault,
          tranche0: seniorTranche,
          tranche1: juniorTranche,
          tranche2: null,
          tranche3: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([fakeManager])
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("Unauthorized");
    }
  });

  // ======================== Extended Error Cases ========================

  it("rejects zero amount redeem", async () => {
    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    try {
      await program.methods
        .redeem(new BN(0), new BN(0))
        .accounts({
          user: payer.publicKey, vault,
          targetTranche: juniorTranche, tranche1: seniorTranche, tranche2: null, tranche3: null,
          assetMint, userAssetAccount: userAssetAta, assetVault,
          sharesMint: juniorSharesMint, userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("ZeroAmount");
    }
  });

  it("rejects zero amount yield distribution", async () => {
    try {
      await program.methods
        .distributeYield(new BN(0))
        .accounts({
          manager: payer.publicKey, vault, assetMint,
          managerAssetAccount: userAssetAta, assetVault,
          tranche0: seniorTranche, tranche1: juniorTranche, tranche2: null, tranche3: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("ZeroAmount");
    }
  });

  it("rejects zero amount loss", async () => {
    try {
      await program.methods
        .recordLoss(new BN(0))
        .accounts({
          manager: payer.publicKey, vault,
          tranche0: seniorTranche, tranche1: juniorTranche, tranche2: null, tranche3: null,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("ZeroAmount");
    }
  });

  it("rejects zero amount rebalance", async () => {
    try {
      await program.methods
        .rebalanceTranches(new BN(0))
        .accounts({
          manager: payer.publicKey, vault,
          fromTranche: seniorTranche, toTranche: juniorTranche,
          otherTranche0: null, otherTranche1: null,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("ZeroAmount");
    }
  });

  it("rejects redeem when paused", async () => {
    await program.methods.pause().accounts({ authority: payer.publicKey, vault }).rpc();
    const userSharesAta = getAssociatedTokenAddressSync(
      juniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    try {
      await program.methods
        .redeem(new BN(1000), new BN(0))
        .accounts({
          user: payer.publicKey, vault,
          targetTranche: juniorTranche, tranche1: seniorTranche, tranche2: null, tranche3: null,
          assetMint, userAssetAccount: userAssetAta, assetVault,
          sharesMint: juniorSharesMint, userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultPaused");
    }
    await program.methods.unpause().accounts({ authority: payer.publicKey, vault }).rpc();
  });

  it("rejects yield distribution when paused", async () => {
    await program.methods.pause().accounts({ authority: payer.publicKey, vault }).rpc();
    try {
      await program.methods
        .distributeYield(new BN(1000))
        .accounts({
          manager: payer.publicKey, vault, assetMint,
          managerAssetAccount: userAssetAta, assetVault,
          tranche0: seniorTranche, tranche1: juniorTranche, tranche2: null, tranche3: null,
          assetTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultPaused");
    }
    await program.methods.unpause().accounts({ authority: payer.publicKey, vault }).rpc();
  });

  it("rejects record loss when paused", async () => {
    await program.methods.pause().accounts({ authority: payer.publicKey, vault }).rpc();
    try {
      await program.methods
        .recordLoss(new BN(1000))
        .accounts({
          manager: payer.publicKey, vault,
          tranche0: seniorTranche, tranche1: juniorTranche, tranche2: null, tranche3: null,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultPaused");
    }
    await program.methods.unpause().accounts({ authority: payer.publicKey, vault }).rpc();
  });

  it("rejects double pause", async () => {
    await program.methods.pause().accounts({ authority: payer.publicKey, vault }).rpc();
    try {
      await program.methods.pause().accounts({ authority: payer.publicKey, vault }).rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultPaused");
    }
    await program.methods.unpause().accounts({ authority: payer.publicKey, vault }).rpc();
  });

  it("rejects unpause when not paused", async () => {
    try {
      await program.methods.unpause().accounts({ authority: payer.publicKey, vault }).rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("VaultNotPaused");
    }
  });

  // ======================== Authority & Manager ========================

  it("transfers authority", async () => {
    const newAuth = Keypair.generate();
    await program.methods
      .transferAuthority(newAuth.publicKey)
      .accounts({ authority: payer.publicKey, vault })
      .rpc();

    let vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(newAuth.publicKey.toString());

    const airdropSig = await connection.requestAirdrop(newAuth.publicKey, 1_000_000_000);
    await connection.confirmTransaction(airdropSig);

    await program.methods
      .transferAuthority(payer.publicKey)
      .accounts({ authority: newAuth.publicKey, vault })
      .signers([newAuth])
      .rpc();

    vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.authority.toString()).to.equal(payer.publicKey.toString());
  });

  it("rejects unauthorized authority transfer", async () => {
    const fakeAuth = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(fakeAuth.publicKey, 1_000_000_000);
    await connection.confirmTransaction(airdropSig);

    try {
      await program.methods
        .transferAuthority(fakeAuth.publicKey)
        .accounts({ authority: fakeAuth.publicKey, vault })
        .signers([fakeAuth])
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("Unauthorized");
    }
  });

  it("sets new manager", async () => {
    const newManager = Keypair.generate();
    await program.methods
      .setManager(newManager.publicKey)
      .accounts({ authority: payer.publicKey, vault })
      .rpc();

    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    expect(vaultAccount.manager.toString()).to.equal(newManager.publicKey.toString());

    await program.methods
      .setManager(payer.publicKey)
      .accounts({ authority: payer.publicKey, vault })
      .rpc();
  });

  // ======================== Config Validation ========================

  it("rejects invalid subordination bps (> 10000)", async () => {
    const [fakeTranche] = getTranchePDA(vault, 2);
    const [fakeSharesMint] = getSharesMintPDA(vault, 2);
    try {
      await program.methods
        .addTranche(2, 10001, 0, 10000)
        .accounts({
          authority: payer.publicKey, vault,
          tranche: fakeTranche, sharesMint: fakeSharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("InvalidSubordinationConfig");
    }
  });

  it("rejects invalid cap bps (0)", async () => {
    const [fakeTranche] = getTranchePDA(vault, 2);
    const [fakeSharesMint] = getSharesMintPDA(vault, 2);
    try {
      await program.methods
        .addTranche(2, 0, 0, 0)
        .accounts({
          authority: payer.publicKey, vault,
          tranche: fakeTranche, sharesMint: fakeSharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("InvalidCapConfig");
    }
  });

  it("rejects invalid yield bps (> 10000)", async () => {
    const [fakeTranche] = getTranchePDA(vault, 2);
    const [fakeSharesMint] = getSharesMintPDA(vault, 2);
    try {
      await program.methods
        .addTranche(2, 0, 10001, 10000)
        .accounts({
          authority: payer.publicKey, vault,
          tranche: fakeTranche, sharesMint: fakeSharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("InvalidYieldConfig");
    }
  });

  it("rejects priority >= 8", async () => {
    const [fakeTranche] = getTranchePDA(vault, 2);
    const [fakeSharesMint] = getSharesMintPDA(vault, 2);
    try {
      await program.methods
        .addTranche(8, 0, 0, 10000)
        .accounts({
          authority: payer.publicKey, vault,
          tranche: fakeTranche, sharesMint: fakeSharesMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.error?.errorCode?.code || e.message).to.contain("DuplicatePriority");
    }
  });

  // ======================== Invariant Checks ========================

  it("vault.total_assets equals sum of tranche allocations", async () => {
    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    const senior = await program.account.tranche.fetch(seniorTranche);
    const junior = await program.account.tranche.fetch(juniorTranche);
    const sum = senior.totalAssetsAllocated.toNumber() + junior.totalAssetsAllocated.toNumber();
    expect(vaultAccount.totalAssets.toNumber()).to.equal(sum);
  });

  it("tranche state has correct vault reference", async () => {
    const senior = await program.account.tranche.fetch(seniorTranche);
    const junior = await program.account.tranche.fetch(juniorTranche);
    expect(senior.vault.toString()).to.equal(vault.toString());
    expect(junior.vault.toString()).to.equal(vault.toString());
  });

  it("tranche indices match creation order", async () => {
    const senior = await program.account.tranche.fetch(seniorTranche);
    const junior = await program.account.tranche.fetch(juniorTranche);
    expect(senior.index).to.equal(0);
    expect(junior.index).to.equal(1);
  });

  it("bumps are stored correctly", async () => {
    const vaultAccount = await program.account.tranchedVault.fetch(vault);
    const senior = await program.account.tranche.fetch(seniorTranche);
    const junior = await program.account.tranche.fetch(juniorTranche);
    expect(vaultAccount.bump).to.be.greaterThan(0);
    expect(senior.bump).to.be.greaterThan(0);
    expect(junior.bump).to.be.greaterThan(0);
    expect(senior.sharesMintBump).to.be.greaterThan(0);
    expect(junior.sharesMintBump).to.be.greaterThan(0);
  });
});
