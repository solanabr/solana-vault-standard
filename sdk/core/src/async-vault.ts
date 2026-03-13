/**
 * Async Vault Module (SVS-10)
 *
 * ERC-7540-style asynchronous vault implementation for Solana.
 * Deposits and redemptions follow a request -> fulfill -> claim lifecycle.
 */

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import {
  deriveAsyncVaultAddresses,
  getClaimableEscrowAddress,
  getDepositRequestAddress,
  getOperatorApprovalAddress,
  getRedeemRequestAddress,
} from "./pda";
import { CreateVaultParams, getTokenProgramForMint } from "./vault";

type FetchableAccountNamespace = Record<
  string,
  { fetch: (address: PublicKey) => Promise<unknown> }
>;

type DecodedAccount = Record<string, unknown>;

export type RequestStatus = "pending" | "fulfilled" | "claimed" | "cancelled";

export interface AsyncVaultState {
  authority: PublicKey;
  operator: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  shareEscrow: PublicKey;
  totalAssets: BN;
  totalShares: BN;
  pendingDepositAssets: BN;
  pendingClaimShares: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  maxStaleness: BN;
  requestExpirySecs: BN;
}

export interface DepositRequestState {
  vault: PublicKey;
  owner: PublicKey;
  receiver: PublicKey;
  assetsLocked: BN;
  sharesClaimable: BN;
  status: RequestStatus;
  requestedAt: BN;
  fulfilledAt: BN;
  bump: number;
}

export interface RedeemRequestState {
  vault: PublicKey;
  owner: PublicKey;
  receiver: PublicKey;
  sharesLocked: BN;
  assetsClaimable: BN;
  status: RequestStatus;
  requestedAt: BN;
  fulfilledAt: BN;
  bump: number;
}

export interface ClaimableEscrowState {
  vault: PublicKey;
  owner: PublicKey;
  amount: BN;
  bump: number;
}

export interface OperatorApprovalState {
  vault: PublicKey;
  owner: PublicKey;
  operator: PublicKey;
  approved: boolean;
  bump: number;
}

export interface CreateAsyncVaultParams extends CreateVaultParams {
  maxStaleness: BN | number;
}

export interface AsyncRequestDepositParams {
  assets: BN;
  receiver?: PublicKey;
}

export interface AsyncRequestRedeemParams {
  shares: BN;
  receiver?: PublicKey;
}

export interface AsyncFulfillParams {
  owner: PublicKey;
  oracleAccount?: PublicKey;
  oracleProgram?: PublicKey;
}

export interface AsyncClaimParams {
  owner?: PublicKey;
  receiver?: PublicKey;
}

function isRequestStatus(value: string): value is RequestStatus {
  return (
    value === "pending" ||
    value === "fulfilled" ||
    value === "claimed" ||
    value === "cancelled"
  );
}

function normalizeRequestStatus(status: unknown): RequestStatus {
  if (typeof status === "string") {
    const normalized = status.toLowerCase();
    if (isRequestStatus(normalized)) {
      return normalized;
    }
  }

  if (typeof status === "object" && status !== null) {
    const keys = Object.keys(status);
    if (keys.length === 1) {
      const normalized = keys[0].toLowerCase();
      if (isRequestStatus(normalized)) {
        return normalized;
      }
    }
  }

  throw new Error(`Unknown request status: ${String(status)}`);
}

function toDecodedAccount(value: unknown, accountName: string): DecodedAccount {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid ${accountName} account payload`);
  }
  return value as DecodedAccount;
}

function readPublicKey(
  account: DecodedAccount,
  field: string,
  accountName: string,
): PublicKey {
  const value = account[field];
  if (!(value instanceof PublicKey)) {
    throw new Error(`Invalid ${accountName}.${field}`);
  }
  return value;
}

function readBn(account: DecodedAccount, field: string, accountName: string): BN {
  const value = account[field];
  if (!(value instanceof BN)) {
    throw new Error(`Invalid ${accountName}.${field}`);
  }
  return value;
}

function readNumber(
  account: DecodedAccount,
  field: string,
  accountName: string,
): number {
  const value = account[field];
  if (typeof value !== "number") {
    throw new Error(`Invalid ${accountName}.${field}`);
  }
  return value;
}

function readBoolean(
  account: DecodedAccount,
  field: string,
  accountName: string,
): boolean {
  const value = account[field];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${accountName}.${field}`);
  }
  return value;
}

