/**
 * Streaming Yield Vault Module (SVS-5)
 *
 * Extension of SolanaVault for time-interpolated yield distribution. Unlike
 * SVS-2 which uses discrete sync() calls, SVS-5 distributes yield linearly
 * over a configurable stream period. This eliminates MEV from front-running
 * sync calls and provides smoother share price appreciation.
 *
 * Flow:
 * - Authority calls distributeYield(amount, duration) to start a stream
 * - total_assets increases linearly between stream_start and stream_end
 * - Anyone can call checkpoint() to materialize accrued yield into base_assets
 *
 * @example
 * ```ts
 * import { StreamingVault } from "@stbr/solana-vault";
 *
 * // Load SVS-5 vault
 * const vault = await StreamingVault.load(program, assetMint, 1);
 *
 * // Distribute yield over 1 hour
 * await vault.distributeYield(authority, new BN(1_000_000), new BN(3600));
 *
 * // Permissionless checkpoint
 * await vault.checkpoint();
 *
 * // Operations work the same as SolanaVault
 * await vault.deposit(user, { assets, minSharesOut });
 * ```
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import {
  SolanaVault,
  VaultState,
  CreateVaultParams,
  DepositParams,
  MintParams,
  getTokenProgramForMint,
} from "./vault";
import { getSharesMintAddress } from "./pda";

/** SVS-5 vault PDA uses "stream_vault" seed instead of "vault" */
const STREAM_VAULT_SEED = Buffer.from("stream_vault");

function deriveStreamVaultAddresses(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN,
) {
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [STREAM_VAULT_SEED, assetMint.toBuffer(), vaultId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  const [sharesMint, sharesMintBump] = getSharesMintAddress(programId, vault);
  return { vault, vaultBump, sharesMint, sharesMintBump };
}

export interface StreamingVaultState extends VaultState {
  baseAssets: BN;
  streamAmount: BN;
  streamStart: BN;
  streamEnd: BN;
  lastCheckpoint: BN;
  _reserved: number[];
}

export interface StreamInfo {
  baseAssets: BN;
  streamAmount: BN;
  streamStart: BN;
  streamEnd: BN;
  effectiveTotal: BN;
  lastCheckpoint: BN;
}

/**
 * SVS-5 Streaming Yield Vault SDK
 *
 * Extends SolanaVault with time-interpolated yield distribution.
 * SVS-5 uses vault.base_assets + linearly accrued stream yield
 * for total_assets calculation, rather than discrete balance updates.
 */
export class StreamingVault extends SolanaVault {
  private _streamState: StreamingVaultState | null = null;

  /**
   * Load an existing SVS-5 vault
   */
  static override async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<StreamingVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveStreamVaultAddresses(program.programId, assetMint, id);

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

    const vault = new StreamingVault(
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
   * Create a new SVS-5 vault
   */
  static override async create(
    program: Program,
    params: CreateVaultParams,
  ): Promise<StreamingVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveStreamVaultAddresses(
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
      addresses.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initialize(id)
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

    return StreamingVault.load(program, params.assetMint, id);
  }

  /**
   * Create ATA instruction for user's shares account if it doesn't exist.
   * SVS-5 deposit/mint don't use init_if_needed — ATA must exist beforehand.
   */
  private createSharesAtaIx(user: PublicKey) {
    return createAssociatedTokenAccountIdempotentInstruction(
      user,
      this.getUserSharesAccount(user),
      user,
      this.sharesMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  /**
   * Deposit assets and receive shares.
   * Overrides base to prepend ATA creation (SVS-5 doesn't use init_if_needed).
   */
  override async deposit(user: PublicKey, params: DepositParams): Promise<string> {
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
      })
      .preInstructions([this.createSharesAtaIx(user)])
      .rpc();
  }

  /**
   * Mint exact shares by paying assets.
   * Overrides base to prepend ATA creation (SVS-5 doesn't use init_if_needed).
   */
  override async mint(user: PublicKey, params: MintParams): Promise<string> {
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
      })
      .preInstructions([this.createSharesAtaIx(user)])
      .rpc();
  }

  /**
   * Refresh vault state from chain.
   * Overrides base to use SVS-5's StreamVault account type.
   */
  override async refresh(): Promise<VaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._streamState = (await accountNs["streamVault"].fetch(
      this.vault,
    )) as StreamingVaultState;
    return this._streamState;
  }

  /**
   * Get cached state or fetch if not available
   */
  override async getState(): Promise<VaultState> {
    if (!this._streamState) {
      await this.refresh();
    }
    return this._streamState!;
  }

  /**
   * Distribute yield as a time-interpolated stream.
   * Authority-only. Transfers yield tokens to the vault and starts a linear stream.
   */
  async distributeYield(
    authority: PublicKey,
    yieldAmount: BN,
    duration: BN,
  ): Promise<string> {
    const authorityAssetAccount = this.getUserAssetAccount(authority);

    return this.program.methods
      .distributeYield(yieldAmount, duration)
      .accountsStrict({
        authority,
        vault: this.vault,
        assetMint: this.assetMint,
        authorityAssetAccount,
        assetVault: this.assetVault,
        assetTokenProgram: this.assetTokenProgram,
      })
      .rpc();
  }

  /**
   * Checkpoint: materialize accrued streaming yield into base_assets.
   * Permissionless — anyone can call.
   */
  async checkpoint(): Promise<string> {
    return this.program.methods
      .checkpoint()
      .accountsStrict({
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Get stream info from vault state.
   * Returns base_assets, stream parameters, and client-computed effective total.
   */
  async getStreamInfo(): Promise<StreamInfo> {
    const state = (await this.refresh()) as StreamingVaultState;
    const now = new BN(Math.floor(Date.now() / 1000));
    const effectiveTotal = this.computeEffectiveTotalAssets(state, now);

    return {
      baseAssets: state.baseAssets,
      streamAmount: state.streamAmount,
      streamStart: state.streamStart,
      streamEnd: state.streamEnd,
      effectiveTotal,
      lastCheckpoint: state.lastCheckpoint,
    };
  }

  /**
   * Client-side calculation of effective total assets (base_assets + accrued stream yield).
   * Uses current wall-clock time for interpolation.
   */
  async effectiveTotalAssets(): Promise<BN> {
    const state = (await this.refresh()) as StreamingVaultState;
    const now = new BN(Math.floor(Date.now() / 1000));
    return this.computeEffectiveTotalAssets(state, now);
  }

  /**
   * Get stored base_assets from vault state.
   */
  async storedBaseAssets(): Promise<BN> {
    const state = (await this.refresh()) as StreamingVaultState;
    return state.baseAssets;
  }

  private computeEffectiveTotalAssets(
    state: StreamingVaultState,
    now: BN,
  ): BN {
    if (state.streamAmount.isZero() || now.lte(state.streamStart)) {
      return state.baseAssets;
    }

    if (now.gte(state.streamEnd)) {
      return state.baseAssets.add(state.streamAmount);
    }

    const elapsed = now.sub(state.streamStart);
    const duration = state.streamEnd.sub(state.streamStart);
    const accrued = state.streamAmount.mul(elapsed).div(duration);

    return state.baseAssets.add(accrued);
  }
}
