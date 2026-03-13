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
import {
  getTranchedVaultAddress,
  getTrancheAddress,
  getTrancheSharesMintAddress,
} from "../sdk/core/src/tranched-vault-pda";

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

  before(async () => {
    assetMint = await createMint(
      connection, payer, payer.publicKey, null, ASSET_DECIMALS,
      Keypair.generate(), undefined, TOKEN_PROGRAM_ID
    );

    [vault] = getTranchedVaultAddress(program.programId, assetMint, vaultId);

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
    [seniorTranche] = getTrancheAddress(program.programId, vault, 0);
    [juniorTranche] = getTrancheAddress(program.programId, vault, 1);
    [seniorSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 0);
    [juniorSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 1);
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
    const [fakeTranche] = getTrancheAddress(program.programId, vault, 2);
    const [fakeSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 2);

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
    const [fakeTranche] = getTrancheAddress(program.programId, vault, 2);
    const [fakeSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 2);
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
    const [fakeTranche] = getTrancheAddress(program.programId, vault, 2);
    const [fakeSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 2);
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
    const [fakeTranche] = getTrancheAddress(program.programId, vault, 2);
    const [fakeSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 2);
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
    const [fakeTranche] = getTrancheAddress(program.programId, vault, 2);
    const [fakeSharesMint] = getTrancheSharesMintAddress(program.programId, vault, 2);
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
      [v2Vault] = getTranchedVaultAddress(program.programId, v2Mint, v2Id);
      v2AssetVault = getAssociatedTokenAddressSync(v2Mint, v2Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v2Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v2UserAssetAta = ata.address;
      await mintTo(connection, payer, v2Mint, v2UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v2SeniorTranche] = getTrancheAddress(program.programId, v2Vault, 0);
      [v2JuniorTranche] = getTrancheAddress(program.programId, v2Vault, 1);
      [v2SeniorSharesMint] = getTrancheSharesMintAddress(program.programId, v2Vault, 0);
      [v2JuniorSharesMint] = getTrancheSharesMintAddress(program.programId, v2Vault, 1);

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
      [v3Vault] = getTranchedVaultAddress(program.programId, v3Mint, v3Id);
      v3AssetVault = getAssociatedTokenAddressSync(v3Mint, v3Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v3Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v3UserAssetAta = ata.address;
      await mintTo(connection, payer, v3Mint, v3UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v3SeniorTranche] = getTrancheAddress(program.programId, v3Vault, 0);
      [v3JuniorTranche] = getTrancheAddress(program.programId, v3Vault, 1);
      [v3SeniorSharesMint] = getTrancheSharesMintAddress(program.programId, v3Vault, 0);
      [v3JuniorSharesMint] = getTrancheSharesMintAddress(program.programId, v3Vault, 1);

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
      [v4Vault] = getTranchedVaultAddress(program.programId, v4Mint, v4Id);
      v4AssetVault = getAssociatedTokenAddressSync(v4Mint, v4Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v4Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v4UserAssetAta = ata.address;
      await mintTo(connection, payer, v4Mint, v4UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v4SeniorTranche] = getTrancheAddress(program.programId, v4Vault, 0);
      [v4JuniorTranche] = getTrancheAddress(program.programId, v4Vault, 1);
      [v4SeniorSharesMint] = getTrancheSharesMintAddress(program.programId, v4Vault, 0);
      [v4JuniorSharesMint] = getTrancheSharesMintAddress(program.programId, v4Vault, 1);

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
      [v5Vault] = getTranchedVaultAddress(program.programId, v5Mint, v5Id);
      v5AssetVault = getAssociatedTokenAddressSync(v5Mint, v5Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v5Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v5UserAssetAta = ata.address;
      await mintTo(connection, payer, v5Mint, v5UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v5SeniorTranche] = getTrancheAddress(program.programId, v5Vault, 0);
      [v5JuniorTranche] = getTrancheAddress(program.programId, v5Vault, 1);
      [v5SeniorSharesMint] = getTrancheSharesMintAddress(program.programId, v5Vault, 0);
      [v5JuniorSharesMint] = getTrancheSharesMintAddress(program.programId, v5Vault, 1);

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
      [v6Vault] = getTranchedVaultAddress(program.programId, v6Mint, v6Id);
      v6AssetVault = getAssociatedTokenAddressSync(v6Mint, v6Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, v6Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      v6UserAssetAta = ata.address;
      await mintTo(connection, payer, v6Mint, v6UserAssetAta, payer.publicKey, 10_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [v6SeniorTranche] = getTrancheAddress(program.programId, v6Vault, 0);
      [v6JuniorTranche] = getTrancheAddress(program.programId, v6Vault, 1);
      [v6SeniorSharesMint] = getTrancheSharesMintAddress(program.programId, v6Vault, 0);
      [v6JuniorSharesMint] = getTrancheSharesMintAddress(program.programId, v6Vault, 1);

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

  // ======================== Three-Tranche Lifecycle ========================

  describe("Three-Tranche Lifecycle (Senior/Mezz/Junior)", () => {
    let t3Mint: PublicKey;
    let t3Vault: PublicKey;
    let t3AssetVault: PublicKey;
    let t3UserAssetAta: PublicKey;
    let t3Senior: PublicKey;
    let t3Mezz: PublicKey;
    let t3Junior: PublicKey;
    let t3SeniorMint: PublicKey;
    let t3MezzMint: PublicKey;
    let t3JuniorMint: PublicKey;
    const t3Id = new BN(200);

    before(async () => {
      t3Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [t3Vault] = getTranchedVaultAddress(program.programId, t3Mint, t3Id);
      t3AssetVault = getAssociatedTokenAddressSync(t3Mint, t3Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, t3Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      t3UserAssetAta = ata.address;
      await mintTo(connection, payer, t3Mint, t3UserAssetAta, payer.publicKey, 50_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [t3Senior] = getTrancheAddress(program.programId, t3Vault, 0);
      [t3Mezz] = getTrancheAddress(program.programId, t3Vault, 1);
      [t3Junior] = getTrancheAddress(program.programId, t3Vault, 2);
      [t3SeniorMint] = getTrancheSharesMintAddress(program.programId, t3Vault, 0);
      [t3MezzMint] = getTrancheSharesMintAddress(program.programId, t3Vault, 1);
      [t3JuniorMint] = getTrancheSharesMintAddress(program.programId, t3Vault, 2);

      // Initialize with sequential waterfall
      await program.methods.initialize(t3Id, 0).accounts({
        authority: payer.publicKey, vault: t3Vault, assetMint: t3Mint, assetVault: t3AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      // Senior: priority=0, sub=30%, yield=3%, cap=60%
      await program.methods.addTranche(0, 3000, 300, 6000).accounts({
        authority: payer.publicKey, vault: t3Vault, tranche: t3Senior, sharesMint: t3SeniorMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Mezz: priority=1, sub=10%, yield=6%, cap=8000
      await program.methods.addTranche(1, 1000, 600, 8000).accounts({
        authority: payer.publicKey, vault: t3Vault, tranche: t3Mezz, sharesMint: t3MezzMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Junior: priority=2, sub=0, yield=0 (equity), cap=100%
      await program.methods.addTranche(2, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: t3Vault, tranche: t3Junior, sharesMint: t3JuniorMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Create share ATAs for all tranches
      for (const mint of [t3SeniorMint, t3MezzMint, t3JuniorMint]) {
        await getOrCreateAssociatedTokenAccount(
          connection, payer, mint, payer.publicKey, false,
          undefined, undefined, TOKEN_2022_PROGRAM_ID
        );
      }

      // Deposit: junior first (2000), then mezz (3000), then senior (5000)
      // Total = 10000, junior=20%, mezz=30%, senior=50%
      const juniorSharesAta = getAssociatedTokenAddressSync(t3JuniorMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(2000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t3Vault, targetTranche: t3Junior,
        tranche1: t3Senior, tranche2: t3Mezz, tranche3: null,
        assetMint: t3Mint, userAssetAccount: t3UserAssetAta, assetVault: t3AssetVault,
        sharesMint: t3JuniorMint, userSharesAccount: juniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const mezzSharesAta = getAssociatedTokenAddressSync(t3MezzMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(3000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t3Vault, targetTranche: t3Mezz,
        tranche1: t3Senior, tranche2: t3Junior, tranche3: null,
        assetMint: t3Mint, userAssetAccount: t3UserAssetAta, assetVault: t3AssetVault,
        sharesMint: t3MezzMint, userSharesAccount: mezzSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const seniorSharesAta = getAssociatedTokenAddressSync(t3SeniorMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(5000 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t3Vault, targetTranche: t3Senior,
        tranche1: t3Mezz, tranche2: t3Junior, tranche3: null,
        assetMint: t3Mint, userAssetAccount: t3UserAssetAta, assetVault: t3AssetVault,
        sharesMint: t3SeniorMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("has correct 3-tranche state after deposits", async () => {
      const vaultState = await program.account.tranchedVault.fetch(t3Vault);
      expect(vaultState.numTranches).to.equal(3);
      expect(vaultState.totalAssets.toNumber()).to.equal(10000 * LAMPORTS);

      const senior = await program.account.tranche.fetch(t3Senior);
      const mezz = await program.account.tranche.fetch(t3Mezz);
      const junior = await program.account.tranche.fetch(t3Junior);

      expect(senior.totalAssetsAllocated.toNumber()).to.equal(5000 * LAMPORTS);
      expect(mezz.totalAssetsAllocated.toNumber()).to.equal(3000 * LAMPORTS);
      expect(junior.totalAssetsAllocated.toNumber()).to.equal(2000 * LAMPORTS);

      // Verify total_assets invariant
      const sum = senior.totalAssetsAllocated.add(mezz.totalAssetsAllocated).add(junior.totalAssetsAllocated);
      expect(sum.toNumber()).to.equal(vaultState.totalAssets.toNumber());
    });

    it("distributes sequential yield across 3 tranches", async () => {
      // Yield=1000. Senior target=3% of 5000=150. Mezz target=6% of 3000=180. Junior=equity.
      // Expected: senior=150, mezz=180, junior=670
      const yieldAmount = new BN(1000 * LAMPORTS);

      const seniorBefore = await program.account.tranche.fetch(t3Senior);
      const mezzBefore = await program.account.tranche.fetch(t3Mezz);
      const juniorBefore = await program.account.tranche.fetch(t3Junior);

      await program.methods.distributeYield(yieldAmount).accounts({
        manager: payer.publicKey, vault: t3Vault, assetMint: t3Mint,
        managerAssetAccount: t3UserAssetAta, assetVault: t3AssetVault,
        tranche0: t3Senior, tranche1: t3Mezz, tranche2: t3Junior, tranche3: null,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(t3Senior);
      const mezzAfter = await program.account.tranche.fetch(t3Mezz);
      const juniorAfter = await program.account.tranche.fetch(t3Junior);

      const seniorYield = seniorAfter.totalAssetsAllocated.toNumber() - seniorBefore.totalAssetsAllocated.toNumber();
      const mezzYield = mezzAfter.totalAssetsAllocated.toNumber() - mezzBefore.totalAssetsAllocated.toNumber();
      const juniorYield = juniorAfter.totalAssetsAllocated.toNumber() - juniorBefore.totalAssetsAllocated.toNumber();

      // Senior entitled: floor(5000 * 300 / 10000) = 150
      expect(seniorYield).to.equal(150 * LAMPORTS);
      // Mezz entitled: floor(3000 * 600 / 10000) = 180
      expect(mezzYield).to.equal(180 * LAMPORTS);
      // Junior gets residual: 1000 - 150 - 180 = 670
      expect(juniorYield).to.equal(670 * LAMPORTS);
      // Total yield invariant
      expect(seniorYield + mezzYield + juniorYield).to.equal(yieldAmount.toNumber());
    });

    it("absorbs loss bottom-up across 3 tranches (spills to mezz)", async () => {
      // Loss=2500. Junior has ~2670, mezz has ~3180.
      // Junior absorbs min(2500, ~2670) → full 2500 absorbed by junior.
      // Actually let's record a loss that spills: 3000 to hit both junior and mezz.
      const juniorBefore = await program.account.tranche.fetch(t3Junior);
      const lossAmount = juniorBefore.totalAssetsAllocated.add(new BN(500 * LAMPORTS)); // wipe junior + 500 into mezz

      const mezzBefore = await program.account.tranche.fetch(t3Mezz);
      const seniorBefore = await program.account.tranche.fetch(t3Senior);

      await program.methods.recordLoss(lossAmount).accounts({
        manager: payer.publicKey, vault: t3Vault,
        tranche0: t3Senior, tranche1: t3Mezz, tranche2: t3Junior, tranche3: null,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(t3Senior);
      const mezzAfter = await program.account.tranche.fetch(t3Mezz);
      const juniorAfter = await program.account.tranche.fetch(t3Junior);

      // Junior should be wiped
      expect(juniorAfter.totalAssetsAllocated.toNumber()).to.equal(0);
      // Mezz absorbs 500
      expect(mezzAfter.totalAssetsAllocated.toNumber()).to.equal(
        mezzBefore.totalAssetsAllocated.toNumber() - 500 * LAMPORTS
      );
      // Senior untouched
      expect(seniorAfter.totalAssetsAllocated.toNumber()).to.equal(seniorBefore.totalAssetsAllocated.toNumber());

      // Verify total_assets invariant
      const vaultState = await program.account.tranchedVault.fetch(t3Vault);
      const sum = seniorAfter.totalAssetsAllocated.add(mezzAfter.totalAssetsAllocated).add(juniorAfter.totalAssetsAllocated);
      expect(sum.toNumber()).to.equal(vaultState.totalAssets.toNumber());
    });

    it("rebalances from mezz to junior to restore subordination after loss", async () => {
      // After loss, mezz subordination (10%) is breached because junior=0.
      // A small rebalance (200) would still breach — we need enough to restore the ratio.
      // Required junior for mezz sub: ceil(total * 1000 / 10000)
      const vaultState = await program.account.tranchedVault.fetch(t3Vault);
      const requiredJunior = Math.ceil(vaultState.totalAssets.toNumber() * 1000 / 10000);
      const rebalanceAmount = new BN(requiredJunior);

      const mezzBefore = await program.account.tranche.fetch(t3Mezz);
      const juniorBefore = await program.account.tranche.fetch(t3Junior);

      await program.methods.rebalanceTranches(rebalanceAmount).accounts({
        manager: payer.publicKey, vault: t3Vault,
        fromTranche: t3Mezz, toTranche: t3Junior,
        otherTranche0: t3Senior, otherTranche1: null,
      }).rpc();

      const mezzAfter = await program.account.tranche.fetch(t3Mezz);
      const juniorAfter = await program.account.tranche.fetch(t3Junior);

      expect(mezzAfter.totalAssetsAllocated.toNumber()).to.equal(
        mezzBefore.totalAssetsAllocated.toNumber() - rebalanceAmount.toNumber()
      );
      expect(juniorAfter.totalAssetsAllocated.toNumber()).to.equal(
        juniorBefore.totalAssetsAllocated.toNumber() + rebalanceAmount.toNumber()
      );
    });
  });

  // ======================== Four-Tranche Lifecycle ========================

  describe("Four-Tranche Lifecycle (Senior/SeniorMezz/JuniorMezz/Equity)", () => {
    let t4Mint: PublicKey;
    let t4Vault: PublicKey;
    let t4AssetVault: PublicKey;
    let t4UserAssetAta: PublicKey;
    let t4Senior: PublicKey;
    let t4SeniorMezz: PublicKey;
    let t4JuniorMezz: PublicKey;
    let t4Equity: PublicKey;
    let t4SeniorMint: PublicKey;
    let t4SeniorMezzMint: PublicKey;
    let t4JuniorMezzMint: PublicKey;
    let t4EquityMint: PublicKey;
    const t4Id = new BN(300);

    before(async () => {
      t4Mint = await createMint(
        connection, payer, payer.publicKey, null, ASSET_DECIMALS,
        Keypair.generate(), undefined, TOKEN_PROGRAM_ID
      );
      [t4Vault] = getTranchedVaultAddress(program.programId, t4Mint, t4Id);
      t4AssetVault = getAssociatedTokenAddressSync(t4Mint, t4Vault, true, TOKEN_PROGRAM_ID);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection, payer, t4Mint, payer.publicKey, false,
        undefined, undefined, TOKEN_PROGRAM_ID
      );
      t4UserAssetAta = ata.address;
      await mintTo(connection, payer, t4Mint, t4UserAssetAta, payer.publicKey, 100_000_000 * LAMPORTS, [], undefined, TOKEN_PROGRAM_ID);

      [t4Senior] = getTrancheAddress(program.programId, t4Vault, 0);
      [t4SeniorMezz] = getTrancheAddress(program.programId, t4Vault, 1);
      [t4JuniorMezz] = getTrancheAddress(program.programId, t4Vault, 2);
      [t4Equity] = getTrancheAddress(program.programId, t4Vault, 3);
      [t4SeniorMint] = getTrancheSharesMintAddress(program.programId, t4Vault, 0);
      [t4SeniorMezzMint] = getTrancheSharesMintAddress(program.programId, t4Vault, 1);
      [t4JuniorMezzMint] = getTrancheSharesMintAddress(program.programId, t4Vault, 2);
      [t4EquityMint] = getTrancheSharesMintAddress(program.programId, t4Vault, 3);

      // Initialize with sequential waterfall
      await program.methods.initialize(t4Id, 0).accounts({
        authority: payer.publicKey, vault: t4Vault, assetMint: t4Mint, assetVault: t4AssetVault,
        assetTokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

      // Senior: priority=0, sub=40%, yield=2%, cap=50%
      await program.methods.addTranche(0, 4000, 200, 5000).accounts({
        authority: payer.publicKey, vault: t4Vault, tranche: t4Senior, sharesMint: t4SeniorMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Senior Mezz: priority=1, sub=20%, yield=4%, cap=70%
      await program.methods.addTranche(1, 2000, 400, 7000).accounts({
        authority: payer.publicKey, vault: t4Vault, tranche: t4SeniorMezz, sharesMint: t4SeniorMezzMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Junior Mezz: priority=2, sub=10%, yield=8%, cap=80%
      await program.methods.addTranche(2, 1000, 800, 8000).accounts({
        authority: payer.publicKey, vault: t4Vault, tranche: t4JuniorMezz, sharesMint: t4JuniorMezzMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Equity: priority=3, sub=0, yield=0 (residual), cap=100%
      await program.methods.addTranche(3, 0, 0, 10000).accounts({
        authority: payer.publicKey, vault: t4Vault, tranche: t4Equity, sharesMint: t4EquityMint,
        token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc();

      // Create share ATAs for all 4 tranches
      for (const mint of [t4SeniorMint, t4SeniorMezzMint, t4JuniorMezzMint, t4EquityMint]) {
        await getOrCreateAssociatedTokenAccount(
          connection, payer, mint, payer.publicKey, false,
          undefined, undefined, TOKEN_2022_PROGRAM_ID
        );
      }

      // Deposit into all tranches: equity first, then upward
      // Total = 10000, equity=1500(15%), jrMezz=1500(15%), srMezz=2500(25%), senior=4500(45%)
      const equitySharesAta = getAssociatedTokenAddressSync(t4EquityMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(1500 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t4Vault, targetTranche: t4Equity,
        tranche1: t4Senior, tranche2: t4SeniorMezz, tranche3: t4JuniorMezz,
        assetMint: t4Mint, userAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        sharesMint: t4EquityMint, userSharesAccount: equitySharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const jrMezzSharesAta = getAssociatedTokenAddressSync(t4JuniorMezzMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(1500 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t4Vault, targetTranche: t4JuniorMezz,
        tranche1: t4Senior, tranche2: t4SeniorMezz, tranche3: t4Equity,
        assetMint: t4Mint, userAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        sharesMint: t4JuniorMezzMint, userSharesAccount: jrMezzSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const srMezzSharesAta = getAssociatedTokenAddressSync(t4SeniorMezzMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(2500 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t4Vault, targetTranche: t4SeniorMezz,
        tranche1: t4Senior, tranche2: t4JuniorMezz, tranche3: t4Equity,
        assetMint: t4Mint, userAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        sharesMint: t4SeniorMezzMint, userSharesAccount: srMezzSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const seniorSharesAta = getAssociatedTokenAddressSync(t4SeniorMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await program.methods.deposit(new BN(4500 * LAMPORTS), new BN(0)).accounts({
        user: payer.publicKey, vault: t4Vault, targetTranche: t4Senior,
        tranche1: t4SeniorMezz, tranche2: t4JuniorMezz, tranche3: t4Equity,
        assetMint: t4Mint, userAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        sharesMint: t4SeniorMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();
    });

    it("has correct 4-tranche state after deposits", async () => {
      const vaultState = await program.account.tranchedVault.fetch(t4Vault);
      expect(vaultState.numTranches).to.equal(4);
      expect(vaultState.totalAssets.toNumber()).to.equal(10000 * LAMPORTS);
      // Priority bitmap should have bits 0,1,2,3 set = 0b1111 = 15
      expect(vaultState.priorityBitmap).to.equal(15);

      const senior = await program.account.tranche.fetch(t4Senior);
      const srMezz = await program.account.tranche.fetch(t4SeniorMezz);
      const jrMezz = await program.account.tranche.fetch(t4JuniorMezz);
      const equity = await program.account.tranche.fetch(t4Equity);

      expect(senior.totalAssetsAllocated.toNumber()).to.equal(4500 * LAMPORTS);
      expect(srMezz.totalAssetsAllocated.toNumber()).to.equal(2500 * LAMPORTS);
      expect(jrMezz.totalAssetsAllocated.toNumber()).to.equal(1500 * LAMPORTS);
      expect(equity.totalAssetsAllocated.toNumber()).to.equal(1500 * LAMPORTS);

      // Verify total_assets invariant
      const sum = senior.totalAssetsAllocated
        .add(srMezz.totalAssetsAllocated)
        .add(jrMezz.totalAssetsAllocated)
        .add(equity.totalAssetsAllocated);
      expect(sum.toNumber()).to.equal(vaultState.totalAssets.toNumber());
    });

    it("rejects adding a 5th tranche (max 4)", async () => {
      const [fifthTranche] = getTrancheAddress(program.programId, t4Vault, 4);
      const [fifthMint] = getTrancheSharesMintAddress(program.programId, t4Vault, 4);

      try {
        await program.methods.addTranche(4, 0, 0, 10000).accounts({
          authority: payer.publicKey, vault: t4Vault, tranche: fifthTranche, sharesMint: fifthMint,
          token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.error?.errorCode?.code || e.message).to.contain("MaxTranchesReached");
      }
    });

    it("distributes sequential yield across 4 tranches", async () => {
      // Yield=2000.
      // Senior: 2% of 4500 = 90. SrMezz: 4% of 2500 = 100. JrMezz: 8% of 1500 = 120. Equity: residual.
      // Expected: senior=90, srMezz=100, jrMezz=120, equity=1690
      const yieldAmount = new BN(2000 * LAMPORTS);

      const seniorBefore = await program.account.tranche.fetch(t4Senior);
      const srMezzBefore = await program.account.tranche.fetch(t4SeniorMezz);
      const jrMezzBefore = await program.account.tranche.fetch(t4JuniorMezz);
      const equityBefore = await program.account.tranche.fetch(t4Equity);

      await program.methods.distributeYield(yieldAmount).accounts({
        manager: payer.publicKey, vault: t4Vault, assetMint: t4Mint,
        managerAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        tranche0: t4Senior, tranche1: t4SeniorMezz, tranche2: t4JuniorMezz, tranche3: t4Equity,
        assetTokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(t4Senior);
      const srMezzAfter = await program.account.tranche.fetch(t4SeniorMezz);
      const jrMezzAfter = await program.account.tranche.fetch(t4JuniorMezz);
      const equityAfter = await program.account.tranche.fetch(t4Equity);

      const seniorYield = seniorAfter.totalAssetsAllocated.toNumber() - seniorBefore.totalAssetsAllocated.toNumber();
      const srMezzYield = srMezzAfter.totalAssetsAllocated.toNumber() - srMezzBefore.totalAssetsAllocated.toNumber();
      const jrMezzYield = jrMezzAfter.totalAssetsAllocated.toNumber() - jrMezzBefore.totalAssetsAllocated.toNumber();
      const equityYield = equityAfter.totalAssetsAllocated.toNumber() - equityBefore.totalAssetsAllocated.toNumber();

      // Senior: floor(4500 * 200 / 10000) = 90
      expect(seniorYield).to.equal(90 * LAMPORTS);
      // SrMezz: floor(2500 * 400 / 10000) = 100
      expect(srMezzYield).to.equal(100 * LAMPORTS);
      // JrMezz: floor(1500 * 800 / 10000) = 120
      expect(jrMezzYield).to.equal(120 * LAMPORTS);
      // Equity: 2000 - 90 - 100 - 120 = 1690
      expect(equityYield).to.equal(1690 * LAMPORTS);
      // Total invariant
      expect(seniorYield + srMezzYield + jrMezzYield + equityYield).to.equal(yieldAmount.toNumber());
    });

    it("absorbs loss bottom-up across 4 tranches (contained in equity)", async () => {
      // Use a loss small enough to be absorbed by equity only, keeping subordination intact.
      // This allows subsequent redeem tests to work without needing recovery deposits.
      const equityBefore = await program.account.tranche.fetch(t4Equity);
      const seniorBefore = await program.account.tranche.fetch(t4Senior);
      const srMezzBefore = await program.account.tranche.fetch(t4SeniorMezz);
      const jrMezzBefore = await program.account.tranche.fetch(t4JuniorMezz);

      // Loss of 1000 — equity has ~3190, so this is easily absorbed
      const lossAmount = new BN(1000 * LAMPORTS);

      await program.methods.recordLoss(lossAmount).accounts({
        manager: payer.publicKey, vault: t4Vault,
        tranche0: t4Senior, tranche1: t4SeniorMezz, tranche2: t4JuniorMezz, tranche3: t4Equity,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(t4Senior);
      const srMezzAfter = await program.account.tranche.fetch(t4SeniorMezz);
      const jrMezzAfter = await program.account.tranche.fetch(t4JuniorMezz);
      const equityAfter = await program.account.tranche.fetch(t4Equity);

      // Equity absorbed all loss
      expect(equityAfter.totalAssetsAllocated.toNumber()).to.equal(
        equityBefore.totalAssetsAllocated.toNumber() - lossAmount.toNumber()
      );
      // All other tranches untouched
      expect(seniorAfter.totalAssetsAllocated.toNumber()).to.equal(seniorBefore.totalAssetsAllocated.toNumber());
      expect(srMezzAfter.totalAssetsAllocated.toNumber()).to.equal(srMezzBefore.totalAssetsAllocated.toNumber());
      expect(jrMezzAfter.totalAssetsAllocated.toNumber()).to.equal(jrMezzBefore.totalAssetsAllocated.toNumber());

      // Verify total_assets invariant
      const vaultState = await program.account.tranchedVault.fetch(t4Vault);
      const sum = seniorAfter.totalAssetsAllocated
        .add(srMezzAfter.totalAssetsAllocated)
        .add(jrMezzAfter.totalAssetsAllocated)
        .add(equityAfter.totalAssetsAllocated);
      expect(sum.toNumber()).to.equal(vaultState.totalAssets.toNumber());
    });

    it("redeems from senior in 4-tranche vault", async () => {
      const seniorBefore = await program.account.tranche.fetch(t4Senior);
      const vaultBefore = await program.account.tranchedVault.fetch(t4Vault);
      const redeemShares = new BN(10 * LAMPORTS * 1000); // small redeem (shares at 9 decimals)

      const seniorSharesAta = getAssociatedTokenAddressSync(t4SeniorMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

      await program.methods.redeem(redeemShares, new BN(0)).accounts({
        user: payer.publicKey, vault: t4Vault, targetTranche: t4Senior,
        tranche1: t4SeniorMezz, tranche2: t4JuniorMezz, tranche3: t4Equity,
        assetMint: t4Mint, userAssetAccount: t4UserAssetAta, assetVault: t4AssetVault,
        sharesMint: t4SeniorMint, userSharesAccount: seniorSharesAta,
        assetTokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).rpc();

      const seniorAfter = await program.account.tranche.fetch(t4Senior);
      const vaultAfter = await program.account.tranchedVault.fetch(t4Vault);

      // Senior allocation decreased
      expect(seniorAfter.totalAssetsAllocated.toNumber()).to.be.lessThan(
        seniorBefore.totalAssetsAllocated.toNumber()
      );
      // Vault total decreased by same amount
      const assetsDelta = seniorBefore.totalAssetsAllocated.toNumber() - seniorAfter.totalAssetsAllocated.toNumber();
      expect(vaultBefore.totalAssets.toNumber() - vaultAfter.totalAssets.toNumber()).to.equal(assetsDelta);
    });
  });
});
