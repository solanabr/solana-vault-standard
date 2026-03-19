import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import * as math from "./math";

const NATIVE_SOL_STREAM_VAULT_SEED = Buffer.from("native_sol_stream_vault");
const SHARES_MINT_SEED = Buffer.from("shares");

export interface NativeSolStreamVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  baseAssets: BN;
  totalShares: BN;
  streamAmount: BN;
  streamStart: BN;
  streamEnd: BN;
  lastCheckpoint: BN;
}

export interface CreateNativeSolVaultParams {
  vaultId: BN | number;
  name: string;
  symbol: string;
  uri: string;
}

export interface NativeDepositParams {
  assets: BN;
  minSharesOut: BN;
}

export interface NativeMintParams {
  shares: BN;
  maxAssetsIn: BN;
}

export interface NativeWithdrawParams {
  assets: BN;
  maxSharesIn: BN;
}

export interface NativeRedeemParams {
  shares: BN;
  minAssetsOut: BN;
}

export interface NativeDistributeYieldParams {
  yieldAmount: BN;
  durationSeconds: number;
}

export function deriveNativeSolStreamVaultAddresses(
  programId: PublicKey,
  vaultId: BN | number,
): { vault: PublicKey; vaultBump: number; sharesMint: PublicKey; sharesMintBump: number } {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [NATIVE_SOL_STREAM_VAULT_SEED, id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  const [sharesMint, sharesMintBump] = PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
  return { vault, vaultBump, sharesMint, sharesMintBump };
}

export class NativeSolStreamVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly vaultId: BN;

  private _state: NativeSolStreamVaultState | null = null;

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

  static async load(
    program: Program,
    vaultId: BN | number,
  ): Promise<NativeSolStreamVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveNativeSolStreamVaultAddresses(program.programId, id);
    const vault = new NativeSolStreamVault(
      program,
      provider,
      addresses.vault,
      addresses.sharesMint,
      id,
    );
    await vault.refresh();
    return vault;
  }

  static async create(
    program: Program,
    params: CreateNativeSolVaultParams,
  ): Promise<NativeSolStreamVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveNativeSolStreamVaultAddresses(program.programId, id);

    await program.methods
      .initialize(id, params.name, params.symbol, params.uri)
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault: addresses.vault,
        sharesMint: addresses.sharesMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return NativeSolStreamVault.load(program, id);
  }

  async refresh(): Promise<NativeSolStreamVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["nativeSolStreamVault"].fetch(
      this.vault,
    )) as NativeSolStreamVaultState;
    return this._state;
  }

  async getState(): Promise<NativeSolStreamVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  getUserSharesAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async deposit(user: PublicKey, params: NativeDepositParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    return this.program.methods
      .deposit(params.assets, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async mint(user: PublicKey, params: NativeMintParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    return this.program.methods
      .mint(params.shares, params.maxAssetsIn)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async withdraw(user: PublicKey, params: NativeWithdrawParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    return this.program.methods
      .withdraw(params.assets, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async redeem(user: PublicKey, params: NativeRedeemParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    return this.program.methods
      .redeem(params.shares, params.minAssetsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async distributeYield(
    authority: PublicKey,
    params: NativeDistributeYieldParams,
  ): Promise<string> {
    return this.program.methods
      .distributeYield(params.yieldAmount, new BN(params.durationSeconds))
      .accountsStrict({
        vault: this.vault,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async accrueYield(): Promise<string> {
    return this.program.methods
      .accrueYield()
      .accountsStrict({
        vault: this.vault,
      })
      .rpc();
  }

  async totalShares(): Promise<BN> {
    const mint = await getMint(
      this.provider.connection,
      this.sharesMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return new BN(mint.supply.toString());
  }

  async totalAssets(): Promise<BN> {
    const state = await this.getState();
    const now = Math.floor(Date.now() / 1000);
    return this.effectiveTotalAssetsAt(state, now);
  }

  async previewDeposit(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalShares = await this.totalShares();
    return math.previewDeposit(
      assets,
      totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  async previewWithdraw(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalShares = await this.totalShares();
    return math.previewWithdraw(
      assets,
      totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  private effectiveTotalAssetsAt(
    state: NativeSolStreamVaultState,
    nowTimestamp: number,
  ): BN {
    const streamStart = state.streamStart.toNumber();
    const streamEnd = state.streamEnd.toNumber();
    if (nowTimestamp >= streamEnd || streamStart >= streamEnd) {
      return state.baseAssets.add(state.streamAmount);
    }
    if (nowTimestamp <= streamStart) {
      return state.baseAssets;
    }

    const elapsed = new BN(nowTimestamp - streamStart);
    const duration = new BN(streamEnd - streamStart);
    const accrued = state.streamAmount.mul(elapsed).div(duration);
    return state.baseAssets.add(accrued);
  }
}
