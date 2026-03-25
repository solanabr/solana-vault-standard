import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { deriveVaultAddress, deriveSharesMintAddress } from "./pda";
import {
  effectiveTotalAssets,
  convertToShares,
  convertToAssets,
  convertToSharesCeil,
  calculateAccrued,
  sharePrice,
} from "./math";
import type {
  VaultState,
  InitializeParams,
  DepositPreview,
  RedeemPreview,
  StreamStatus,
} from "./types";

/**
 * SVS-6 Confidential Streaming Yield Vault SDK.
 *
 * Provides methods for all vault operations including streaming yield
 * management and client-side preview calculations.
 *
 * Note: Confidential transfer operations (configure_account, apply_pending,
 * withdraw/redeem with ZK proofs) require @stbr/svs-privacy-sdk for
 * proof generation via the Rust backend.
 */
export class ConfidentialStreamingVault {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly vaultAddress: PublicKey;

  private cachedState: VaultState | null = null;

  constructor(
    connection: Connection,
    programId: PublicKey,
    vaultAddress: PublicKey
  ) {
    this.connection = connection;
    this.programId = programId;
    this.vaultAddress = vaultAddress;
  }

  /** Load vault from PDA derived from asset mint and vault ID. */
  static fromParams(
    connection: Connection,
    programId: PublicKey,
    assetMint: PublicKey,
    vaultId: BN
  ): ConfidentialStreamingVault {
    const [vaultAddress] = deriveVaultAddress(programId, assetMint, vaultId);
    return new ConfidentialStreamingVault(connection, programId, vaultAddress);
  }

  // ── State Reading ──

  /** Fetch current vault state from on-chain. */
  async getVaultState(): Promise<VaultState> {
    const accountInfo = await this.connection.getAccountInfo(this.vaultAddress);
    if (!accountInfo) throw new Error("Vault account not found");

    // Anchor IDL deserialization would happen here via Program.account
    // For now, return cached or throw
    if (this.cachedState) return this.cachedState;
    throw new Error("Use program.account.confidentialStreamVault.fetch() directly");
  }

  /** Get the shares mint address. */
  getSharesMint(): PublicKey {
    return deriveSharesMintAddress(this.programId, this.vaultAddress)[0];
  }

  /** Get the asset vault ATA address. */
  getAssetVault(assetMint: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(assetMint, this.vaultAddress, true);
  }

  /** Get a user's shares ATA (Token-2022). */
  getUserSharesAccount(user: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.getSharesMint(),
      user,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  }

  // ── Preview / View Operations (Client-Side) ──

  /** Preview a deposit: how many shares for N assets? */
  previewDeposit(state: VaultState, assets: BN): DepositPreview {
    const now = new BN(Math.floor(Date.now() / 1000));
    const totalAssets = effectiveTotalAssets(
      state.baseAssets,
      state.streamAmount,
      state.streamStart,
      state.streamEnd,
      now
    );

    const expectedShares = convertToShares(
      assets,
      totalAssets,
      state.totalShares,
      state.decimalsOffset
    );

    return {
      assets,
      expectedShares,
      effectiveTotalAssets: totalAssets,
      sharePrice: sharePrice(totalAssets, state.totalShares),
    };
  }

  /** Preview a redeem: how many assets for N shares? */
  previewRedeem(state: VaultState, shares: BN): RedeemPreview {
    const now = new BN(Math.floor(Date.now() / 1000));
    const totalAssets = effectiveTotalAssets(
      state.baseAssets,
      state.streamAmount,
      state.streamStart,
      state.streamEnd,
      now
    );

    const expectedAssets = convertToAssets(
      shares,
      totalAssets,
      state.totalShares,
      state.decimalsOffset
    );

    return {
      shares,
      expectedAssets,
      effectiveTotalAssets: totalAssets,
      sharePrice: sharePrice(totalAssets, state.totalShares),
    };
  }

  /** Get streaming yield status. */
  getStreamStatus(state: VaultState): StreamStatus {
    const now = new BN(Math.floor(Date.now() / 1000));
    const isActive =
      !state.streamAmount.isZero() && state.streamEnd.gt(now);

    const accrued = calculateAccrued(
      state.streamAmount,
      state.streamStart,
      state.streamEnd,
      now
    );

    const remaining = state.streamAmount.sub(accrued);
    const total = effectiveTotalAssets(
      state.baseAssets,
      state.streamAmount,
      state.streamStart,
      state.streamEnd,
      now
    );

    const duration = state.streamEnd.sub(state.streamStart);
    const elapsed = BN.max(now.sub(state.streamStart), new BN(0));
    const percentComplete = duration.isZero()
      ? 100
      : Math.min(100, elapsed.muln(100).div(duration).toNumber());

    return {
      isActive,
      baseAssets: state.baseAssets,
      streamAmount: state.streamAmount,
      accrued,
      remaining,
      effectiveTotalAssets: total,
      streamStartTimestamp: state.streamStart,
      streamEndTimestamp: state.streamEnd,
      lastCheckpointTimestamp: state.lastCheckpoint,
      percentComplete,
    };
  }
}
