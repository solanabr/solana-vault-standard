// clearing/**
 * SVS-8 Multi-Asset Basket Vault — TypeScript SDK
 *
 * Provides a fully-typed client for interacting with the SVS-8 on-chain program.
 * Handles PDA derivation, instruction building, oracle account resolution,
 * and all basket vault operations.
 *
 * @example
 * ```ts
 * import { BasketVault } from "@stbr/solana-vault";
 * import { BN } from "@coral-xyz/anchor";
 *
 * const basket = await BasketVault.load(program, new BN(800_001));
 *
 * await basket.addAsset(authority, {
 *   assetMint: usdcMint,
 *   oracle: pythUsdcFeed,
 *   targetWeightBps: 6000,
 * });
 *
 * await basket.depositSingle(user, {
 *   assetMint: usdcMint,
 *   amount: new BN(1_000_000),
 *   minSharesOut: new BN(0),
 *   oracle: pythUsdcFeed,
 *   basketAssets: allAssetInfos,
 * });
 * ```
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Signer,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionSignature,
  AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of assets in a basket vault (matches on-chain MAX_ASSETS). */
export const MAX_BASKET_ASSETS = 8;

/** Total weight in basis points representing 100% allocation. */
export const TOTAL_WEIGHT_BPS = 10_000;

/** SVS-8 program ID on devnet. */
export const SVS8_PROGRAM_ID = new PublicKey(
  "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j"
);

// ── PDA derivation ────────────────────────────────────────────────────────────

/**
 * Derives the MultiAssetVault PDA.
 * Seeds: ["multi_vault", vault_id (u64 LE)]
 */
export function multiVaultPda(
  vaultId: BN,
  programId: PublicKey = SVS8_PROGRAM_ID
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(vaultId.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("multi_vault"), buf],
    programId
  );
}

/**
 * Derives the shares mint PDA.
 * Seeds: ["shares_mint", vault_pubkey]
 */
export function basketSharesMintPda(
  vault: PublicKey,
  programId: PublicKey = SVS8_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares_mint"), vault.toBuffer()],
    programId
  );
}

/**
 * Derives the AssetEntry PDA.
 * Seeds: ["asset_entry", vault_pubkey, asset_mint]
 */
export function assetEntryPda(
  vault: PublicKey,
  assetMint: PublicKey,
  programId: PublicKey = SVS8_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_entry"), vault.toBuffer(), assetMint.toBuffer()],
    programId
  );
}

/**
 * Derives the PDA-owned token account for an asset in the basket.
 * Seeds: ["asset_vault", vault_pubkey, asset_mint]
 */
export function assetVaultPda(
  vault: PublicKey,
  assetMint: PublicKey,
  programId: PublicKey = SVS8_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_vault"), vault.toBuffer(), assetMint.toBuffer()],
    programId
  );
}

// ── On-chain account types ────────────────────────────────────────────────────

/** On-chain MultiAssetVault account state. */
export interface MultiAssetVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  totalShares: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  numAssets: number;
  baseDecimals: number;
}

/** On-chain AssetEntry account state. */
export interface AssetEntryState {
  vault: PublicKey;
  assetMint: PublicKey;
  assetVault: PublicKey;
  oracle: PublicKey;
  targetWeightBps: number;
  assetDecimals: number;
  index: number;
  bump: number;
}

// ── Instruction parameter types ───────────────────────────────────────────────

export interface InitializeBasketParams {
  vaultId: BN;
  decimalsOffset?: number;
  idleBufferBps?: number;
}

export interface AddAssetParams {
  assetMint: PublicKey;
  oracle: PublicKey;
  targetWeightBps: number;
  tokenProgram?: PublicKey;
}

export interface UpdateWeightsParams {
  newWeights: number[];
  assetEntries: PublicKey[];
}

export interface DepositSingleParams {
  assetMint: PublicKey;
  amount: BN;
  minSharesOut: BN;
  oracle: PublicKey;
  basketAssets: BasketAssetInfo[];
  userAssetAccount?: PublicKey;
  userSharesAccount?: PublicKey;
  tokenProgram?: PublicKey;
}

export interface DepositProportionalParams {
  baseAmount: BN;
  minSharesOut: BN;
  basketAssets: BasketAssetInfoWithUser[];
  userSharesAccount?: PublicKey;
  tokenProgram?: PublicKey;
}

export interface RedeemSingleParams {
  shares: BN;
  assetIndex: number;
  assetMint: PublicKey;
  minAmountOut: BN;
  oracle: PublicKey;
  basketAssets: BasketAssetInfo[];
  userAssetAccount?: PublicKey;
  userSharesAccount?: PublicKey;
  tokenProgram?: PublicKey;
}

