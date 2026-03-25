/**
 * SVS-7 Native SOL Vault SDK
 *
 * Provides deposit, mint, withdraw, redeem operations for the Native SOL Vault.
 * Handles SOL ↔ wSOL wrapping transparently. Users interact with native lamports
 * while the vault's internal accounting uses a wSOL token account.
 *
 * Key differences from SolanaVault (SVS-1):
 * - Asset is always native SOL (NATIVE_MINT)
 * - PDA seeds: ["sol_vault", vault_id.to_le_bytes()] — no asset_mint in seeds
 * - Dual interface: `_sol` (native SOL) and `_wsol` (pre-wrapped wSOL) variants
 * - wSOL uses SPL Token program; shares use Token-2022 program
 * - decimals_offset is always 0 (SOL has 9 decimals, 9 - 9 = 0)
 *
 * @example
 * ```ts
 * import { SolVault } from "@stbr/solana-vault";
 *
 * // Load existing SOL vault
 * const vault = await SolVault.load(program, 1);
 *
 * // Preview and deposit native SOL
 * const shares = await vault.previewDepositSol(new BN(1_000_000_000)); // 1 SOL
 * await vault.depositSol(user, {
 *   lamports: new BN(1_000_000_000),
 *   minSharesOut: shares.mul(new BN(95)).div(new BN(100)), // 5% slippage
 * });
 * ```
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";

import * as math from "./math";

// ============ PDA Seeds & Derivation ============

/** Seed prefix for SVS-7 vault PDA */
export const SOL_VAULT_SEED = Buffer.from("sol_vault");
/** Seed prefix for SVS-7 shares mint PDA (same as SVS-1) */
export const SOL_SHARES_MINT_SEED = Buffer.from("shares");

/**
 * Derive the SVS-7 vault PDA address.
 * Seeds: ["sol_vault", vault_id (u64 LE)]
 */