function normalizeAsyncVaultState(value: unknown): AsyncVaultState {
  const account = toDecodedAccount(value, "asyncVault");
  return {
    authority: readPublicKey(account, "authority", "asyncVault"),
    operator: readPublicKey(account, "operator", "asyncVault"),
    assetMint: readPublicKey(account, "assetMint", "asyncVault"),
    sharesMint: readPublicKey(account, "sharesMint", "asyncVault"),
    assetVault: readPublicKey(account, "assetVault", "asyncVault"),
    shareEscrow: readPublicKey(account, "shareEscrow", "asyncVault"),
    totalAssets: readBn(account, "totalAssets", "asyncVault"),
    totalShares: readBn(account, "totalShares", "asyncVault"),
    pendingDepositAssets: readBn(account, "pendingDepositAssets", "asyncVault"),
    pendingClaimShares: readBn(account, "pendingClaimShares", "asyncVault"),
    decimalsOffset: readNumber(account, "decimalsOffset", "asyncVault"),
    bump: readNumber(account, "bump", "asyncVault"),
    paused: readBoolean(account, "paused", "asyncVault"),
    vaultId: readBn(account, "vaultId", "asyncVault"),
    maxStaleness: readBn(account, "maxStaleness", "asyncVault"),
    requestExpirySecs: readBn(account, "requestExpirySecs", "asyncVault"),
  };
}

function normalizeDepositRequestState(value: unknown): DepositRequestState {
  const account = toDecodedAccount(value, "depositRequest");
  return {
    vault: readPublicKey(account, "vault", "depositRequest"),
    owner: readPublicKey(account, "owner", "depositRequest"),
    receiver: readPublicKey(account, "receiver", "depositRequest"),
    assetsLocked: readBn(account, "assetsLocked", "depositRequest"),
    sharesClaimable: readBn(account, "sharesClaimable", "depositRequest"),
    status: normalizeRequestStatus(account["status"]),
    requestedAt: readBn(account, "requestedAt", "depositRequest"),
    fulfilledAt: readBn(account, "fulfilledAt", "depositRequest"),
    bump: readNumber(account, "bump", "depositRequest"),
  };
}

function normalizeRedeemRequestState(value: unknown): RedeemRequestState {
  const account = toDecodedAccount(value, "redeemRequest");
  return {
    vault: readPublicKey(account, "vault", "redeemRequest"),
    owner: readPublicKey(account, "owner", "redeemRequest"),
    receiver: readPublicKey(account, "receiver", "redeemRequest"),
    sharesLocked: readBn(account, "sharesLocked", "redeemRequest"),
    assetsClaimable: readBn(account, "assetsClaimable", "redeemRequest"),
    status: normalizeRequestStatus(account["status"]),
    requestedAt: readBn(account, "requestedAt", "redeemRequest"),
    fulfilledAt: readBn(account, "fulfilledAt", "redeemRequest"),
    bump: readNumber(account, "bump", "redeemRequest"),
  };
}

function normalizeClaimableEscrowState(value: unknown): ClaimableEscrowState {
  const account = toDecodedAccount(value, "claimableEscrow");
  return {
    vault: readPublicKey(account, "vault", "claimableEscrow"),
    owner: readPublicKey(account, "owner", "claimableEscrow"),
    amount: readBn(account, "amount", "claimableEscrow"),
    bump: readNumber(account, "bump", "claimableEscrow"),
  };
}

