/**
 * SVS-9 Allocator Vault SDK
 *
 * TypeScript client for the SVS-9 (Allocator) on-chain program.
 * Wraps all instruction calls, PDA derivations, and account resolution
 * so front-end developers only need to pass business-level parameters.
 *
 * @example
 * ```ts
 * import { AllocatorVaultClient } from "@stbr/solana-vault";
 *
 * // Load existing allocator vault
 * const client = await AllocatorVaultClient.load(program, assetMint, 1);
 *
 * // Deposit with slippage protection
 * const tx = await client.deposit({
 *   assets: new BN(1_000_000),
 *   minSharesOut: new BN(950_000),
 *   callerAssetAccount: userTokenAccount,
 *   ownerSharesAccount: userSharesAccount,
 *   owner: userPubkey,
 * });
 *
 * // Add a child vault
 * await client.addChild({
 *   maxWeightBps: 5000,
 *   childVault: childVaultPubkey,
 *   childProgram: childProgramId,
 * });
 * ```
 *
 * @packageDocumentation
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";

// ============================================================
// Constants — must match the Rust program seeds
// ============================================================

export const ALLOCATOR_VAULT_SEED = Buffer.from("allocator_vault");
export const CHILD_ALLOCATION_SEED = Buffer.from("child_allocation");

// ============================================================
// PDA Helpers
// ============================================================

/**
 * Derive the AllocatorVault PDA address.
 * Seeds: ["allocator_vault", asset_mint, vault_id (u64 LE)]
 */
export function getAllocatorVaultAddress(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [
      ALLOCATOR_VAULT_SEED,
      assetMint.toBuffer(),
      id.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

/**
 * Derive the ChildAllocation PDA address.
 * Seeds: ["child_allocation", allocator_vault, child_vault]
 */
export function getChildAllocationAddress(
  programId: PublicKey,
  allocatorVault: PublicKey,
  childVault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      CHILD_ALLOCATION_SEED,
      allocatorVault.toBuffer(),
      childVault.toBuffer(),
    ],
    programId,
  );
}

/**
 * Derive the idle vault ATA (owned by the allocator vault PDA).
 */