export interface RedeemProportionalParams {
  shares: BN;
  minValuesOut: BN[];
  basketAssets: BasketAssetInfoWithUser[];
  userSharesAccount?: PublicKey;
  tokenProgram?: PublicKey;
}

export interface RebalanceParams {
  fromAssetMint: PublicKey;
  toAssetMint: PublicKey;
  routeData: Buffer;
  minimumOut: BN;
  jupiterProgram: PublicKey;
  routeAccounts?: AccountMeta[];
  tokenProgram?: PublicKey;
}

/** Per-asset info for remaining_accounts in read operations. */
export interface BasketAssetInfo {
  assetMint: PublicKey;
  oracle: PublicKey;
}

/** Per-asset info including user token account for deposit/redeem. */
export interface BasketAssetInfoWithUser extends BasketAssetInfo {
  userTokenAccount: PublicKey;
}

// ── BasketVault class ─────────────────────────────────────────────────────────

/**
 * Client for the SVS-8 Multi-Asset Basket Vault program.
 */
export class BasketVault {
  public state: MultiAssetVaultState;
  public assets: AssetEntryState[] = [];

  private constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly program: Program<any>,
    public readonly vaultPubkey: PublicKey,
    public readonly sharesMint: PublicKey,
    public readonly vaultId: BN,
    state: MultiAssetVaultState
  ) {
    this.state = state;
  }

  // ── Factory methods ──────────────────────────────────────────────────────

  static async load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program: Program<any>,
    vaultId: BN
  ): Promise<BasketVault> {
    const [vault] = multiVaultPda(vaultId, program.programId);
    const [sharesMint] = basketSharesMintPda(vault, program.programId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (await (program.account as any).multiAssetVault.fetch(
      vault
    )) as MultiAssetVaultState;
    const instance = new BasketVault(program, vault, sharesMint, vaultId, state);
    await instance.reloadAssets();
    return instance;
  }

  static async create(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    program: Program<any>,
    authority: Signer,
    params: InitializeBasketParams
  ): Promise<BasketVault> {
    const [vault] = multiVaultPda(params.vaultId, program.programId);
    const [sharesMint] = basketSharesMintPda(vault, program.programId);

    await program.methods
      .initialize(
        params.vaultId,
        params.decimalsOffset ?? 6,
        params.idleBufferBps ?? 0
      )
      .accounts({
        vault,
        sharesMint,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    return BasketVault.load(program, params.vaultId);
  }

  // ── State refresh ────────────────────────────────────────────────────────

  async reload(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.state = (await (this.program.account as any).multiAssetVault.fetch(
      this.vaultPubkey
    )) as MultiAssetVaultState;
    await this.reloadAssets();
  }

  async reloadAssets(): Promise<void> {
    if (this.state.numAssets === 0) {
      this.assets = [];
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await (this.program.account as any).assetEntry.all([
      {
        memcmp: {
          offset: 8,
          bytes: this.vaultPubkey.toBase58(),
        },
      },
    ]);
    this.assets = all
      .map((a: { account: AssetEntryState }) => a.account)
      .sort((a: AssetEntryState, b: AssetEntryState) => a.index - b.index);
  }

  // ── Admin instructions ───────────────────────────────────────────────────

  async addAsset(
    authority: Signer,
    params: AddAssetParams
  ): Promise<TransactionSignature> {
    const [entry] = assetEntryPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );
    const [vault] = assetVaultPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;

    const remainingAccounts: AccountMeta[] = this.assets.map((a) => {
      const [entryPk] = assetEntryPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      return { pubkey: entryPk, isWritable: false, isSigner: false };
    });

    const sig = await this.program.methods
      .addAsset(params.targetWeightBps)
      .accounts({
        vault: this.vaultPubkey,
        assetMint: params.assetMint,
        oracle: params.oracle,
        assetEntry: entry,
        assetVault: vault,
        authority: authority.publicKey,
        tokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .signers([authority])
      .rpc();

    await this.reload();
    return sig;
  }

  async removeAsset(
    authority: Signer,
    assetMint: PublicKey,
    tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<TransactionSignature> {
    const [entry] = assetEntryPda(
      this.vaultPubkey,
      assetMint,
      this.program.programId
    );
    const [vault] = assetVaultPda(
      this.vaultPubkey,
      assetMint,
      this.program.programId
    );

    const sig = await this.program.methods
      .removeAsset()
      .accounts({
        vault: this.vaultPubkey,
        assetEntry: entry,
        assetVault: vault,
        authority: authority.publicKey,
        tokenProgram,
      })
      .signers([authority])
      .rpc();

    await this.reload();
    return sig;
  }

  async updateWeights(
    authority: Signer,
    params: UpdateWeightsParams
  ): Promise<TransactionSignature> {
    const remainingAccounts: AccountMeta[] = params.assetEntries.map((pk) => ({
      pubkey: pk,
      isWritable: true,
      isSigner: false,
    }));

    const sig = await this.program.methods
      .updateWeights(params.newWeights)
      .accounts({
        vault: this.vaultPubkey,
        authority: authority.publicKey,
      })
      .remainingAccounts(remainingAccounts)
      .signers([authority])
      .rpc();

    await this.reload();
    return sig;
  }

  async pause(authority: Signer): Promise<TransactionSignature> {
    const sig = await this.program.methods
      .pause()
      .accounts({ vault: this.vaultPubkey, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    await this.reload();
    return sig;
  }

  async unpause(authority: Signer): Promise<TransactionSignature> {
    const sig = await this.program.methods
      .unpause()
      .accounts({ vault: this.vaultPubkey, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    await this.reload();
    return sig;
  }

  async transferAuthority(
    authority: Signer,
    newAuthority: PublicKey
  ): Promise<TransactionSignature> {
    const sig = await this.program.methods
      .transferAuthority(newAuthority)
      .accounts({ vault: this.vaultPubkey, authority: authority.publicKey })
      .signers([authority])
      .rpc();
    await this.reload();
    return sig;
  }

  // ── User instructions ────────────────────────────────────────────────────

  async depositSingle(
    user: Signer,
    params: DepositSingleParams
  ): Promise<TransactionSignature> {
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
    const [entry] = assetEntryPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );
    const [vault] = assetVaultPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );

    const userAssetAccount =
      params.userAssetAccount ??
      getAssociatedTokenAddressSync(
        params.assetMint,
        user.publicKey,
        false,
        tokenProgram
      );
    const userSharesAccount =
      params.userSharesAccount ??
      getAssociatedTokenAddressSync(
        this.sharesMint,
        user.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

    const remainingAccounts = this._buildValueRemainingAccounts(params.basketAssets);

    return this.program.methods
      .depositSingle(params.amount, params.minSharesOut)
      .accounts({
        vault: this.vaultPubkey,
        assetEntry: entry,
        assetVault: vault,
        userAssetAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        user: user.publicKey,
        oracle: params.oracle,
        tokenProgram,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  async depositProportional(
    user: Signer,
    params: DepositProportionalParams
  ): Promise<TransactionSignature> {
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
    const userSharesAccount =
      params.userSharesAccount ??
      getAssociatedTokenAddressSync(
        this.sharesMint,
        user.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

    const remainingAccounts = this._buildProportionalRemainingAccounts(params.basketAssets);

    return this.program.methods
      .depositProportional(params.baseAmount, params.minSharesOut)
      .accounts({
        vault: this.vaultPubkey,
        sharesMint: this.sharesMint,
        userSharesAccount,
        user: user.publicKey,
        tokenProgram,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  async redeemSingle(
    user: Signer,
    params: RedeemSingleParams
  ): Promise<TransactionSignature> {
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
    const [entry] = assetEntryPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );
    const [vault] = assetVaultPda(
      this.vaultPubkey,
      params.assetMint,
      this.program.programId
    );

    const userAssetAccount =
      params.userAssetAccount ??
      getAssociatedTokenAddressSync(
        params.assetMint,
        user.publicKey,
        false,
        tokenProgram
      );
    const userSharesAccount =
      params.userSharesAccount ??
      getAssociatedTokenAddressSync(
        this.sharesMint,
        user.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

    const remainingAccounts = this._buildValueRemainingAccounts(params.basketAssets);

    return this.program.methods
      .redeemSingle(params.shares, params.assetIndex, params.minAmountOut)
      .accounts({
        vault: this.vaultPubkey,
        assetEntry: entry,
        assetVault: vault,
        userAssetAccount,
        sharesMint: this.sharesMint,
        userSharesAccount,
        user: user.publicKey,
        oracle: params.oracle,
        tokenProgram,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  async redeemProportional(
    user: Signer,
    params: RedeemProportionalParams
  ): Promise<TransactionSignature> {
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
    const userSharesAccount =
      params.userSharesAccount ??
      getAssociatedTokenAddressSync(
        this.sharesMint,
        user.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

    const remainingAccounts = this._buildProportionalRemainingAccounts(params.basketAssets);

    return this.program.methods
      .redeemProportional(params.shares, params.minValuesOut)
      .accounts({
        vault: this.vaultPubkey,
        sharesMint: this.sharesMint,
        userSharesAccount,
        user: user.publicKey,
        tokenProgram,
      })
      .remainingAccounts(remainingAccounts)
      .signers([user])
      .rpc();
  }

  async rebalance(
    authority: Signer,
    params: RebalanceParams
  ): Promise<TransactionSignature> {
    const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
    const [fromVault] = assetVaultPda(
      this.vaultPubkey,
      params.fromAssetMint,
      this.program.programId
    );
    const [toVault] = assetVaultPda(
      this.vaultPubkey,
      params.toAssetMint,
      this.program.programId
    );

    return this.program.methods
      .rebalance(params.routeData, params.minimumOut)
      .accounts({
        vault: this.vaultPubkey,
        authority: authority.publicKey,
        fromAssetVault: fromVault,
        toAssetVault: toVault,
        fromAssetMint: params.fromAssetMint,
        toAssetMint: params.toAssetMint,
        jupiterProgram: params.jupiterProgram,
        tokenProgram,
      })
      .remainingAccounts(params.routeAccounts ?? [])
      .signers([authority])
      .rpc();
  }

  // ── View helpers ─────────────────────────────────────────────────────────

  getAssetEntryPubkeys(): PublicKey[] {
    return this.assets.map((a) => {
      const [entry] = assetEntryPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      return entry;
    });
  }

  getAssetPdas(): { entry: PublicKey; vault: PublicKey; mint: PublicKey }[] {
    return this.assets.map((a) => {
      const [entry] = assetEntryPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      const [vault] = assetVaultPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      return { entry, vault, mint: a.assetMint };
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Build remaining_accounts: [AssetEntry, asset_vault, oracle] × num_assets */
  private _buildValueRemainingAccounts(
    basketAssets: BasketAssetInfo[]
  ): AccountMeta[] {
    const accounts: AccountMeta[] = [];
    for (const a of basketAssets) {
      const [entry] = assetEntryPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      const [vault] = assetVaultPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      accounts.push({ pubkey: entry, isWritable: false, isSigner: false });
      accounts.push({ pubkey: vault, isWritable: false, isSigner: false });
      accounts.push({ pubkey: a.oracle, isWritable: false, isSigner: false });
    }
    return accounts;
  }

  /** Build remaining_accounts: [AssetEntry, asset_vault, oracle, user_token] × num_assets */
  private _buildProportionalRemainingAccounts(
    basketAssets: BasketAssetInfoWithUser[]
  ): AccountMeta[] {
    const accounts: AccountMeta[] = [];
    for (const a of basketAssets) {
      const [entry] = assetEntryPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      const [vault] = assetVaultPda(
        this.vaultPubkey,
        a.assetMint,
        this.program.programId
      );
      accounts.push({ pubkey: entry, isWritable: false, isSigner: false });
      accounts.push({ pubkey: vault, isWritable: true, isSigner: false });
      accounts.push({ pubkey: a.oracle, isWritable: false, isSigner: false });
      accounts.push({ pubkey: a.userTokenAccount, isWritable: true, isSigner: false });
    }
    return accounts;
  }
}

// ── Standalone utility functions ──────────────────────────────────────────────

/** Validate that weights sum to exactly 10,000 bps. */
export function validateBasketWeights(weights: number[]): boolean {
  if (weights.length === 0 || weights.length > MAX_BASKET_ASSETS) return false;
  return weights.reduce((s, w) => s + w, 0) === TOTAL_WEIGHT_BPS;
}

/**
 * Preview shares for a single-asset deposit (off-chain estimate).
 * Matches on-chain convert_to_shares formula.
 */
export function previewDepositShares(
  depositValue: BN,
  totalShares: BN,
  totalPortfolioValue: BN,
  decimalsOffset: number
): BN {
  const offset = new BN(10).pow(new BN(decimalsOffset));
  const numerator = depositValue.mul(totalShares.add(offset));
  const denominator = totalPortfolioValue.addn(1);
  if (denominator.isZero()) return new BN(0);
  return numerator.div(denominator);
}

/**
 * Preview assets for a share redemption (off-chain estimate).
 * Matches on-chain convert_to_assets formula.
 */
export function previewRedeemAssets(
  shares: BN,
  totalShares: BN,
  totalPortfolioValue: BN,
  decimalsOffset: number
): BN {
  const offset = new BN(10).pow(new BN(decimalsOffset));
  const numerator = shares.mul(totalPortfolioValue.addn(1));
  const denominator = totalShares.add(offset);
  if (denominator.isZero()) return new BN(0);
  return numerator.div(denominator);
}