function normalizeOperatorApprovalState(value: unknown): OperatorApprovalState {
  const account = toDecodedAccount(value, "operatorApproval");
  return {
    vault: readPublicKey(account, "vault", "operatorApproval"),
    owner: readPublicKey(account, "owner", "operatorApproval"),
    operator: readPublicKey(account, "operator", "operatorApproval"),
    approved: readBoolean(account, "approved", "operatorApproval"),
    bump: readNumber(account, "bump", "operatorApproval"),
  };
}

function isMissingAccountError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Account does not exist") ||
    error.message.includes("Account not found") ||
    error.message.includes("could not find account") ||
    error.message.includes("does not exist")
  );
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
    const maxStaleness =
      typeof params.maxStaleness === "number"
        ? new BN(params.maxStaleness)
        : params.maxStaleness;
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
      .initialize(
        id,
        params.name,
        params.symbol,
        params.uri,
        maxStaleness,
      )
      .accountsStrict({
        authority: provider.wallet.publicKey,
        vault: addresses.vault,
        assetMint: params.assetMint,
        sharesMint: addresses.sharesMint,
        assetVault,
        shareEscrow: addresses.shareEscrow,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return AsyncVault.load(program, params.assetMint, id);
  }

  private get accountNamespace(): FetchableAccountNamespace {
    return this.program.account as FetchableAccountNamespace;
  }

  private async fetchAccount<T>(
    accountName: string,
    address: PublicKey,
    normalize: (value: unknown) => T,
  ): Promise<T> {
    const value = await this.accountNamespace[accountName].fetch(address);
    return normalize(value);
  }

  private async fetchOptionalAccount<T>(
    accountName: string,
    address: PublicKey,
    normalize: (value: unknown) => T,
  ): Promise<T | null> {
    try {
      return await this.fetchAccount(accountName, address, normalize);
    } catch (error) {
      if (isMissingAccountError(error)) {
        return null;
      }
      throw error;
    }
  }

  async refresh(): Promise<AsyncVaultState> {
    this._state = await this.fetchAccount(
      "asyncVault",
      this.vault,
      normalizeAsyncVaultState,
    );
    return this._state;
  }

  async getState(): Promise<AsyncVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state as AsyncVaultState;
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

  getUserSharesAccount(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getReceiverAssetAccount(receiver: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.assetMint,
      receiver,
      true,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getReceiverSharesAccount(receiver: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      receiver,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getClaimableTokenAccount(owner: PublicKey): PublicKey {
    const [claimableEscrow] = getClaimableEscrowAddress(
      this.program.programId,
      this.vault,
      owner,
    );
    return getAssociatedTokenAddressSync(
      this.assetMint,
      claimableEscrow,
      true,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getDepositRequestAddress(owner: PublicKey): PublicKey {
    return getDepositRequestAddress(this.program.programId, this.vault, owner)[0];
  }

  getRedeemRequestAddress(owner: PublicKey): PublicKey {
    return getRedeemRequestAddress(this.program.programId, this.vault, owner)[0];
  }

  getClaimableEscrowAddress(owner: PublicKey): PublicKey {
    return getClaimableEscrowAddress(this.program.programId, this.vault, owner)[0];
  }

  getOperatorApprovalAddress(owner: PublicKey, operator: PublicKey): PublicKey {
    return getOperatorApprovalAddress(
      this.program.programId,
      this.vault,
      owner,
      operator,
    )[0];
  }

  async totalAssets(): Promise<BN> {
    const state = await this.getState();
    return state.totalAssets;
  }

  async totalShares(): Promise<BN> {
    const state = await this.getState();
    return state.totalShares;
  }

  async mintedShareSupply(): Promise<BN> {
    const mint = await getMint(
      this.provider.connection,
      this.sharesMint,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    return new BN(mint.supply.toString());
  }

  async pendingDepositAssets(): Promise<BN> {
    const state = await this.getState();
    return state.pendingDepositAssets;
  }

  async pendingClaimShares(): Promise<BN> {
    const state = await this.getState();
    return state.pendingClaimShares;
  }

  async requestDeposit(
    user: PublicKey,
    params: AsyncRequestDepositParams,
  ): Promise<string> {
    const receiver = params.receiver ?? user;
    return this.program.methods
      .requestDeposit(params.assets, receiver)
      .accountsStrict({
        user,
        vault: this.vault,
        assetMint: this.assetMint,
        userAssetAccount: this.getUserAssetAccount(user),
        assetVault: this.assetVault,
        depositRequest: this.getDepositRequestAddress(user),
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelDeposit(owner: PublicKey): Promise<string> {
    return this.program.methods
      .cancelDeposit()
      .accountsStrict({
        owner,
        vault: this.vault,
        depositRequest: this.getDepositRequestAddress(owner),
        assetMint: this.assetMint,
        assetVault: this.assetVault,
        ownerAssetAccount: this.getUserAssetAccount(owner),
        assetTokenProgram: this.assetTokenProgram,
      })
      .rpc();
  }

  async fulfillDeposit(
    operator: PublicKey,
    params: AsyncFulfillParams,
  ): Promise<string> {
    return this.program.methods
      .fulfillDeposit()
      .accounts({
        operator,
        vault: this.vault,
        depositRequest: this.getDepositRequestAddress(params.owner),
        sharesMint: this.sharesMint,
        ...(params.oracleAccount
          ? { oracleAccount: params.oracleAccount }
          : {}),
        ...(params.oracleProgram
          ? { oracleProgram: params.oracleProgram }
          : {}),
      })
      .rpc();
  }

  async claimDeposit(
    claimant: PublicKey,
    params: AsyncClaimParams = {},
  ): Promise<string> {
    const owner = params.owner ?? claimant;
    const request = await this.getDepositRequest(owner);
    if (!request) {
      throw new Error("Deposit request not found");
    }

    const receiver = params.receiver ?? request.receiver;
    const operatorApproval =
      claimant.equals(owner) || claimant.equals(receiver)
        ? undefined
        : this.getOperatorApprovalAddress(owner, claimant);

    return this.program.methods
      .claimDeposit()
      .accounts({
        claimant,
        owner,
        receiver,
        vault: this.vault,
        depositRequest: this.getDepositRequestAddress(owner),
        sharesMint: this.sharesMint,
        receiverSharesAccount: this.getReceiverSharesAccount(receiver),
        ...(operatorApproval ? { operatorApproval } : {}),
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async requestRedeem(
    user: PublicKey,
    params: AsyncRequestRedeemParams,
  ): Promise<string> {
    const receiver = params.receiver ?? user;
    return this.program.methods
      .requestRedeem(params.shares, receiver)
      .accountsStrict({
        user,
        vault: this.vault,
        sharesMint: this.sharesMint,
        userSharesAccount: this.getUserSharesAccount(user),
        shareEscrow: this.shareEscrow,
        redeemRequest: this.getRedeemRequestAddress(user),
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelRedeem(owner: PublicKey): Promise<string> {
    return this.program.methods
      .cancelRedeem()
      .accountsStrict({
        owner,
        vault: this.vault,
        redeemRequest: this.getRedeemRequestAddress(owner),
        sharesMint: this.sharesMint,
        shareEscrow: this.shareEscrow,
        ownerSharesAccount: this.getUserSharesAccount(owner),
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  }

  async fulfillRedeem(
    operator: PublicKey,
    params: AsyncFulfillParams,
  ): Promise<string> {
    const claimableEscrow = this.getClaimableEscrowAddress(params.owner);
    return this.program.methods
      .fulfillRedeem()
      .accounts({
        operator,
        vault: this.vault,
        redeemRequest: this.getRedeemRequestAddress(params.owner),
        assetMint: this.assetMint,
        assetVault: this.assetVault,
        sharesMint: this.sharesMint,
        shareEscrow: this.shareEscrow,
        claimableEscrow,
        claimableTokens: this.getClaimableTokenAccount(params.owner),
        ...(params.oracleAccount
          ? { oracleAccount: params.oracleAccount }
          : {}),
        ...(params.oracleProgram
          ? { oracleProgram: params.oracleProgram }
          : {}),
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async claimRedeem(
    claimant: PublicKey,
    params: AsyncClaimParams = {},
  ): Promise<string> {
    const owner = params.owner ?? claimant;
    const request = await this.getRedeemRequest(owner);
    if (!request) {
      throw new Error("Redeem request not found");
    }

    const receiver = params.receiver ?? request.receiver;
    const operatorApproval =
      claimant.equals(owner) || claimant.equals(receiver)
        ? undefined
        : this.getOperatorApprovalAddress(owner, claimant);

    return this.program.methods
      .claimRedeem()
      .accounts({
        claimant,
        owner,
        receiver,
        vault: this.vault,
        redeemRequest: this.getRedeemRequestAddress(owner),
        claimableEscrow: this.getClaimableEscrowAddress(owner),
        assetMint: this.assetMint,
        claimableTokens: this.getClaimableTokenAccount(owner),
        receiverAssetAccount: this.getReceiverAssetAccount(receiver),
        ...(operatorApproval ? { operatorApproval } : {}),
        assetTokenProgram: this.assetTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async setOperatorApproval(
    owner: PublicKey,
    operator: PublicKey,
    approved: boolean,
  ): Promise<string> {
    return this.program.methods
      .setOperator(operator, approved)
      .accountsStrict({
        owner,
        vault: this.vault,
        operatorAccount: operator,
        operatorApproval: this.getOperatorApprovalAddress(owner, operator),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

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

  async getDepositRequest(owner: PublicKey): Promise<DepositRequestState | null> {
    return this.fetchOptionalAccount(
      "depositRequest",
      this.getDepositRequestAddress(owner),
      normalizeDepositRequestState,
    );
  }

  async getRedeemRequest(owner: PublicKey): Promise<RedeemRequestState | null> {
    return this.fetchOptionalAccount(
      "redeemRequest",
      this.getRedeemRequestAddress(owner),
      normalizeRedeemRequestState,
    );
  }

  async getClaimableEscrow(
    owner: PublicKey,
  ): Promise<ClaimableEscrowState | null> {
    return this.fetchOptionalAccount(
      "claimableEscrow",
      this.getClaimableEscrowAddress(owner),
      normalizeClaimableEscrowState,
    );
  }

  async getOperatorApproval(
    owner: PublicKey,
    operator: PublicKey,
  ): Promise<OperatorApprovalState | null> {
    return this.fetchOptionalAccount(
      "operatorApproval",
      this.getOperatorApprovalAddress(owner, operator),
      normalizeOperatorApprovalState,
    );
  }

  async pendingDepositRequest(owner: PublicKey): Promise<BN> {
    const request = await this.getDepositRequest(owner);
    return request?.status === "pending" ? request.assetsLocked : new BN(0);
  }

  async claimableDepositRequest(owner: PublicKey): Promise<BN> {
    const request = await this.getDepositRequest(owner);
    return request?.status === "fulfilled" ? request.sharesClaimable : new BN(0);
  }

  async pendingRedeemRequest(owner: PublicKey): Promise<BN> {
    const request = await this.getRedeemRequest(owner);
    return request?.status === "pending" ? request.sharesLocked : new BN(0);
  }

  async claimableRedeemRequest(owner: PublicKey): Promise<BN> {
    const escrow = await this.getClaimableEscrow(owner);
    return escrow?.amount ?? new BN(0);
  }

  async maxDeposit(): Promise<BN> {
    const state = await this.getState();
    return state.paused ? new BN(0) : new BN("18446744073709551615");
  }

  async isPaused(): Promise<boolean> {
    const state = await this.getState();
    return state.paused;
  }

  async getAuthority(): Promise<PublicKey> {
    const state = await this.getState();
    return state.authority;
  }

  async getOperator(): Promise<PublicKey> {
    const state = await this.getState();
    return state.operator;
  }

  isAssetToken2022(): boolean {
    return this.assetTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  }
}

export async function getTokenProgramForAsyncVault(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  return getTokenProgramForMint(connection, mint);
}