export function getSolVaultAddress(
  programId: PublicKey,
  vaultId: BN | number,
): [PublicKey, number] {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  return PublicKey.findProgramAddressSync(
    [SOL_VAULT_SEED, id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

/**
 * Derive the SVS-7 shares mint PDA address.
 * Seeds: ["shares", vault_pubkey]
 */
export function getSolSharesMintAddress(
  programId: PublicKey,
  vault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SOL_SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
}

/**
 * Derive all SVS-7 vault-related addresses at once.
 */
export function deriveSolVaultAddresses(
  programId: PublicKey,
  vaultId: BN | number,
): {
  vault: PublicKey;
  vaultBump: number;
  sharesMint: PublicKey;
  sharesMintBump: number;
  wsolVault: PublicKey;
} {
  const [vault, vaultBump] = getSolVaultAddress(programId, vaultId);
  const [sharesMint, sharesMintBump] = getSolSharesMintAddress(
    programId,
    vault,
  );
  // wSOL vault is the ATA of vault PDA for NATIVE_MINT using SPL Token program
  const wsolVault = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true, // allowOwnerOffCurve = true (vault is a PDA)
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { vault, vaultBump, sharesMint, sharesMintBump, wsolVault };
}

// ============ Interfaces ============

export interface SolVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  wsolVault: PublicKey;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
}

export interface CreateSolVaultParams {
  vaultId: BN | number;
}

export interface DepositSolParams {
  /** Lamports to deposit (native SOL) */
  lamports: BN;
  /** Minimum shares to receive (slippage protection) */
  minSharesOut: BN;
}

export interface MintSolParams {
  /** Exact shares to receive */
  shares: BN;
  /** Maximum lamports to pay (slippage protection) */
  maxLamportsIn: BN;
}

export interface WithdrawSolParams {
  /** Exact lamports to receive (native SOL) */
  lamports: BN;
  /** Maximum shares to burn (slippage protection) */
  maxSharesIn: BN;
}

export interface RedeemSolParams {
  /** Exact shares to burn */
  shares: BN;
  /** Minimum lamports to receive (slippage protection) */
  minLamportsOut: BN;
}

// ============ SolVault Class ============

/**
 * SVS-7 Native SOL Vault SDK
 *
 * Wraps the SVS-7 on-chain program, providing a typed TypeScript interface
 * for all vault operations. Supports both native SOL and pre-wrapped wSOL
 * entry/exit paths.
 */
export class SolVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  /** Vault PDA address */
  readonly vault: PublicKey;
  /** Token-2022 shares mint address */
  readonly sharesMint: PublicKey;
  /** wSOL token account (ATA of vault for NATIVE_MINT, SPL Token program) */
  readonly wsolVault: PublicKey;
  /** Unique vault identifier used in PDA derivation */
  readonly vaultId: BN;

  private _state: SolVaultState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    sharesMint: PublicKey,
    wsolVault: PublicKey,
    vaultId: BN,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.sharesMint = sharesMint;
    this.wsolVault = wsolVault;
    this.vaultId = vaultId;
  }

  /**
   * Load an existing SVS-7 vault by ID.
   */
  static async load(
    program: Program,
    vaultId: BN | number,
  ): Promise<SolVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveSolVaultAddresses(program.programId, id);

    const vault = new SolVault(
      program,
      provider,
      addresses.vault,
      addresses.sharesMint,
      addresses.wsolVault,
      id,
    );

    await vault.refresh();
    return vault;
  }

  /**
   * Initialize and load a new SVS-7 vault.
   */
  static async create(
    program: Program,
    params: CreateSolVaultParams,
  ): Promise<SolVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveSolVaultAddresses(program.programId, id);

    await program.methods
      .initialize(id)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault: addresses.vault,
        nativeMint: NATIVE_MINT,
        sharesMint: addresses.sharesMint,
        wsolVault: addresses.wsolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return SolVault.load(program, id);
  }

  /**
   * Refresh vault state from chain.
   */
  async refresh(): Promise<SolVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["solVault"].fetch(
      this.vault,
    )) as SolVaultState;
    return this._state;
  }

  /**
   * Get cached state or fetch if not available.
   */
  async getState(): Promise<SolVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  // ============ Token Account Helpers ============

  /**
   * Get user's shares token account address (Token-2022 ATA).
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
   * Get user's wSOL token account address (SPL Token ATA for NATIVE_MINT).
   * Required for wSOL-interface operations and as landing pad for withdraw_sol.
   */
  getUserWsolAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      NATIVE_MINT,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // ============ Native SOL Interface ============

  /**
   * Deposit native SOL and receive vault shares.
   *
   * The vault wraps SOL to wSOL internally via sync_native.
   * No pre-wrapping required.
   */
  async depositSol(
    user: PublicKey,
    params: DepositSolParams,
  ): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .depositSol(params.lamports, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Mint exact shares by paying native SOL.
   *
   * Required lamports are computed with ceiling rounding (protects vault).
   */
  async mintSol(user: PublicKey, params: MintSolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .mintSol(params.shares, params.maxLamportsIn)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Withdraw exact lamports as native SOL by burning shares.
   *
   * The user must have a wSOL ATA (used as landing pad; closed automatically
   * by the program to deliver native SOL).
   * Shares burned are computed with ceiling rounding (protects vault).
   */
  async withdrawSol(
    user: PublicKey,
    params: WithdrawSolParams,
  ): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .withdrawSol(params.lamports, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        userWsolAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Redeem exact shares for native SOL.
   *
   * Assets received are computed with floor rounding (protects vault).
   */
  async redeemSol(user: PublicKey, params: RedeemSolParams): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .redeemSol(params.shares, params.minLamportsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        userWsolAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  // ============ wSOL Interface (protocol composability) ============

  /**
   * Deposit pre-wrapped wSOL and receive vault shares.
   *
   * For protocols that already hold wSOL. No sync_native overhead.
   */
  async depositWsol(
    user: PublicKey,
    params: DepositSolParams,
  ): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .depositWsol(params.lamports, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        userWsolAccount,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Mint exact shares by paying wSOL.
   *
   * Required wSOL computed with ceiling rounding (protects vault).
   */
  async mintWsol(user: PublicKey, params: MintSolParams): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .mintWsol(params.shares, params.maxLamportsIn)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        userWsolAccount,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Withdraw exact wSOL by burning shares (no SOL unwrap).
   *
   * Shares burned are computed with ceiling rounding (protects vault).
   */
  async withdrawWsol(
    user: PublicKey,
    params: WithdrawSolParams,
  ): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .withdrawWsol(params.lamports, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        userWsolAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Redeem exact shares for wSOL (no SOL unwrap).
   *
   * Assets received are computed with floor rounding (protects vault).
   */
  async redeemWsol(user: PublicKey, params: RedeemSolParams): Promise<string> {
    const userWsolAccount = this.getUserWsolAccount(user);
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .redeemWsol(params.shares, params.minLamportsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        nativeMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        userWsolAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  // ============ View Functions (Off-chain) ============

  /**
   * Get total lamports managed by vault (reads live wSOL vault balance).
   */
  async totalAssets(): Promise<BN> {
    const account = await getAccount(
      this.provider.connection,
      this.wsolVault,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    return new BN(account.amount.toString());
  }

  /**
   * Get total shares supply.
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
   * Preview shares for SOL deposit (floor rounding).
   */
  async previewDepositSol(lamports: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.previewDeposit(
      lamports,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  /**
   * Preview SOL required for exact shares mint (ceiling rounding).
   */
  async previewMintSol(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.previewMint(
      shares,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  /**
   * Preview shares to burn for exact SOL withdraw (ceiling rounding).
   */
  async previewWithdrawSol(lamports: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.previewWithdraw(
      lamports,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  /**
   * Preview SOL for share redeem (floor rounding).
   */
  async previewRedeemSol(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.previewRedeem(
      shares,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  /**
   * Convert lamports to shares (floor rounding).
   */
  async convertToShares(lamports: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.convertToShares(
      lamports,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  /**
   * Convert shares to lamports (floor rounding).
   */
  async convertToAssets(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalSharesSupply = await this.totalShares();
    return math.convertToAssets(
      shares,
      totalAssets,
      totalSharesSupply,
      state.decimalsOffset,
    );
  }

  // ============ Admin Functions ============

  /**
   * Pause all vault operations (emergency circuit breaker).
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
   * Unpause vault operations.
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
   * Transfer vault authority to a new address.
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

  // ============ State Helpers ============

  /**
   * Check if vault is paused.
   */
  async isPaused(): Promise<boolean> {
    const state = await this.getState();
    return state.paused;
  }

  /**
   * Get vault authority.
   */
  async getAuthority(): Promise<PublicKey> {
    const state = await this.getState();
    return state.authority;
  }

  /**
   * Get decimals offset (always 0 for SOL vaults).
   */
  async getDecimalsOffset(): Promise<number> {
    const state = await this.getState();
    return state.decimalsOffset;
  }
}
