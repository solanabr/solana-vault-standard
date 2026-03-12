import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { getTokenProgramForMint } from "./vault";
import {
  getTranchedVaultAddress,
  getTrancheAddress,
  getTrancheSharesMintAddress,
} from "./tranched-vault-pda";

export interface TranchedVaultState {
  authority: PublicKey;
  manager: PublicKey;
  assetMint: PublicKey;
  assetVault: PublicKey;
  totalAssets: BN;
  numTranches: number;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  wiped: boolean;
  priorityBitmap: number;
  vaultId: BN;
  waterfallMode: { sequential: {} } | { proRataYieldSequentialLoss: {} };
}

export interface TrancheState {
  vault: PublicKey;
  sharesMint: PublicKey;
  sharesMintBump: number;
  totalShares: BN;
  totalAssetsAllocated: BN;
  priority: number;
  subordinationBps: number;
  targetYieldBps: number;
  capBps: number;
  index: number;
  bump: number;
}

export interface CreateTranchedVaultParams {
  assetMint: PublicKey;
  vaultId: BN | number;
  waterfallMode: number;
}

export interface AddTrancheParams {
  priority: number;
  subordinationBps: number;
  targetYieldBps: number;
  capBps: number;
}

export interface TranchedDepositParams {
  assets: BN;
  minSharesOut: BN;
}

export interface TranchedRedeemParams {
  shares: BN;
  minAssetsOut: BN;
}

