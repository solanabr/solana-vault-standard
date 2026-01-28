import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import { deriveVaultAddresses } from "./pda";
import * as math from "./math";

/**
 * Detect which token program owns a mint account.
 * Returns TOKEN_PROGRAM_ID for SPL Token or TOKEN_2022_PROGRAM_ID for Token-2022.
 */
export async function getTokenProgramForMint(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const accountInfo = await connection.getAccountInfo(mint);
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

/**
 * Check if a mint uses Token-2022 program
 */
export async function isToken2022Mint(
  connection: Connection,
  mint: PublicKey,
): Promise<boolean> {
  const program = await getTokenProgramForMint(connection, mint);
  return program.equals(TOKEN_2022_PROGRAM_ID);
}

export interface VaultState {
  authority: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  totalAssets: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
}

export interface CreateVaultParams {
  assetMint: PublicKey;
  vaultId: BN | number;
  name: string;
  symbol: string;
  uri: string;
}

export interface DepositParams {
  assets: BN;
  minSharesOut: BN;
}

export interface MintParams {
  shares: BN;
  maxAssetsIn: BN;
}

export interface WithdrawParams {
  assets: BN;
  maxSharesIn: BN;
}

export interface RedeemParams {
  shares: BN;
  minAssetsOut: BN;
}

/**
 * SVS-1 Solana Vault SDK
 */
export class SolanaVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly assetMint: PublicKey;
  readonly assetVault: PublicKey;
  readonly vaultId: BN;
  /** Token program for the asset mint (SPL Token or Token-2022) */
  readonly assetTokenProgram: PublicKey;

  private _state: VaultState | null = null;

  private constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    sharesMint: PublicKey,
    assetMint: PublicKey,
    assetVault: PublicKey,
    vaultId: BN,
    assetTokenProgram: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.sharesMint = sharesMint;
    this.assetMint = assetMint;
    this.assetVault = assetVault;
    this.vaultId = vaultId;
    this.assetTokenProgram = assetTokenProgram;
  }

  /**
   * Load an existing vault
   */
  static async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<SolanaVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveVaultAddresses(program.programId, assetMint, id);

    // Detect asset mint's token program (SPL Token or Token-2022)
    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      assetMint,
    );

    const assetVault = getAssociatedTokenAddressSync(
      assetMint,
      addresses.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const vault = new SolanaVault(
      program,
      provider,
      addresses.vault,
      addresses.sharesMint,
      assetMint,
      assetVault,
      id,
      assetTokenProgram,
    );

    await vault.refresh();
    return vault;
  }

  /**
   * Create a new vault
   */
  static async create(
    program: Program,
    params: CreateVaultParams,
  ): Promise<SolanaVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveVaultAddresses(
      program.programId,
      params.assetMint,
      id,
    );

    // Detect asset mint's token program (SPL Token or Token-2022)
    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      params.assetMint,
    );

    const assetVault = getAssociatedTokenAddressSync(
      params.assetMint,
      addresses.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(id, params.name, params.symbol, params.uri)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault: addresses.vault,
        assetMint: params.assetMint,
        sharesMint: addresses.sharesMint,
        assetVault: assetVault,
        assetTokenProgram: assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return SolanaVault.load(program, params.assetMint, id);
  }

  /**
   * Refresh vault state from chain
   */
  async refresh(): Promise<VaultState> {
    // Use bracket notation to access dynamically typed account
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["vault"].fetch(this.vault)) as VaultState;
    return this._state;
  }

  /**
   * Get cached state or fetch if not available
   */
  async getState(): Promise<VaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  /**
   * Get user's shares token account address
   */
  getUserSharesAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  /**
   * Get user's asset token account address
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

  // ============ Core Operations ============

  /**
   * Deposit assets and receive shares
   */
  async deposit(user: PublicKey, params: DepositParams): Promise<string> {
    const userAssetAccount = this.getUserAssetAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .deposit(params.assets, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Mint exact shares by paying assets
   */
  async mint(user: PublicKey, params: MintParams): Promise<string> {
    const userAssetAccount = this.getUserAssetAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .mint(params.shares, params.maxAssetsIn)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Withdraw exact assets by burning shares
   */
  async withdraw(user: PublicKey, params: WithdrawParams): Promise<string> {
    const userAssetAccount = this.getUserAssetAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .withdraw(params.assets, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Redeem shares for assets
   */
  async redeem(user: PublicKey, params: RedeemParams): Promise<string> {
    const userAssetAccount = this.getUserAssetAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .redeem(params.shares, params.minAssetsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  // ============ View Functions (Off-chain) ============

  /**
   * Get total assets in vault
   */
  async totalAssets(): Promise<BN> {
    const state = await this.getState();
    return state.totalAssets;
  }

  /**
   * Get total shares supply
   */
  async totalShares(): Promise<BN> {
    const mint = await getMint(
      this.provider.connection,
      this.sharesMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return new BN(mint.supply.toString());
  }

  /**
   * Preview shares for deposit
   */
  async previewDeposit(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const totalShares = await this.totalShares();
    return math.previewDeposit(
      assets,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  /**
   * Preview assets for mint
   */
  async previewMint(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalShares = await this.totalShares();
    return math.previewMint(
      shares,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  /**
   * Preview shares for withdraw
   */
  async previewWithdraw(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const totalShares = await this.totalShares();
    return math.previewWithdraw(
      assets,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  /**
   * Preview assets for redeem
   */
  async previewRedeem(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalShares = await this.totalShares();
    return math.previewRedeem(
      shares,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  /**
   * Convert assets to shares
   */
  async convertToShares(assets: BN): Promise<BN> {
    const state = await this.getState();
    const totalShares = await this.totalShares();
    return math.convertToShares(
      assets,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  /**
   * Convert shares to assets
   */
  async convertToAssets(shares: BN): Promise<BN> {
    const state = await this.getState();
    const totalShares = await this.totalShares();
    return math.convertToAssets(
      shares,
      state.totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  // ============ Admin Functions ============

  /**
   * Pause vault (emergency)
   */
  async pause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .pause()
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Unpause vault
   */
  async unpause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Transfer vault authority
   */
  async transferAuthority(
    authority: PublicKey,
    newAuthority: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .transferAuthority(newAuthority)
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Sync total_assets with actual vault balance
   */
  async sync(authority: PublicKey): Promise<string> {
    return this.program.methods
      .sync()
      .accountsStrict({
        authority,
        vault: this.vault,
        assetVault: this.assetVault,
      })
      .rpc();
  }

  // ============ State Helpers ============

  /**
   * Check if vault is paused
   */
  async isPaused(): Promise<boolean> {
    const state = await this.getState();
    return state.paused;
  }

  /**
   * Get vault authority
   */
  async getAuthority(): Promise<PublicKey> {
    const state = await this.getState();
    return state.authority;
  }

  /**
   * Get decimals offset
   */
  async getDecimalsOffset(): Promise<number> {
    const state = await this.getState();
    return state.decimalsOffset;
  }

  /**
   * Check if the asset uses Token-2022 program
   */
  isAssetToken2022(): boolean {
    return this.assetTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  }
}
