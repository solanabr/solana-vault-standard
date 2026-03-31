/**
 * SVS-7 Native SOL Vault SDK
 *
 * TypeScript client for the SVS-7 (Native SOL) on-chain program.
 * Wraps all instruction calls, PDA derivations, and account resolution.
 *
 * @packageDocumentation
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";

// ============================================================
// Constants
// ============================================================

export const SOL_VAULT_SEED = Buffer.from("sol_vault");
export const SOL_SHARES_MINT_SEED = Buffer.from("shares");

// ============================================================
// PDA Helpers
// ============================================================

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

export function getSolSharesMintAddress(
  programId: PublicKey,
  solVault: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SOL_SHARES_MINT_SEED, solVault.toBuffer()],
    programId,
  );
}

export function deriveSolVaultAddresses(
  programId: PublicKey,
  vaultId: BN | number,
) {
  const [solVault, vaultBump] = getSolVaultAddress(programId, vaultId);
  const [sharesMint, sharesBump] = getSolSharesMintAddress(programId, solVault);
  const wsolVault = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    solVault,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { solVault, vaultBump, sharesMint, sharesBump, wsolVault };
}

// ============================================================
// State Interfaces
// ============================================================

export interface SolVaultState {
  authority: PublicKey;
  sharesMint: PublicKey;
  wsolVault: PublicKey;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
}

// ============================================================
// Instruction Parameter Interfaces
// ============================================================

export interface DepositSolParams {
  lamports: BN;
  minSharesOut: BN;
}

export interface MintSolParams {
  shares: BN;
  maxLamportsIn: BN;
}

export interface WithdrawSolParams {
  lamports: BN;
  maxSharesIn: BN;
}

export interface RedeemSolParams {
  shares: BN;
  minLamportsOut: BN;
}

export interface DepositWsolParams {
  amount: BN;
  minSharesOut: BN;
  userWsolAccount: PublicKey;
}

export interface MintWsolParams {
  shares: BN;
  maxAmountIn: BN;
  userWsolAccount: PublicKey;
}

export interface WithdrawWsolParams {
  lamports: BN;
  maxSharesIn: BN;
  userWsolAccount: PublicKey;
}

export interface RedeemWsolParams {
  shares: BN;
  minAssetsOut: BN;
  userWsolAccount: PublicKey;
}

// ============================================================
// Main Client Class
// ============================================================

export class NativeSolVaultClient {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;
  readonly solVault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly wsolVault: PublicKey;
  readonly vaultId: BN;

  private _state: SolVaultState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    solVault: PublicKey,
    sharesMint: PublicKey,
    wsolVault: PublicKey,
    vaultId: BN,
  ) {
    this.program = program;
    this.provider = provider;
    this.programId = program.programId;
    this.solVault = solVault;
    this.sharesMint = sharesMint;
    this.wsolVault = wsolVault;
    this.vaultId = vaultId;
  }

  // ─── Factory Methods ───────────────────────────────────────

  static async load(
    program: Program,
    vaultId: BN | number,
  ): Promise<NativeSolVaultClient> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const { solVault, sharesMint, wsolVault } = deriveSolVaultAddresses(
      program.programId,
      id,
    );

    const client = new NativeSolVaultClient(
      program,
      provider,
      solVault,
      sharesMint,
      wsolVault,
      id,
    );

    await client.refresh();
    return client;
  }

  static async create(
    program: Program,
    vaultId: BN | number,
  ): Promise<NativeSolVaultClient> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const { solVault, sharesMint, wsolVault } = deriveSolVaultAddresses(
      program.programId,
      id,
    );

    const methodsNs = program.methods as any;
    await methodsNs
      .initialize(id)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        vault: solVault,
        sharesMint,
        wsolVault,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return NativeSolVaultClient.load(program, id);
  }

  // ─── State Management ──────────────────────────────────────

  async refresh(): Promise<SolVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["solVault"].fetch(
      this.solVault,
    )) as SolVaultState;
    return this._state;
  }

  async getState(): Promise<SolVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  // ─── Native SOL Operations ─────────────────────────────────

  async depositSol(params: DepositSolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .depositSol(params.lamports, params.minSharesOut)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async mintSol(params: MintSolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .mintSol(params.shares, params.maxLamportsIn)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async withdrawSol(params: WithdrawSolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .withdrawSol(params.lamports, params.maxSharesIn)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async redeemSol(params: RedeemSolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .redeemSol(params.shares, params.minLamportsOut)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ─── wSOL Operations ──────────────────────────────────────

  async depositWsol(params: DepositWsolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .depositWsol(params.amount, params.minSharesOut)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userWsolAccount: params.userWsolAccount,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async mintWsol(params: MintWsolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .mintWsol(params.shares, params.maxAmountIn)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userWsolAccount: params.userWsolAccount,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async withdrawWsol(params: WithdrawWsolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .withdrawWsol(params.lamports, params.maxSharesIn)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userWsolAccount: params.userWsolAccount,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async redeemWsol(params: RedeemWsolParams): Promise<string> {
    const userSharesAccount = this.getUserSharesAccount(
      this.provider.wallet.publicKey,
    );
    const methodsNs = this.program.methods as any;
    return methodsNs
      .redeemWsol(params.shares, params.minAssetsOut)
      .accountsPartial({
        user: this.provider.wallet.publicKey,
        vault: this.solVault,
        sharesMint: this.sharesMint,
        wsolVault: this.wsolVault,
        userWsolAccount: params.userWsolAccount,
        userSharesAccount,
        wsolMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ─── Admin Operations ──────────────────────────────────────

  async pause(): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .pause()
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        vault: this.solVault,
      })
      .rpc();
  }

  async unpause(): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .unpause()
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        vault: this.solVault,
      })
      .rpc();
  }

  async transferAuthority(newAuthority: PublicKey): Promise<string> {
    const methodsNs = this.program.methods as any;
    return methodsNs
      .transferAuthority(newAuthority)
      .accountsPartial({
        authority: this.provider.wallet.publicKey,
        vault: this.solVault,
      })
      .rpc();
  }

  // ─── View / Preview Methods ────────────────────────────────

  private viewAccounts() {
    return {
      vault: this.solVault,
      wsolVault: this.wsolVault,
      sharesMint: this.sharesMint,
    };
  }

  async previewDeposit(assets: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .previewDeposit(assets)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async previewMint(shares: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .previewMint(shares)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async previewWithdraw(assets: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .previewWithdraw(assets)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async previewRedeem(shares: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .previewRedeem(shares)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async convertToShares(assets: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .convertToShares(assets)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async convertToAssets(shares: BN): Promise<BN> {
    const sim: any = await this.program.methods
      .convertToAssets(shares)
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async totalAssets(): Promise<BN> {
    const sim: any = await this.program.methods
      .totalAssets()
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async maxDeposit(): Promise<BN> {
    const sim: any = await this.program.methods
      .maxDeposit()
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async maxMint(): Promise<BN> {
    const sim: any = await this.program.methods
      .maxMint()
      .accounts(this.viewAccounts() as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async maxWithdraw(owner: PublicKey): Promise<BN> {
    const sim: any = await this.program.methods
      .maxWithdraw()
      .accounts({
        ...this.viewAccounts(),
        ownerSharesAccount: this.getUserSharesAccount(owner),
      } as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  async maxRedeem(owner: PublicKey): Promise<BN> {
    const sim: any = await this.program.methods
      .maxRedeem()
      .accounts({
        ...this.viewAccounts(),
        ownerSharesAccount: this.getUserSharesAccount(owner),
      } as any)
      .simulate();
    return this.parseReturnData(sim);
  }

  // ─── Helpers ───────────────────────────────────────────────

  getUserSharesAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  async getWsolBalance(): Promise<BN> {
    const account = await getAccount(
      this.provider.connection,
      this.wsolVault,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    return new BN(account.amount.toString());
  }

  async isPaused(): Promise<boolean> {
    const state = await this.refresh();
    return state.paused;
  }

  private parseReturnData(sim: any): BN {
    const returnData = sim.returnData || sim.returnValue;
    if (!returnData) throw new Error("No return data from view call");
    const buf = Buffer.from(returnData, "base64");
    return new BN(buf, "le");
  }
}
