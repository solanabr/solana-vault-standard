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

  // ======================== Insufficient Shares Redeem ========================

  describe("Insufficient Shares Redeem", () => {
    let v2Mint: PublicKey;
    let v2Vault: PublicKey;
    let v2AssetVault: PublicKey;
    let v2UserAssetAta: PublicKey;
    let v2SeniorTranche: PublicKey;
    let v2JuniorTranche: PublicKey;
    let v2SeniorSharesMint: PublicKey;
    let v2JuniorSharesMint: PublicKey;
    const v2Id = new BN(100);

    before(async () => {
      v2Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [v2Vault] = getVaultPDA(v2Mint, v2Id);
      v2AssetVault = getAssociatedTokenAddressSync(v2Mint, v2Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v2Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v2UserAssetAta = ata.address;
      await mintTo(connection, payer, v2Mint, v2UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v2SeniorTranche] = getTranchePDA(v2Vault, 0);
      [v2JuniorTranche] = getTranchePDA(v2Vault, 1);
      [v2SeniorSharesMint] = getSharesMintPDA(v2Vault, 0);
      [v2JuniorSharesMint] = getSharesMintPDA(v2Vault, 1);

      await program.methods.initialize(v2Id, 0).accounts({
        authority: payer.publicKey, vault: v2Vault, assetMint: v2Mint, assetVault: v2AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      await program.methods.addTranche(0, 0, 500, 10000).accounts({
        authority: payer.publicKey, vault: v2Vault, tranche: v2SeniorTranche, sharesMint: v2SeniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      await program.methods.addTranche(1, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: v2Vault, tranche: v2JuniorTranche, sharesMint: v2JuniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Deposit small amount into junior
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v2JuniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const userSharesAta = getAssociatedTokenAddressSync(
        v2JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      await program.methods.deposit(new BN(1000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v2Vault, targetTranche: v2JuniorTranche,
        tranche1: v2SeniorTranche, tranche2: null, tranche3: null,
        assetMint: v2Mint, userAssetAccount: v2UserAssetAta, assetVault: v2AssetVault,
        sharesMint: v2JuniorSharesMint, userSharesAccount: userSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("rejects redeem exceeding user share balance", async () => {
      const userSharesAta = getAssociatedTokenAddressSync(
        v2JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      const sharesAccount = await getAccount(connection, userSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
      const excessiveShares = new BN(Number(sharesAccount.amount)).add(new BN(1));

      try {
        await program.methods.redeem(excessiveShares, new BN(0)).accounts({
          user: payer.publicKey, vault: v2Vault, targetTranche: v2JuniorTranche,
          tranche1: v2SeniorTranche, tranche2: null, tranche3: null,
          assetMint: v2Mint, userAssetAccount: v2UserAssetAta, assetVault: v2AssetVault,
          sharesMint: v2JuniorSharesMint, userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        }).rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.contain("InsufficientShares");
      }
    });
  });

  // ======================== Deposit After Wipe ========================

  describe("Deposit After Wipe", () => {
    let v3Mint: PublicKey;
    let v3Vault: PublicKey;
    let v3AssetVault: PublicKey;
    let v3UserAssetAta: PublicKey;
    let v3SeniorTranche: PublicKey;
    let v3JuniorTranche: PublicKey;
    let v3SeniorSharesMint: PublicKey;
    let v3JuniorSharesMint: PublicKey;
    const v3Id = new BN(101);

    before(async () => {
      v3Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [v3Vault] = getVaultPDA(v3Mint, v3Id);
      v3AssetVault = getAssociatedTokenAddressSync(v3Mint, v3Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v3Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v3UserAssetAta = ata.address;
      await mintTo(connection, payer, v3Mint, v3UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v3SeniorTranche] = getTranchePDA(v3Vault, 0);
      [v3JuniorTranche] = getTranchePDA(v3Vault, 1);
      [v3SeniorSharesMint] = getSharesMintPDA(v3Vault, 0);
      [v3JuniorSharesMint] = getSharesMintPDA(v3Vault, 1);

      await program.methods.initialize(v3Id, 0).accounts({
        authority: payer.publicKey, vault: v3Vault, assetMint: v3Mint, assetVault: v3AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      await program.methods.addTranche(0, 0, 500, 10000).accounts({
        authority: payer.publicKey, vault: v3Vault, tranche: v3SeniorTranche, sharesMint: v3SeniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      await program.methods.addTranche(1, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: v3Vault, tranche: v3JuniorTranche, sharesMint: v3JuniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Deposit into junior
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v3JuniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const userSharesAta = getAssociatedTokenAddressSync(
        v3JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      await program.methods.deposit(new BN(1000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v3Vault, targetTranche: v3JuniorTranche,
        tranche1: v3SeniorTranche, tranche2: null, tranche3: null,
        assetMint: v3Mint, userAssetAccount: v3UserAssetAta, assetVault: v3AssetVault,
        sharesMint: v3JuniorSharesMint, userSharesAccount: userSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      // Record total loss to wipe the vault
      const vaultAccount = await program.account.tranchedVault.fetch(v3Vault);
      await program.methods.recordLoss(vaultAccount.totalAssets).accounts({
        manager: payer.publicKey, vault: v3Vault,
        tranche0: v3SeniorTranche, tranche1: v3JuniorTranche, tranche2: null, tranche3: null,
      }).rpc();

      const wipedVault = await program.account.tranchedVault.fetch(v3Vault);
      expect(wipedVault.wiped).to.be.true;
    });

    it("rejects deposit into wiped vault", async () => {
      const userSharesAta = getAssociatedTokenAddressSync(
        v3JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      try {
        await program.methods.deposit(new BN(1000 * LAMPORTS), new BN(0)).accounts({
          user: payer.publicKey, vault: v3Vault, targetTranche: v3JuniorTranche,
          tranche1: v3SeniorTranche, tranche2: null, tranche3: null,
          assetMint: v3Mint, userAssetAccount: v3UserAssetAta, assetVault: v3AssetVault,
          sharesMint: v3JuniorSharesMint, userSharesAccount: userSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        }).rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.contain("VaultWiped");
      }
    });
  });

  // ======================== Subordination Breach on Redeem ========================

  describe("Subordination Breach on Redeem", () => {
    let v4Mint: PublicKey;
    let v4Vault: PublicKey;
    let v4AssetVault: PublicKey;
    let v4UserAssetAta: PublicKey;
    let v4SeniorTranche: PublicKey;
    let v4JuniorTranche: PublicKey;
    let v4SeniorSharesMint: PublicKey;
    let v4JuniorSharesMint: PublicKey;
    const v4Id = new BN(102);

    before(async () => {
      v4Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [v4Vault] = getVaultPDA(v4Mint, v4Id);
      v4AssetVault = getAssociatedTokenAddressSync(v4Mint, v4Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v4Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v4UserAssetAta = ata.address;
      await mintTo(connection, payer, v4Mint, v4UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v4SeniorTranche] = getTranchePDA(v4Vault, 0);
      [v4JuniorTranche] = getTranchePDA(v4Vault, 1);
      [v4SeniorSharesMint] = getSharesMintPDA(v4Vault, 0);
      [v4JuniorSharesMint] = getSharesMintPDA(v4Vault, 1);

      // Senior has 50% subordination requirement — junior must hold >= 50% of total
      await program.methods.initialize(v4Id, 0).accounts({
        authority: payer.publicKey, vault: v4Vault, assetMint: v4Mint, assetVault: v4AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      await program.methods.addTranche(0, 5000, 500, 10000).accounts({
        authority: payer.publicKey, vault: v4Vault, tranche: v4SeniorTranche, sharesMint: v4SeniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      await program.methods.addTranche(1, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: v4Vault, tranche: v4JuniorTranche, sharesMint: v4JuniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Deposit into junior FIRST (no subordination requirement on junior)
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v4JuniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const juniorSharesAta = getAssociatedTokenAddressSync(
        v4JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(500_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v4Vault, targetTranche: v4JuniorTranche,
        tranche1: v4SeniorTranche, tranche2: null, tranche3: null,
        assetMint: v4Mint, userAssetAccount: v4UserAssetAta, assetVault: v4AssetVault,
        sharesMint: v4JuniorSharesMint, userSharesAccount: juniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      // Then deposit into senior (subordination satisfied: junior=500K, total=1M, ratio=50%)
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v4SeniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const seniorSharesAta = getAssociatedTokenAddressSync(
        v4SeniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(500_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v4Vault, targetTranche: v4SeniorTranche,
        tranche1: v4JuniorTranche, tranche2: null, tranche3: null,
        assetMint: v4Mint, userAssetAccount: v4UserAssetAta, assetVault: v4AssetVault,
        sharesMint: v4SeniorSharesMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("rejects junior redeem that would breach senior subordination", async () => {
      const juniorSharesAta = getAssociatedTokenAddressSync(
        v4JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      const sharesAccount = await getAccount(connection, juniorSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
      const allShares = new BN(Number(sharesAccount.amount));

      try {
        await program.methods.redeem(allShares, new BN(0)).accounts({
          user: payer.publicKey, vault: v4Vault, targetTranche: v4JuniorTranche,
          tranche1: v4SeniorTranche, tranche2: null, tranche3: null,
          assetMint: v4Mint, userAssetAccount: v4UserAssetAta, assetVault: v4AssetVault,
          sharesMint: v4JuniorSharesMint, userSharesAccount: juniorSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        }).rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.contain("SubordinationBreach");
      }
    });
  });

  // ======================== Cap Exceeded on Deposit ========================

  describe("Cap Exceeded on Deposit", () => {
    let v5Mint: PublicKey;
    let v5Vault: PublicKey;
    let v5AssetVault: PublicKey;
    let v5UserAssetAta: PublicKey;
    let v5SeniorTranche: PublicKey;
    let v5JuniorTranche: PublicKey;
    let v5SeniorSharesMint: PublicKey;
    let v5JuniorSharesMint: PublicKey;
    const v5Id = new BN(103);

    before(async () => {
      v5Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [v5Vault] = getVaultPDA(v5Mint, v5Id);
      v5AssetVault = getAssociatedTokenAddressSync(v5Mint, v5Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v5Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v5UserAssetAta = ata.address;
      await mintTo(connection, payer, v5Mint, v5UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v5SeniorTranche] = getTranchePDA(v5Vault, 0);
      [v5JuniorTranche] = getTranchePDA(v5Vault, 1);
      [v5SeniorSharesMint] = getSharesMintPDA(v5Vault, 0);
      [v5JuniorSharesMint] = getSharesMintPDA(v5Vault, 1);

      await program.methods.initialize(v5Id, 0).accounts({
        authority: payer.publicKey, vault: v5Vault, assetMint: v5Mint, assetVault: v5AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      // Senior tranche with 10% cap (1000 bps)
      await program.methods.addTranche(0, 0, 500, 1000).accounts({
        authority: payer.publicKey, vault: v5Vault, tranche: v5SeniorTranche, sharesMint: v5SeniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      await program.methods.addTranche(1, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: v5Vault, tranche: v5JuniorTranche, sharesMint: v5JuniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Deposit into junior first to establish total_assets baseline
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v5JuniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const juniorSharesAta = getAssociatedTokenAddressSync(
        v5JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(1_000_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v5Vault, targetTranche: v5JuniorTranche,
        tranche1: v5SeniorTranche, tranche2: null, tranche3: null,
        assetMint: v5Mint, userAssetAccount: v5UserAssetAta, assetVault: v5AssetVault,
        sharesMint: v5JuniorSharesMint, userSharesAccount: juniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      // Deposit into senior up to the cap (10% of total)
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v5SeniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const seniorSharesAta = getAssociatedTokenAddressSync(
        v5SeniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(100_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v5Vault, targetTranche: v5SeniorTranche,
        tranche1: v5JuniorTranche, tranche2: null, tranche3: null,
        assetMint: v5Mint, userAssetAccount: v5UserAssetAta, assetVault: v5AssetVault,
        sharesMint: v5SeniorSharesMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("rejects deposit that exceeds tranche cap", async () => {
      const seniorSharesAta = getAssociatedTokenAddressSync(
        v5SeniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      try {
        await program.methods.deposit(new BN(100_000 * LAMPORTS), new BN(0)).accounts({
          user: payer.publicKey, vault: v5Vault, targetTranche: v5SeniorTranche,
          tranche1: v5JuniorTranche, tranche2: null, tranche3: null,
          assetMint: v5Mint, userAssetAccount: v5UserAssetAta, assetVault: v5AssetVault,
          sharesMint: v5SeniorSharesMint, userSharesAccount: seniorSharesAta,
          assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        }).rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.contain("CapExceeded");
      }
    });
  });

  // ======================== Pro-Rata Yield Distribution ========================

  describe("Pro-Rata Yield Distribution", () => {
    let v6Mint: PublicKey;
    let v6Vault: PublicKey;
    let v6AssetVault: PublicKey;
    let v6UserAssetAta: PublicKey;
    let v6SeniorTranche: PublicKey;
    let v6JuniorTranche: PublicKey;
    let v6SeniorSharesMint: PublicKey;
    let v6JuniorSharesMint: PublicKey;
    const v6Id = new BN(104);

    before(async () => {
      v6Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [v6Vault] = getVaultPDA(v6Mint, v6Id);
      v6AssetVault = getAssociatedTokenAddressSync(v6Mint, v6Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v6Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v6UserAssetAta = ata.address;
      await mintTo(connection, payer, v6Mint, v6UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v6SeniorTranche] = getTranchePDA(v6Vault, 0);
      [v6JuniorTranche] = getTranchePDA(v6Vault, 1);
      [v6SeniorSharesMint] = getSharesMintPDA(v6Vault, 0);
      [v6JuniorSharesMint] = getSharesMintPDA(v6Vault, 1);

      // Initialize with ProRataYieldSequentialLoss (mode=1)
      await program.methods.initialize(v6Id, 1).accounts({
        authority: payer.publicKey, vault: v6Vault, assetMint: v6Mint, assetVault: v6AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      await program.methods.addTranche(0, 0, 500, 10000).accounts({
        authority: payer.publicKey, vault: v6Vault, tranche: v6SeniorTranche, sharesMint: v6SeniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      await program.methods.addTranche(1, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: v6Vault, tranche: v6JuniorTranche, sharesMint: v6JuniorSharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Deposit 600K into senior
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v6SeniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const seniorSharesAta = getAssociatedTokenAddressSync(
        v6SeniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(600_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v6Vault, targetTranche: v6SeniorTranche,
        tranche1: v6JuniorTranche, tranche2: null, tranche3: null,
        assetMint: v6Mint, userAssetAccount: v6UserAssetAta, assetVault: v6AssetVault,
        sharesMint: v6SeniorSharesMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      // Deposit 400K into junior (60/40 split)
      await getOrCreateAssociatedTokenAccount(
        connection, payer, v6JuniorSharesMint, payer.publicKey, false,
        undefined, undefined, TOKEN_2022_PROGRAM_ID
      );
      const juniorSharesAta = getAssociatedTokenAddressSync(
        v6JuniorSharesMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      await program.methods.deposit(new BN(400_000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: v6Vault, targetTranche: v6JuniorTranche,
        tranche1: v6SeniorTranche, tranche2: null, tranche3: null,
        assetMint: v6Mint, userAssetAccount: v6UserAssetAta, assetVault: v6AssetVault,
        sharesMint: v6JuniorSharesMint, userSharesAccount: juniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("distributes yield proportionally to allocation shares", async () => {
      const seniorBefore = await program.account.tranche.fetch(v6SeniorTranche);
      const juniorBefore = await program.account.tranche.fetch(v6JuniorTranche);
      const yieldAmount = new BN(100_000 * LAMPORTS);

      await program.methods.distributeYield(yieldAmount).accounts({
        manager: payer.publicKey, vault: v6Vault, assetMint: v6Mint,
        managerAssetAccount: v6UserAssetAta, assetVault: v6AssetVault,
        tranche0: v6SeniorTranche, tranche1: v6JuniorTranche, tranche2: null, tranche3: null,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(v6SeniorTranche);
      const juniorAfter = await program.account.tranche.fetch(v6JuniorTranche);

      const seniorYield = seniorAfter.totalAssetsAllocated.toNumber() - seniorBefore.totalAssetsAllocated.toNumber();
      const juniorYield = juniorAfter.totalAssetsAllocated.toNumber() - juniorBefore.totalAssetsAllocated.toNumber();
      const totalYield = seniorYield + juniorYield;

      expect(totalYield).to.equal(yieldAmount.toNumber());

      // 60/40 split: senior should get ~60% (60K), junior ~40% (40K)
      // Allow 1 unit rounding tolerance
      const expectedSenior = Math.floor((yieldAmount.toNumber() * 600_000 * LAMPORTS) / (1_000_000 * LAMPORTS));
      expect(seniorYield).to.be.closeTo(expectedSenior, LAMPORTS);
      expect(juniorYield).to.be.closeTo(yieldAmount.toNumber() - expectedSenior, LAMPORTS);
    });
  });
});
