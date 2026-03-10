import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  deriveAsyncVaultAddresses,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
  getShareEscrowAddress,
} from "./async-vault-pda";
import { getTokenProgramForMint } from "./vault";

export interface AsyncVaultState {
  authority: PublicKey;
  operator: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  vaultId: BN;
  totalAssets: BN;
  totalShares: BN;
  totalPendingDeposits: BN;
  decimalsOffset: number;
  paused: boolean;
  maxStaleness: BN;
  maxDeviationBps: number;
  bump: number;
}

export interface CreateAsyncVaultParams {
  assetMint: PublicKey;
  operator: PublicKey;
  vaultId: BN | number;
  name: string;
  symbol: string;
  uri: string;
}

export interface RequestDepositParams {
  assets: BN;
}

export interface RequestRedeemParams {
  shares: BN;
}

export interface FulfillParams {
  owner: PublicKey;
  oraclePrice?: BN;
}

export interface ClaimParams {
  owner: PublicKey;
  receiver: PublicKey;
}

export interface SetOperatorParams {
  operator: PublicKey;
  approved: boolean;
}

export class AsyncVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly shareEscrow: PublicKey;
  readonly assetMint: PublicKey;
  readonly assetVault: PublicKey;
  readonly vaultId: BN;
  readonly assetTokenProgram: PublicKey;

  private _state: AsyncVaultState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    sharesMint: PublicKey,
    shareEscrow: PublicKey,
    assetMint: PublicKey,
    assetVault: PublicKey,
    vaultId: BN,
    assetTokenProgram: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.sharesMint = sharesMint;
    this.shareEscrow = shareEscrow;
    this.assetMint = assetMint;
    this.assetVault = assetVault;
    this.vaultId = vaultId;
    this.assetTokenProgram = assetTokenProgram;
  }

  static async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<AsyncVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveAsyncVaultAddresses(program.programId, assetMint, id);

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

    const vault = new AsyncVault(
      program,
      provider,
      addresses.vault,
      addresses.sharesMint,
      addresses.shareEscrow,
      assetMint,
      assetVault,
      id,
      assetTokenProgram,
    );

    await vault.refresh();
    return vault;
  }

  static async create(
    program: Program,
    params: CreateAsyncVaultParams,
  ): Promise<AsyncVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveAsyncVaultAddresses(
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
        operator: params.operator,
        vault: addresses.vault,
        assetMint: params.assetMint,
        sharesMint: addresses.sharesMint,
        assetVault: assetVault,
        shareEscrow: addresses.shareEscrow,
        assetTokenProgram: assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return AsyncVault.load(program, params.assetMint, id);
  }

  async refresh(): Promise<AsyncVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["asyncVault"].fetch(
      this.vault,
    )) as AsyncVaultState;
    return this._state;
  }

  async getState(): Promise<AsyncVaultState> {
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

  getUserAssetAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.assetMint,
      owner,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // ============ Deposit Lifecycle ============

  async requestDeposit(
    user: PublicKey,
    params: RequestDepositParams,
  ): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.program.programId,
      this.vault,
      user,
    );
    const userAssetAccount = this.getUserAssetAccount(user);

    return this.program.methods
      .requestDeposit(params.assets)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        depositRequest,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelDeposit(user: PublicKey): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.program.programId,
      this.vault,
      user,
    );
    const userAssetAccount = this.getUserAssetAccount(user);

    return this.program.methods
      .cancelDeposit()
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        depositRequest,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async fulfillDeposit(
    operator: PublicKey,
    params: FulfillParams,
  ): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );

    return this.program.methods
      .fulfillDeposit(params.oraclePrice ?? null)
      .accountsStrict({
        operator,
        vault: this.vault,
        depositRequest,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async claimDeposit(
    claimant: PublicKey,
    params: ClaimParams,
  ): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );
    const receiverSharesAccount = this.getUserSharesAccount(params.receiver);

    const operatorApproval = claimant.equals(params.receiver)
      ? null
      : getOperatorApprovalAddress(
          this.program.programId,
          this.vault,
          params.owner,
          claimant,
        )[0];

    return this.program.methods
      .claimDeposit()
      .accountsPartial({
        claimant,
        vault: this.vault,
        depositRequest,
        owner: params.owner,
        sharesMint: this.sharesMint,
        receiverSharesAccount,
        receiver: params.receiver,
        operatorApproval,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ============ Redeem Lifecycle ============

  async requestRedeem(
    user: PublicKey,
    params: RequestRedeemParams,
  ): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.program.programId,
      this.vault,
      user,
    );
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .requestRedeem(params.shares)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        shareEscrow: this.shareEscrow,
        redeemRequest,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelRedeem(user: PublicKey): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.program.programId,
      this.vault,
      user,
    );
    const userSharesAccount = this.getUserSharesAccount(user);

    return this.program.methods
      .cancelRedeem()
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount,
        shareEscrow: this.shareEscrow,
        redeemRequest,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async fulfillRedeem(
    operator: PublicKey,
    params: FulfillParams,
  ): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );

    return this.program.methods
      .fulfillRedeem(params.oraclePrice ?? null)
      .accountsStrict({
        operator,
        vault: this.vault,
        redeemRequest,
        assetMint: this.assetMint,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        shareEscrow: this.shareEscrow,
        claimableTokens,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async claimRedeem(
    claimant: PublicKey,
    params: ClaimParams,
  ): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.program.programId,
      this.vault,
      params.owner,
    );
    const receiverAssetAccount = this.getUserAssetAccount(params.receiver);

    const operatorApproval = claimant.equals(params.receiver)
      ? null
      : getOperatorApprovalAddress(
          this.program.programId,
          this.vault,
          params.owner,
          claimant,
        )[0];

    return this.program.methods
      .claimRedeem()
      .accountsPartial({
        claimant,
        vault: this.vault,
        assetMint: this.assetMint,
        redeemRequest,
        owner: params.owner,
        claimableTokens,
        receiverAssetAccount,
        receiver: params.receiver,
        operatorApproval,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ============ Operator Management ============

  async setOperator(
    owner: PublicKey,
    params: SetOperatorParams,
  ): Promise<string> {
    const [operatorApproval] = getOperatorApprovalAddress(
      this.program.programId,
      this.vault,
      owner,
      params.operator,
    );

    return this.program.methods
      .setOperator(params.approved)
      .accountsStrict({
        owner,
        vault: this.vault,
        operatorApproval,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ============ Admin Functions ============

  async pause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .pause()
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  async unpause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

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

  async setVaultOperator(
    authority: PublicKey,
    newOperator: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .setVaultOperator(newOperator)
      .accountsStrict({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  // ============ View Helpers ============

  async getDepositRequest(owner: PublicKey): Promise<unknown> {
    const [depositRequest] = getDepositRequestAddress(
      this.program.programId,
      this.vault,
      owner,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return accountNs["depositRequest"].fetch(depositRequest);
  }

  async getRedeemRequest(owner: PublicKey): Promise<unknown> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.program.programId,
      this.vault,
      owner,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return accountNs["redeemRequest"].fetch(redeemRequest);
  }

  async getOperatorApproval(
    owner: PublicKey,
    operator: PublicKey,
  ): Promise<unknown> {
    const [operatorApproval] = getOperatorApprovalAddress(
      this.program.programId,
      this.vault,
      owner,
      operator,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return accountNs["operatorApproval"].fetch(operatorApproval);
  }
}
