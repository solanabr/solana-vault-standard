/**
 * Multi-Asset Vault SDK (SVS-8)
 *
 * Standalone SDK class for the SVS-8 on-chain program.
 * Manages a single vault holding multiple SPL token assets with
 * oracle-based pricing and weighted portfolio allocation.
 *
 * PDA seeds:
 * - Vault: ["multi_vault", vault_id (u64 LE)]
 * - Shares: ["shares", vault_pubkey]
 * - AssetEntry: ["asset_entry", vault_pubkey, asset_mint]
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const MULTI_VAULT_SEED = Buffer.from("multi_vault");
const SHARES_SEED = Buffer.from("shares");
const ASSET_ENTRY_SEED = Buffer.from("asset_entry");

export interface MultiAssetVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  numAssets: number;
  baseDecimals: number;
}

export interface AssetEntryState {
  vault: PublicKey;
  assetMint: PublicKey;
  assetVault: PublicKey;
  oracle: PublicKey;
  oracleType: number;
  targetWeightBps: number;
  assetDecimals: number;
  index: number;
  bump: number;
}

export interface AssetInfo {
  entry: PublicKey;
  vault: PublicKey;
  oracle: PublicKey;
  mint: PublicKey;
  userAta: PublicKey;
  tokenProgram: PublicKey;
}

export class MultiAssetVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly vaultId: BN;

  private _state: MultiAssetVaultState | null = null;

  private constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    sharesMint: PublicKey,
    vaultId: BN,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.sharesMint = sharesMint;
    this.vaultId = vaultId;
  }

  // ============ PDA Helpers ============

  static getVaultAddress(
    programId: PublicKey,
    vaultId: BN | number,
  ): [PublicKey, number] {
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    return PublicKey.findProgramAddressSync(
      [MULTI_VAULT_SEED, id.toArrayLike(Buffer, "le", 8)],
      programId,
    );
  }

  static getSharesMintAddress(
    programId: PublicKey,
    vault: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [SHARES_SEED, vault.toBuffer()],
      programId,
    );
  }

  static getAssetEntryAddress(
    programId: PublicKey,
    vault: PublicKey,
    assetMint: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [ASSET_ENTRY_SEED, vault.toBuffer(), assetMint.toBuffer()],
      programId,
    );
  }

  // ============ Static Factories ============

  static async load(
    program: Program,
    vaultId: BN | number,
  ): Promise<MultiAssetVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const [vault] = MultiAssetVault.getVaultAddress(program.programId, id);
    const [sharesMint] = MultiAssetVault.getSharesMintAddress(
      program.programId,
      vault,
    );

    const instance = new MultiAssetVault(
      program,
      provider,
      vault,
      sharesMint,
      id,
    );
    await instance.refresh();
    return instance;
  }

  static async create(
    program: Program,
    vaultId: BN | number,
    baseDecimals: number,
  ): Promise<MultiAssetVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const [vault] = MultiAssetVault.getVaultAddress(program.programId, id);
    const [sharesMint] = MultiAssetVault.getSharesMintAddress(
      program.programId,
      vault,
    );

    await program.methods
      .initialize(id, baseDecimals)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault,
        sharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const instance = new MultiAssetVault(
      program,
      provider,
      vault,
      sharesMint,
      id,
    );
    await instance.refresh();
    return instance;
  }

  // ============ State ============

  get state(): MultiAssetVaultState {
    if (!this._state) throw new Error("Vault not loaded — call refresh()");
    return this._state;
  }

  async refresh(): Promise<MultiAssetVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    const account = (await accountNs["multiAssetVault"].fetch(
      this.vault,
    )) as MultiAssetVaultState;
    this._state = {
      authority: account.authority,
      sharesMint: account.sharesMint,
      decimalsOffset: account.decimalsOffset,
      bump: account.bump,
      paused: account.paused,
      vaultId: account.vaultId,
      numAssets: account.numAssets,
      baseDecimals: account.baseDecimals,
    };
    return this._state;
  }

  async getAssetEntries(): Promise<AssetEntryState[]> {
    const accountNs = this.program.account as Record<
      string,
      { all: (filters?: unknown[]) => Promise<{ account: unknown }[]> }
    >;
    const accounts = await accountNs["assetEntry"].all([
      { memcmp: { offset: 8, bytes: this.vault.toBase58() } },
    ]);
    return accounts
      .map((a) => {
        const acct = a.account as Record<string, unknown>;
        return {
          vault: acct.vault as PublicKey,
          assetMint: acct.assetMint as PublicKey,
          assetVault: acct.assetVault as PublicKey,
          oracle: acct.oracle as PublicKey,
          oracleType: acct.oracleType as number,
          targetWeightBps: acct.targetWeightBps as number,
          assetDecimals: acct.assetDecimals as number,
          index: acct.index as number,
          bump: acct.bump as number,
        };
      })
      .sort((a, b) => a.index - b.index);
  }

  // ============ Admin Operations ============

  async addAsset(
    assetMint: PublicKey,
    oracle: PublicKey,
    weightBps: number,
    oracleType: number,
    assetTokenProgram: PublicKey,
    existingEntries: PublicKey[] = [],
  ): Promise<string> {
    const [assetEntry] = MultiAssetVault.getAssetEntryAddress(
      this.program.programId,
      this.vault,
      assetMint,
    );
    const assetVault = getAssociatedTokenAddressSync(
      assetMint,
      this.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    return this.program.methods
      .addAsset(weightBps, oracleType)
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
        assetMint,
        oracle,
        assetEntry,
        assetVault,
        assetTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        existingEntries.map((e) => ({
          pubkey: e,
          isSigner: false,
          isWritable: false,
        })),
      )
      .rpc();
  }

  async removeAsset(
    assetEntry: PublicKey,
    assetVault: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .removeAsset()
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
        assetEntry,
        assetVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async updateWeights(
    newWeights: number[],
    entries: PublicKey[],
  ): Promise<string> {
    return this.program.methods
      .updateWeights(newWeights)
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
      })
      .remainingAccounts(
        entries.map((e) => ({
          pubkey: e,
          isSigner: false,
          isWritable: true,
        })),
      )
      .rpc();
  }

  async pause(): Promise<string> {
    return this.program.methods
      .pause()
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
      })
      .rpc();
  }

  async unpause(): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
      })
      .rpc();
  }

  async transferAuthority(newAuthority: PublicKey): Promise<string> {
    return this.program.methods
      .transferAuthority(newAuthority)
      .accountsStrict({
        authority: this.provider.wallet.publicKey,
        vault: this.vault,
      })
      .rpc();
  }

  // ============ User Operations ============

  async depositSingle(
    assetMint: PublicKey,
    amount: BN,
    minSharesOut: BN,
    assetTokenProgram: PublicKey,
    allAssetInfos: AssetInfo[],
  ): Promise<string> {
    const [assetEntry] = MultiAssetVault.getAssetEntryAddress(
      this.program.programId,
      this.vault,
      assetMint,
    );
    const assetVault = getAssociatedTokenAddressSync(
      assetMint,
      this.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userDepositAccount = getAssociatedTokenAddressSync(
      assetMint,
      this.provider.wallet.publicKey,
      false,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      this.provider.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    return this.program.methods
      .depositSingle(amount, minSharesOut)
      .accountsStrict({
        user: this.provider.wallet.publicKey,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        depositAssetMint: assetMint,
        depositAssetEntry: assetEntry,
        depositAssetVault: assetVault,
        userDepositAccount,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(MultiAssetVault.buildOracleRemaining(allAssetInfos))
      .rpc();
  }

  async redeemSingle(
    assetMint: PublicKey,
    shares: BN,
    minAmountOut: BN,
    assetTokenProgram: PublicKey,
  ): Promise<string> {
    const [assetEntry] = MultiAssetVault.getAssetEntryAddress(
      this.program.programId,
      this.vault,
      assetMint,
    );
    const assetVault = getAssociatedTokenAddressSync(
      assetMint,
      this.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userRedeemAccount = getAssociatedTokenAddressSync(
      assetMint,
      this.provider.wallet.publicKey,
      false,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      this.provider.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    return this.program.methods
      .redeemSingle(shares, minAmountOut)
      .accountsStrict({
        user: this.provider.wallet.publicKey,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        redeemAssetMint: assetMint,
        redeemAssetEntry: assetEntry,
        redeemAssetVault: assetVault,
        userRedeemAccount,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  // ============ Remaining Accounts Builders ============

  static buildOracleRemaining(infos: AssetInfo[]) {
    return infos.flatMap((i) => [
      { pubkey: i.entry, isSigner: false, isWritable: false },
      { pubkey: i.vault, isSigner: false, isWritable: false },
      { pubkey: i.oracle, isSigner: false, isWritable: false },
    ]);
  }

  static buildDepositProportionalRemaining(infos: AssetInfo[]) {
    return infos.flatMap((i) => [
      { pubkey: i.entry, isSigner: false, isWritable: false },
      { pubkey: i.vault, isSigner: false, isWritable: true },
      { pubkey: i.oracle, isSigner: false, isWritable: false },
      { pubkey: i.mint, isSigner: false, isWritable: false },
      { pubkey: i.userAta, isSigner: false, isWritable: true },
      { pubkey: i.tokenProgram, isSigner: false, isWritable: false },
    ]);
  }

  static buildRedeemProportionalRemaining(infos: AssetInfo[]) {
    return infos.flatMap((i) => [
      { pubkey: i.entry, isSigner: false, isWritable: false },
      { pubkey: i.vault, isSigner: false, isWritable: true },
      { pubkey: i.mint, isSigner: false, isWritable: false },
      { pubkey: i.userAta, isSigner: false, isWritable: true },
      { pubkey: i.tokenProgram, isSigner: false, isWritable: false },
    ]);
  }

  // ============ View Helpers (Off-chain) ============

  totalPortfolioValue(balances: BN[], prices: BN[], decimals: number[]): BN {
    let total = new BN(0);
    for (let i = 0; i < balances.length; i++) {
      const divisor = new BN(10).pow(new BN(decimals[i]));
      const value = balances[i].mul(prices[i]).div(divisor);
      total = total.add(value);
    }
    return total;
  }

  previewDeposit(
    amount: BN,
    assetPrice: BN,
    assetDecimals: number,
    totalValue: BN,
    totalShares: BN,
  ): BN {
    const divisor = new BN(10).pow(new BN(assetDecimals));
    const depositValue = amount.mul(assetPrice).div(divisor);

    const offset = new BN(10).pow(new BN(this.state.decimalsOffset));
    const virtualShares = totalShares.add(offset);
    const virtualValue = totalValue.add(new BN(1));

    return depositValue.mul(virtualShares).div(virtualValue);
  }

  previewRedeemSingle(shares: BN, assetBalance: BN, totalShares: BN): BN {
    if (totalShares.isZero()) return new BN(0);
    return shares.mul(assetBalance).div(totalShares);
  }
}
