import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import * as math from "./math";

const SOL_VAULT_SEED = Buffer.from("sol_vault");
const SHARES_MINT_SEED = Buffer.from("shares");

export type BalanceModelInput = "live" | "stored";

export interface SolVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  wsolVault: PublicKey;
  totalAssets: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  balanceModel: unknown;
}

export interface CreateSolVaultParams {
  vaultId: BN | number;
  name: string;
  symbol: string;
  uri: string;
  balanceModel?: BalanceModelInput;
}

export interface SolDepositParams {
  assets: BN;
  minSharesOut: BN;
}

export interface SolMintParams {
  shares: BN;
  maxAssetsIn: BN;
}

export interface SolWithdrawParams {
  assets: BN;
  maxSharesIn: BN;
}

export interface SolRedeemParams {
  shares: BN;
  minAssetsOut: BN;
}

function balanceModelArg(model: BalanceModelInput): { live: {} } | { stored: {} } {
  return model === "stored" ? { stored: {} } : { live: {} };
}

function isStoredModel(model: unknown): boolean {
  if (!model || typeof model !== "object") {
    return false;
  }
  return "stored" in (model as Record<string, unknown>);
}

export function deriveNativeSolVaultAddresses(
  programId: PublicKey,
  vaultId: BN | number,
): {
  vault: PublicKey;
  vaultBump: number;
  sharesMint: PublicKey;
  sharesMintBump: number;
  wsolVault: PublicKey;
} {
  const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [SOL_VAULT_SEED, id.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  const [sharesMint, sharesMintBump] = PublicKey.findProgramAddressSync(
    [SHARES_MINT_SEED, vault.toBuffer()],
    programId,
  );
  const wsolVault = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    vault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  return { vault, vaultBump, sharesMint, sharesMintBump, wsolVault };
}

export class NativeSolVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly wsolVault: PublicKey;
  readonly vaultId: BN;

  private _state: SolVaultState | null = null;

  private constructor(
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

  static async load(program: Program, vaultId: BN | number): Promise<NativeSolVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveNativeSolVaultAddresses(program.programId, id);
    const vault = new NativeSolVault(
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

  static async create(
    program: Program,
    params: CreateSolVaultParams,
  ): Promise<NativeSolVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveNativeSolVaultAddresses(program.programId, id);

    await program.methods
      .initialize(
        id,
        params.name,
        params.symbol,
        params.uri,
        balanceModelArg(params.balanceModel ?? "live"),
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault: addresses.vault,
        wsolMint: NATIVE_MINT,
        sharesMint: addresses.sharesMint,
        wsolVault: addresses.wsolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return NativeSolVault.load(program, id);
  }

  async refresh(): Promise<SolVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["solVault"].fetch(this.vault)) as SolVaultState;
    return this._state;
  }

  async getState(): Promise<SolVaultState> {
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

  getUserWsolAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      NATIVE_MINT,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async depositSol(user: PublicKey, params: SolDepositParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .depositSol(params.assets, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async depositWsol(user: PublicKey, params: SolDepositParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    const userWsolAccount = this.getUserWsolAccount(user);

    return this.program.methods
      .depositWsol(params.assets, params.minSharesOut)
      .accountsStrict({
        user,
        vault: this.vault,
        userWsolAccount,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async mintSol(user: PublicKey, params: SolMintParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .mintSol(params.shares, params.maxAssetsIn)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async withdrawWsol(user: PublicKey, params: SolWithdrawParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    const userWsolAccount = this.getUserWsolAccount(user);

    return this.program.methods
      .withdrawWsol(params.assets, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        userWsolAccount,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async withdrawSol(user: PublicKey, params: SolWithdrawParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    const tempWsolAccount = Keypair.generate();

    return this.program.methods
      .withdrawSol(params.assets, params.maxSharesIn)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        tempWsolAccount: tempWsolAccount.publicKey,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([tempWsolAccount])
      .rpc();
  }

  async redeemWsol(user: PublicKey, params: SolRedeemParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    const userWsolAccount = this.getUserWsolAccount(user);

    return this.program.methods
      .redeemWsol(params.shares, params.minAssetsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        userWsolAccount,
        wsolVault: this.wsolVault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async redeemSol(user: PublicKey, params: SolRedeemParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(user);
    const tempWsolAccount = Keypair.generate();

    return this.program.methods
      .redeemSol(params.shares, params.minAssetsOut)
      .accountsStrict({
        user,
        vault: this.vault,
        wsolMint: NATIVE_MINT,
        wsolVault: this.wsolVault,
        tempWsolAccount: tempWsolAccount.publicKey,
        sharesMint: this.sharesMint,
        userSharesAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([tempWsolAccount])
      .rpc();
  }

  async sync(authority: PublicKey): Promise<string> {
    return this.program.methods
      .sync()
      .accountsStrict({
        authority,
        vault: this.vault,
        wsolVault: this.wsolVault,
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

    if (isStoredModel(state.balanceModel)) {
      return state.totalAssets;
    }

    const account = await getAccount(
      this.provider.connection,
      this.wsolVault,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    return new BN(account.amount.toString());
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

  async previewMint(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalShares = await this.totalShares();
    return math.previewMint(
      shares,
      totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }

  async previewRedeem(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const totalAssets = await this.totalAssets();
    const totalShares = await this.totalShares();
    return math.previewRedeem(
      shares,
      totalAssets,
      totalShares,
      state.decimalsOffset,
    );
  }
}