export function getIdleVaultAddress(
  allocatorVault: PublicKey,
  assetMint: PublicKey,
  assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(
    assetMint,
    allocatorVault,
    true, // allowOwnerOffCurve (PDA)
    assetTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Derive the ATA for the allocator vault's shares in a child vault.
 */
export function getAllocatorChildSharesAddress(
  allocatorVault: PublicKey,
  childSharesMint: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(
    childSharesMint,
    allocatorVault,
    true, // allowOwnerOffCurve (PDA)
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Convenience: derive all core addresses from minimal inputs.
 */
export function deriveAllocatorAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN | number,
  assetTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
) {
  const [allocatorVault, allocatorBump] = getAllocatorVaultAddress(
    programId,
    assetMint,
    vaultId,
  );
  const idleVault = getIdleVaultAddress(
    allocatorVault,
    assetMint,
    assetTokenProgram,
  );
  return { allocatorVault, allocatorBump, idleVault };
}

// ============================================================
// State Interfaces
// ============================================================

export interface AllocatorVaultState {
  authority: PublicKey;
  curator: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  idleVault: PublicKey;
  totalShares: BN;
  numChildren: number;
  idleBufferBps: number;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
}

export interface ChildAllocationState {
  allocatorVault: PublicKey;
  childVault: PublicKey;
  childProgram: PublicKey;
  childSharesAccount: PublicKey;
  targetWeightBps: number;
  maxWeightBps: number;
  depositedAssets: BN;
  index: number;
  enabled: boolean;
  bump: number;
}

// ============================================================
// Instruction Parameter Interfaces
// ============================================================

export interface InitializeParams {
  vaultId: BN | number;
  idleBufferBps: number;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  curator: PublicKey;
}

export interface Svs9DepositParams {
  assets: BN;
  minSharesOut: BN;
  owner: PublicKey;
  callerAssetAccount: PublicKey;
  ownerSharesAccount: PublicKey;
}

export interface Svs9RedeemParams {
  shares: BN;
  minAssetsOut: BN;
  owner: PublicKey;
  callerAssetAccount: PublicKey;
  ownerSharesAccount: PublicKey;
}

export interface Svs9MintParams {
  shares: BN;
  maxAssetsIn: BN;
  owner: PublicKey;
  callerAssetAccount: PublicKey;
  ownerSharesAccount: PublicKey;
}

export interface Svs9WithdrawParams {
  assets: BN;
  maxSharesIn: BN;
  owner: PublicKey;
  callerAssetAccount: PublicKey;
  ownerSharesAccount: PublicKey;
}

export interface AddChildParams {
  maxWeightBps: number;
  childDecimalsOffset: number;
  childVault: PublicKey;
  childProgram: PublicKey;
}

export interface RemoveChildParams {
  childVault: PublicKey;
}

export interface UpdateWeightsParams {
  childVault: PublicKey;
  newMaxWeightBps: number;
}

export interface AllocateParams {
  assets: BN;
  minSharesOut: BN;
  childVault: PublicKey;
  childProgram: PublicKey;
  childAssetMint: PublicKey;
  childAssetVault: PublicKey;
  childSharesMint: PublicKey;
}

export interface DeallocateParams {
  sharesToWithdraw: BN;
  minAssetsOut: BN;
  childVault: PublicKey;
  childProgram: PublicKey;
  childAssetMint: PublicKey;
  childAssetVault: PublicKey;
  childSharesMint: PublicKey;
}

export interface HarvestParams {
  minAssetsOut: BN;
  childVault: PublicKey;
  childProgram: PublicKey;
  childAssetMint: PublicKey;
  childAssetVault: PublicKey;
  childSharesMint: PublicKey;
}

export interface RebalanceParams {
  minOut: BN;
  childVault: PublicKey;
  childProgram: PublicKey;
  childAssetMint: PublicKey;
  childAssetVault: PublicKey;
  childSharesMint: PublicKey;
  /** remaining accounts in triplets [ChildAllocation, ChildVaultState, SharesAccount] for total asset computation */
  remainingAccounts?: AccountMeta[];
}

// ============================================================
// Main Client Class
// ============================================================

/**
 * SVS-9 Allocator Vault Client
 *
 * Abstracts all Anchor instruction building, PDA derivation,
 * and account resolution behind an ergonomic async API.
 */
export class AllocatorVaultClient {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;
  readonly allocatorVault: PublicKey;
  readonly assetMint: PublicKey;
  readonly idleVault: PublicKey;
  readonly vaultId: BN;
  readonly assetTokenProgram: PublicKey;

  private _state: AllocatorVaultState | null = null;

  // ─── Constructor ───────────────────────────────────────────

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    allocatorVault: PublicKey,
    assetMint: PublicKey,
    idleVault: PublicKey,
    vaultId: BN,
    assetTokenProgram: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.programId = program.programId;
    this.allocatorVault = allocatorVault;
    this.assetMint = assetMint;
    this.idleVault = idleVault;
    this.vaultId = vaultId;
    this.assetTokenProgram = assetTokenProgram;
  }

  // ─── Factory Methods ───────────────────────────────────────

  /**
   * Load an existing AllocatorVault from the chain.
   */
  static async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<AllocatorVaultClient> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;

    // Detect token program for the asset mint
    const assetTokenProgram = await detectTokenProgram(
      provider,
      assetMint,
    );

    const { allocatorVault, idleVault } = deriveAllocatorAddresses(
      program.programId,
      assetMint,
      id,
      assetTokenProgram,
    );

    const client = new AllocatorVaultClient(
      program,
      provider,
      allocatorVault,
      assetMint,
      idleVault,
      id,
      assetTokenProgram,
    );

    await client.refresh();
    return client;
  }

  /**
   * Create a new AllocatorVault on-chain and return a loaded client.
   */
  static async create(
    program: Program,
    params: InitializeParams,
  ): Promise<AllocatorVaultClient> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;

    const assetTokenProgram = await detectTokenProgram(
      provider,
      params.assetMint,
    );

    const { allocatorVault, idleVault } = deriveAllocatorAddresses(
      program.programId,
      params.assetMint,
      id,
      assetTokenProgram,
    );

    const methodsNs = program.methods as any;
    await methodsNs
      .initialize(id, params.idleBufferBps)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        curator: params.curator,
        allocatorVault,
        assetMint: params.assetMint,
        sharesMint: params.sharesMint,
        idleVault,
        tokenProgram: assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return AllocatorVaultClient.load(program, params.assetMint, id);
  }

  // ─── State Management ──────────────────────────────────────

  /**
   * Refresh AllocatorVault state from the chain.
   */
  async refresh(): Promise<AllocatorVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["allocatorVault"].fetch(
      this.allocatorVault,
    )) as AllocatorVaultState;
    return this._state;
  }

  /**
   * Get cached state (fetches from chain on first call).
   */
  async getState(): Promise<AllocatorVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  /**
   * Fetch a ChildAllocation account for a given child vault.
   */
  async getChildAllocation(
    childVault: PublicKey,
  ): Promise<ChildAllocationState> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      childVault,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["childAllocation"].fetch(
      childAllocation,
    )) as ChildAllocationState;
  }

  /**
   * Helper to fetch all enabled child allocations and return AccountMetas for remaining_accounts.
   */
  async getChildAccountsForComputation(): Promise<AccountMeta[]> {
    const remainingAccounts: AccountMeta[] = [];
    
    // Fetch all ChildAllocation accounts matching this allocatorVault
    // Offset 8 is because allocator_vault is the first field after the 8-byte discriminator
    const accountNs = this.program.account as Record<string, any>;
    const childAllocations = await accountNs["childAllocation"].all([
      {
        memcmp: {
          offset: 8,
          bytes: this.allocatorVault.toBase58(),
        },
      },
    ]);

    for (const alloc of childAllocations) {
      if (alloc.account.enabled) {
        remainingAccounts.push({ pubkey: alloc.publicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childVault as PublicKey, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: alloc.account.childSharesAccount as PublicKey, isSigner: false, isWritable: false });

        let childVaultKey = alloc.account.childVault as PublicKey;
        let assetVault = childVaultKey;
        let sharesMint = childVaultKey;
        try {
          const vaultData = await this.provider.connection.getAccountInfo(childVaultKey);
          if (vaultData) {
            if (vaultData.data.length === 211) {
              sharesMint = new PublicKey(vaultData.data.subarray(72, 104));
              assetVault = new PublicKey(vaultData.data.subarray(104, 136));
            } else if (vaultData.data.length === 197 || vaultData.data.length === 201) {
              sharesMint = new PublicKey(vaultData.data.subarray(72, 104));
              assetVault = new PublicKey(vaultData.data.subarray(104, 136));
            } else if (vaultData.data.length === 246 || vaultData.data.length === 254) {
              sharesMint = new PublicKey(vaultData.data.subarray(104, 136));
              assetVault = new PublicKey(vaultData.data.subarray(136, 168));
            }
          }
        } catch (e) {
            // fallback
        }
        remainingAccounts.push({ pubkey: assetVault, isSigner: false, isWritable: false });
        remainingAccounts.push({ pubkey: sharesMint, isSigner: false, isWritable: false });
      }
    }
    return remainingAccounts;
  }

  // ─── Core Operations ───────────────────────────────────────

  /**
   * Deposit assets into the allocator vault.
   * The caller sends tokens and the owner receives minted shares.
   */
  async deposit(params: Svs9DepositParams): Promise<string> {
    const state = await this.getState();
    const remainingAccounts = await this.getChildAccountsForComputation();
    const methodsNs = this.program.methods as any;

    return methodsNs
      .deposit(params.assets, params.minSharesOut)
      .accountsPartial({
        caller: this.provider.wallet.publicKey,
        owner: params.owner,
        allocatorVault: this.allocatorVault,
        idleVault: this.idleVault,
        sharesMint: state.sharesMint,
        callerAssetAccount: params.callerAssetAccount,
        ownerSharesAccount: params.ownerSharesAccount,
        assetMint: this.assetMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Redeem shares for underlying assets.
   * Owner burns shares and the caller receives the assets.
   */
  async redeem(params: Svs9RedeemParams): Promise<string> {
    const state = await this.getState();
    const remainingAccounts = await this.getChildAccountsForComputation();
    const methodsNs = this.program.methods as any;

    return methodsNs
      .redeem(params.shares, params.minAssetsOut)
      .accountsPartial({
        caller: this.provider.wallet.publicKey,
        owner: params.owner,
        allocatorVault: this.allocatorVault,
        idleVault: this.idleVault,
        sharesMint: state.sharesMint,
        callerAssetAccount: params.callerAssetAccount,
        ownerSharesAccount: params.ownerSharesAccount,
        assetMint: this.assetMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Mint exact amount of shares by paying assets.
   * The caller sends tokens and the owner receives minted shares.
   */
  async mint(params: Svs9MintParams): Promise<string> {
    const state = await this.getState();
    const remainingAccounts = await this.getChildAccountsForComputation();
    const methodsNs = this.program.methods as any;

    return methodsNs
      .mint(params.shares, params.maxAssetsIn)
      .accountsPartial({
        caller: this.provider.wallet.publicKey,
        owner: params.owner,
        allocatorVault: this.allocatorVault,
        idleVault: this.idleVault,
        sharesMint: state.sharesMint,
        callerAssetAccount: params.callerAssetAccount,
        ownerSharesAccount: params.ownerSharesAccount,
        assetMint: this.assetMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Withdraw exact amount of assets by burning shares.
   * Owner burns shares and the caller receives the assets.
   */
  async withdraw(params: Svs9WithdrawParams): Promise<string> {
    const state = await this.getState();
    const remainingAccounts = await this.getChildAccountsForComputation();
    const methodsNs = this.program.methods as any;

    return methodsNs
      .withdraw(params.assets, params.maxSharesIn)
      .accountsPartial({
        caller: this.provider.wallet.publicKey,
        owner: params.owner,
        allocatorVault: this.allocatorVault,
        idleVault: this.idleVault,
        sharesMint: state.sharesMint,
        callerAssetAccount: params.callerAssetAccount,
        ownerSharesAccount: params.ownerSharesAccount,
        assetMint: this.assetMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  // ─── Child Vault Management ────────────────────────────────

  /**
   * Add a child vault to the allocator.
   * Authority-only operation.
   */
  async addChild(params: AddChildParams): Promise<string> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );

    // Fetch child vault to get its shares mint
    const vaultData = await this.provider.connection.getAccountInfo(params.childVault);
    if (!vaultData) throw new Error("Child vault not found");
    
    // SVS-1/5/2/3/4 all have shares_mint at offset 72 or 104
    let childSharesMint: PublicKey;
    if (vaultData.data.length === 211 || vaultData.data.length === 197 || vaultData.data.length === 201) {
      childSharesMint = new PublicKey(vaultData.data.subarray(72, 104));
    } else if (vaultData.data.length === 246 || vaultData.data.length === 254) {
      childSharesMint = new PublicKey(vaultData.data.subarray(104, 136));
    } else {
      throw new Error(`Unknown vault data length: ${vaultData.data.length}`);
    }

    const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
      this.allocatorVault,
      childSharesMint,
    );

    const methodsNs = this.program.methods as any;

    return methodsNs
      .addChild(params.maxWeightBps, params.childDecimalsOffset)
      .accounts({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        childVault: params.childVault,
        childProgram: params.childProgram,
        childSharesMint,
        allocatorChildSharesAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Remove (disable) a child vault from the allocator.
   * Sets enabled = false, zeroes weights, decrements num_children.
   */
  async removeChild(params: RemoveChildParams): Promise<string> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const methodsNs = this.program.methods as any;

    return methodsNs
      .removeChild()
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        childVault: params.childVault,
      })
      .rpc();
  }

  /**
   * Update the max_weight_bps of a child allocation.
   * Authority-only operation.
   */
  async updateWeights(params: UpdateWeightsParams): Promise<string> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const methodsNs = this.program.methods as any;

    return methodsNs
      .updateWeights(params.newMaxWeightBps)
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        childVault: params.childVault,
      })
      .rpc();
  }

  // ─── Curator Operations ────────────────────────────────────

  /**
   * Allocate idle assets into a child vault via CPI deposit.
   * Curator-only operation.
   */
  async allocate(params: AllocateParams): Promise<string> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
      this.allocatorVault,
      params.childSharesMint,
    );
    const methodsNs = this.program.methods as any;

    return methodsNs
      .allocate(params.assets, params.minSharesOut)
      .accountsPartial({
        curator: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        idleVault: this.idleVault,
        childVault: params.childVault,
        childProgram: params.childProgram,
        childAssetMint: params.childAssetMint,
        childAssetVault: params.childAssetVault,
        childSharesMint: params.childSharesMint,
        allocatorChildSharesAccount,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  /**
   * Deallocate: redeem shares from a child vault back to idle.
   * Curator-only operation.
   */
  async deallocate(params: DeallocateParams): Promise<string> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
      this.allocatorVault,
      params.childSharesMint,
    );
    const methodsNs = this.program.methods as any;

    return methodsNs
      .deallocate(params.sharesToWithdraw, params.minAssetsOut)
      .accountsPartial({
        curator: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        idleVault: this.idleVault,
        childVault: params.childVault,
        childProgram: params.childProgram,
        allocatorChildSharesAccount,
        childAssetMint: params.childAssetMint,
        childAssetVault: params.childAssetVault,
        childSharesMint: params.childSharesMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Harvest yield from a child vault via CPI redeem.
   * Curator-only operation. Redeems profit shares to the idle vault.
   */
  async harvest(params: HarvestParams): Promise<string> {
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
      this.allocatorVault,
      params.childSharesMint,
    );
    const methodsNs = this.program.methods as any;

    return methodsNs
      .harvest(params.minAssetsOut)
      .accountsPartial({
        curator: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        childVault: params.childVault,
        childProgram: params.childProgram,
        idleVault: this.idleVault,
        allocatorChildSharesAccount,
        childAssetMint: params.childAssetMint,
        childAssetVault: params.childAssetVault,
        childSharesMint: params.childSharesMint,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Rebalance: deposit excess or withdraw deficit from a child vault
   * to maintain the idle_buffer_bps ratio. Curator-only operation.
   */
  async rebalance(params: RebalanceParams): Promise<string> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const [childAllocation] = getChildAllocationAddress(
      this.programId,
      this.allocatorVault,
      params.childVault,
    );
    const allocatorChildSharesAccount = getAllocatorChildSharesAddress(
      this.allocatorVault,
      params.childSharesMint,
    );
    const methodsNs = this.program.methods as any;

    let builder = methodsNs
      .rebalance(params.minOut)
      .accountsPartial({
        curator: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
        childAllocation,
        idleVault: this.idleVault,
        childVault: params.childVault,
        childProgram: params.childProgram,
        childAssetMint: params.childAssetMint,
        childAssetVault: params.childAssetVault,
        childSharesMint: params.childSharesMint,
        allocatorChildSharesAccount,
        tokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts);

    return builder.rpc();
  }

  // ─── Admin Operations ──────────────────────────────────────

  /**
   * Pause the allocator vault. Authority-only.
   */
  async pause(): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .pause()
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
      })
      .rpc();
  }

  /**
   * Unpause the allocator vault. Authority-only.
   */
  async unpause(): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .unpause()
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
      })
      .rpc();
  }

  /**
   * Transfer vault authority to a new address. Authority-only.
   */
  async transferAuthority(newAuthority: PublicKey): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .transferAuthority(newAuthority)
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
      })
      .rpc();
  }

  /**
   * Set a new curator for the vault. Authority-only.
   */
  async setCurator(newCurator: PublicKey): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .setCurator(newCurator)
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        allocatorVault: this.allocatorVault,
      })
      .rpc();
  }

  // ─── Off-Chain Simulation / Preview ────────────────────────

  /**
   * Preview the result of a deposit (net shares out) using on-chain view.
   */
  async previewDeposit(assets: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();

    const sim: any = await this.program.methods
      .previewDeposit(assets)
      .accounts({
        allocatorVault: this.allocatorVault,
        sharesMint: state.sharesMint,
        idleVault: this.idleVault,
      } as any)
      .remainingAccounts(remainingAccounts)
      .simulate();

    const returnData = sim.returnData || (sim as any).returnValue;
    if (!returnData) throw new Error("No return data from previewDeposit");
    return new BN(returnData as any);
  }

  /**
   * Preview the result of a redeem (net assets out) using on-chain view.
   */
  async previewRedeem(shares: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();

    const sim: any = await this.program.methods
      .previewRedeem(shares)
      .accounts({
        allocatorVault: this.allocatorVault,
        sharesMint: state.sharesMint,
        idleVault: this.idleVault,
      } as any)
      .remainingAccounts(remainingAccounts)
      .simulate();

    const returnData = sim.returnData || (sim as any).returnValue;
    if (!returnData) throw new Error("No return data from previewRedeem");
    return new BN(returnData as any);
  }

  /**
   * Preview the result of a mint (net assets in) using on-chain view.
   */
  async previewMint(shares: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();

    const sim: any = await this.program.methods
      .previewMint(shares)
      .accounts({
        allocatorVault: this.allocatorVault,
        sharesMint: state.sharesMint,
        idleVault: this.idleVault,
      } as any)
      .remainingAccounts(remainingAccounts)
      .simulate();

    const returnData = sim.returnData || (sim as any).returnValue;
    if (!returnData) throw new Error("No return data from previewMint");
    return new BN(returnData as any);
  }

  /**
   * Preview the result of a withdraw (net shares in) using on-chain view.
   */
  async previewWithdraw(assets: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();

    const sim: any = await this.program.methods
      .previewWithdraw(assets)
      .accounts({
        allocatorVault: this.allocatorVault,
        sharesMint: state.sharesMint,
        idleVault: this.idleVault,
      } as any)
      .remainingAccounts(remainingAccounts)
      .simulate();

    const returnData = sim.returnData || (sim as any).returnValue;
    if (!returnData) throw new Error("No return data from previewWithdraw");
    return new BN(returnData as any);
  }

  async maxDeposit(): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.maxDeposit().accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  async maxMint(): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.maxMint().accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  async maxWithdraw(owner: PublicKey): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.maxWithdraw().accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
      ownerSharesAccount: this.getUserSharesAccount(owner),
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  async maxRedeem(owner: PublicKey): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.maxRedeem().accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
      ownerSharesAccount: this.getUserSharesAccount(owner),
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  async convertToShares(assets: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.convertToShares(assets).accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  async convertToAssets(shares: BN): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();
    const sim: any = await this.program.methods.convertToAssets(shares).accounts({
      allocatorVault: this.allocatorVault,
      sharesMint: state.sharesMint,
      idleVault: this.idleVault,
    } as any).remainingAccounts(remainingAccounts).simulate();
    return new BN(sim.returnData || sim.returnValue);
  }

  // ─── View / Query Helpers ──────────────────────────────────

  /**
   * Get idle vault balance (unallocated assets).
   */
  async getIdleBalance(): Promise<BN> {
    const account = await getAccount(
      this.provider.connection,
      this.idleVault,
      undefined,
      this.assetTokenProgram,
    );
    return new BN(account.amount.toString());
  }

  /**
   * Get total assets (idle + all child vaults).
   */
  async totalAssets(): Promise<BN> {
    const remainingAccounts = await this.getChildAccountsForComputation();
    const state = await this.getState();

    const sim: any = await (this.program.methods.getTotalAssets() as any)
      .accounts({
        allocatorVault: this.allocatorVault,
        sharesMint: state.sharesMint,
        idleVault: this.idleVault,
      })
      .remainingAccounts(remainingAccounts)
      .simulate();

    const returnData = sim.returnData || (sim as any).returnValue;
    if (!returnData) throw new Error("No return data from totalAssets");
    return new BN(returnData as any);
  }

  /**
   * Get total shares supply of the allocator vault.
   */
  async totalShares(): Promise<BN> {
    const state = await this.getState();
    const mint = await getMint(
      this.provider.connection,
      state.sharesMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return new BN(mint.supply.toString());
  }

  /**
   * Check if vault is paused.
   */
  async isPaused(): Promise<boolean> {
    const state = await this.refresh();
    return state.paused;
  }

  /**
   * Get the current authority pubkey.
   */
  async getAuthority(): Promise<PublicKey> {
    const state = await this.getState();
    return state.authority;
  }

  /**
   * Get the current curator pubkey.
   */
  async getCurator(): Promise<PublicKey> {
    const state = await this.getState();
    return state.curator;
  }

  /**
   * Get the number of active child vaults.
   */
  async getNumChildren(): Promise<number> {
    const state = await this.refresh();
    return state.numChildren;
  }

  /**
   * Get user's shares ATA address for this allocator vault.
   */
  getUserSharesAccount(owner: PublicKey): PublicKey {
    const state = this._state;
    if (!state) {
      throw new Error(
        "State not loaded. Call refresh() or getState() first.",
      );
    }
    return getAssociatedTokenAddressSync(
      state.sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  /**
   * Get user's asset ATA address.
   */
  getUserAssetAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.assetMint,
      owner,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Detect if a mint uses SPL Token or Token-2022 by reading its on-chain owner.
 */
async function detectTokenProgram(
  provider: AnchorProvider,
  mint: PublicKey,
): Promise<PublicKey> {
  const accountInfo = await provider.connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }
  if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  }
  if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    return TOKEN_PROGRAM_ID;
  }
  throw new Error(
    `Unknown token program for mint: ${accountInfo.owner.toBase58()}`,
  );
}