export class TranchedVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly assetMint: PublicKey;
  readonly assetVault: PublicKey;
  readonly vaultId: BN;
  readonly assetTokenProgram: PublicKey;

  private _state: TranchedVaultState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    assetMint: PublicKey,
    assetVault: PublicKey,
    vaultId: BN,
    assetTokenProgram: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.assetMint = assetMint;
    this.assetVault = assetVault;
    this.vaultId = vaultId;
    this.assetTokenProgram = assetTokenProgram;
  }

  static async create(
    program: Program,
    params: CreateTranchedVaultParams,
  ): Promise<TranchedVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;

    const [vault] = getTranchedVaultAddress(
      program.programId,
      params.assetMint,
      id,
    );

    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      params.assetMint,
    );

    const assetVault = getAssociatedTokenAddressSync(
      params.assetMint,
      vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(id, params.waterfallMode)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault,
        assetMint: params.assetMint,
        assetVault,
        assetTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return TranchedVault.load(program, params.assetMint, id);
  }

  static async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<TranchedVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;

    const [vault] = getTranchedVaultAddress(program.programId, assetMint, id);

    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      assetMint,
    );

    const assetVault = getAssociatedTokenAddressSync(
      assetMint,
      vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const instance = new TranchedVault(
      program,
      provider,
      vault,
      assetMint,
      assetVault,
      id,
      assetTokenProgram,
    );

    await instance.refresh();
    return instance;
  }

  // ============ State ============

  async refresh(): Promise<TranchedVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["tranchedVault"].fetch(
      this.vault,
    )) as TranchedVaultState;
    return this._state;
  }

  async getState(): Promise<TranchedVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  async getTrancheState(index: number): Promise<TrancheState> {
    const [tranchePda] = getTrancheAddress(
      this.program.programId,
      this.vault,
      index,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["tranche"].fetch(tranchePda)) as TrancheState;
  }

  // ============ Tranche Management ============

  async addTranche(authority: PublicKey, params: AddTrancheParams): Promise<string> {
    const state = await this.refresh();
    const index = state.numTranches;

    const [tranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      index,
    );
    const [sharesMint] = getTrancheSharesMintAddress(
      this.program.programId,
      this.vault,
      index,
    );

    return this.program.methods
      .addTranche(
        params.priority,
        params.subordinationBps,
        params.targetYieldBps,
        params.capBps,
      )
      .accountsStrict({
        authority,
        vault: this.vault,
        tranche,
        sharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  }

  // ============ Core Operations ============

  async deposit(
    user: PublicKey,
    trancheIndex: number,
    params: TranchedDepositParams,
  ): Promise<string> {
    const state = await this.refresh();
    const [targetTranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      trancheIndex,
    );
    const trancheState = await this.getTrancheState(trancheIndex);

    const userAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      user,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      trancheState.sharesMint,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const others = this._collectOtherTranches(state.numTranches, trancheIndex);

    return this.program.methods
      .deposit(params.assets, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        targetTranche,
        tranche1: others[0],
        tranche2: others[1],
        tranche3: others[2],
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: trancheState.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async redeem(
    user: PublicKey,
    trancheIndex: number,
    params: TranchedRedeemParams,
  ): Promise<string> {
    const state = await this.refresh();
    const [targetTranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      trancheIndex,
    );
    const trancheState = await this.getTrancheState(trancheIndex);

    const userAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      user,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      trancheState.sharesMint,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const others = this._collectOtherTranches(state.numTranches, trancheIndex);

    return this.program.methods
      .redeem(params.shares, params.minAssetsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        targetTranche,
        tranche1: others[0],
        tranche2: others[1],
        tranche3: others[2],
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: trancheState.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  // ============ Manager Operations ============

  async distributeYield(
    manager: PublicKey,
    totalYield: BN,
  ): Promise<string> {
    const state = await this.refresh();

    const managerAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      manager,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const allTranches = this._collectAllTranches(state.numTranches);

    return this.program.methods
      .distributeYield(totalYield)
      .accountsStrict({
        manager,
        vault: this.vault,
        assetMint: this.assetMint,
        managerAssetAccount,
        assetVault: this.assetVault,
        tranche0: allTranches[0],
        tranche1: allTranches[1],
        tranche2: allTranches[2],
        tranche3: allTranches[3],
        assetTokenProgram: this.assetTokenProgram,
      })
      .rpc();
  }

  async recordLoss(manager: PublicKey, totalLoss: BN): Promise<string> {
    const state = await this.refresh();

    const allTranches = this._collectAllTranches(state.numTranches);

    return this.program.methods
      .recordLoss(totalLoss)
      .accountsStrict({
        manager,
        vault: this.vault,
        tranche0: allTranches[0],
        tranche1: allTranches[1],
        tranche2: allTranches[2],
        tranche3: allTranches[3],
      })
      .rpc();
  }

  async rebalance(
    manager: PublicKey,
    fromIndex: number,
    toIndex: number,
    amount: BN,
  ): Promise<string> {
    const state = await this.refresh();
    const [fromTranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      fromIndex,
    );
    const [toTranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      toIndex,
    );

    const excludeSet = new Set([fromIndex, toIndex]);
    const otherTranches: (PublicKey | null)[] = [null, null];
    let slot = 0;
    for (let i = 0; i < state.numTranches; i++) {
      if (!excludeSet.has(i)) {
        const [pda] = getTrancheAddress(this.program.programId, this.vault, i);
        otherTranches[slot++] = pda;
      }
    }

    return this.program.methods
      .rebalanceTranches(amount)
      .accountsStrict({
        manager,
        vault: this.vault,
        fromTranche,
        toTranche,
        otherTranche0: otherTranches[0],
        otherTranche1: otherTranches[1],
      })
      .rpc();
  }

  // ============ Admin ============

  async pause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .pause()
      .accountsStrict({ authority, vault: this.vault })
      .rpc();
  }

  async unpause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsStrict({ authority, vault: this.vault })
      .rpc();
  }

  async transferAuthority(
    authority: PublicKey,
    newAuthority: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .transferAuthority(newAuthority)
      .accountsStrict({ authority, vault: this.vault })
      .rpc();
  }

  async setManager(authority: PublicKey, newManager: PublicKey): Promise<string> {
    return this.program.methods
      .setManager(newManager)
      .accountsStrict({ authority, vault: this.vault })
      .rpc();
  }

  async updateTrancheConfig(
    authority: PublicKey,
    trancheIndex: number,
    config: {
      targetYieldBps?: number;
      capBps?: number;
      subordinationBps?: number;
    },
  ): Promise<string> {
    const state = await this.refresh();
    const [targetTranche] = getTrancheAddress(
      this.program.programId,
      this.vault,
      trancheIndex,
    );

    const others = this._collectOtherTranches(state.numTranches, trancheIndex);

    return this.program.methods
      .updateTrancheConfig(
        config.targetYieldBps ?? null,
        config.capBps ?? null,
        config.subordinationBps ?? null,
      )
      .accountsStrict({
        authority,
        vault: this.vault,
        targetTranche,
        tranche1: others[0],
        tranche2: others[1],
        tranche3: others[2],
      })
      .rpc();
  }

  // ============ View Helpers ============

  getTrancheAddress(index: number): PublicKey {
    const [pda] = getTrancheAddress(this.program.programId, this.vault, index);
    return pda;
  }

  getTrancheSharesMint(index: number): PublicKey {
    const [pda] = getTrancheSharesMintAddress(
      this.program.programId,
      this.vault,
      index,
    );
    return pda;
  }

  getUserSharesAccount(owner: PublicKey, sharesMint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getUserAssetAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.assetMint,
      owner,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // ============ Internal Helpers ============

  private _collectOtherTranches(
    numTranches: number,
    excludeIndex: number,
  ): (PublicKey | null)[] {
    const result: (PublicKey | null)[] = [null, null, null];
    let slot = 0;
    for (let i = 0; i < numTranches; i++) {
      if (i !== excludeIndex) {
        const [pda] = getTrancheAddress(this.program.programId, this.vault, i);
        result[slot++] = pda;
      }
    }
    return result;
  }

  private _collectAllTranches(numTranches: number): (PublicKey | null)[] {
    const result: (PublicKey | null)[] = [null, null, null, null];
    for (let i = 0; i < numTranches; i++) {
      const [pda] = getTrancheAddress(this.program.programId, this.vault, i);
      result[i] = pda;
    }
    return result;
  }
}
