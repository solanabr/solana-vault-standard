/**
 * Managed Vault Module (SVS-2)
 *
 * Extension of SolanaVault for stored-balance vaults. Unlike SVS-1 which
 * reads the asset vault balance directly, SVS-2 maintains a stored
 * `total_assets` field that is updated via explicit sync operations.
 *
 * This enables:
 * - External yield strategies (assets deployed outside the vault)
 * - Delayed balance updates (gas optimization)
 * - Custom accounting logic
 *
 * @example
 * ```ts
 * import { ManagedVault } from "@stbr/solana-vault";
 *
 * // Load SVS-2 vault
 * const vault = await ManagedVault.load(program, assetMint, 1);
 *
 * // Sync stored balance with actual vault balance
 * await vault.sync(authority);
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
} from "@solana/spl-token";

import {
  SolanaVault,
  CreateVaultParams,
  getTokenProgramForMint,
} from "./vault";
import { deriveVaultAddresses } from "./pda";

/**
 * SVS-2 Managed Vault SDK
 *
 * Extends SolanaVault with sync() for stored-balance vaults.
 * SVS-2 uses vault.total_assets (updated via sync/deposit/withdraw)
 * rather than reading asset_vault.amount directly.
 */
export class ManagedVault extends SolanaVault {
  /**
   * Load an existing SVS-2 vault
   */
  static override async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<ManagedVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveVaultAddresses(program.programId, assetMint, id);

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

    const vault = new ManagedVault(
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
   * Create a new SVS-2 vault
   */
  static override async create(
    program: Program,
    params: CreateVaultParams,
  ): Promise<ManagedVault> {
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

    return ManagedVault.load(program, params.assetMint, id);
  }

  /**
   * Sync total_assets with actual vault balance.
   * Authority-only. Updates the stored balance to match asset_vault.amount.
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

  /**
   * Get stored total_assets from vault account (SVS-2 uses cached balance).
   * For the live on-chain balance, use totalAssets() from the base class.
   */
  async storedTotalAssets(): Promise<BN> {
    const state = await this.refresh();
    return state.totalAssets;
  }
}
