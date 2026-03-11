import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  deriveAsyncVaultAddresses,
  getAsyncVaultAddress,
  getAsyncSharesMintAddress,
  getAssetVaultAddress,
  getShareEscrowAddress,
  getDepositRequestAddress,
  getRedeemRequestAddress,
  getClaimableEscrowAddress,
  getClaimableTokensAddress,
  getOperatorApprovalAddress,
} from "./async-pda";
import { getTokenProgramForMint } from "./vault";
import type { Svs10 } from "../../../target/types/svs_10";

export interface AsyncVaultState {
  authority: PublicKey;
  operator: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  assetVault: PublicKey;
  shareEscrow: PublicKey;
  totalShares: BN;
  totalAssets: BN;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  cancelDelay: BN;
  maxStaleness: BN;
}

export interface InitializeAsyncVaultParams {
  assetMint: PublicKey;
  vaultId: BN | number;
  cancelDelay: BN | number;
  maxStaleness: BN | number;
}

export class AsyncVault {
  readonly programId: PublicKey;
  readonly address: PublicKey;
  readonly sharesMint: PublicKey;
  readonly assetVault: PublicKey;
  readonly shareEscrow: PublicKey;
  private _state: AsyncVaultState | null = null;

  private constructor(
    readonly program: Program<Svs10>,
    readonly assetMint: PublicKey,
    readonly vaultId: BN,
  ) {
    this.programId = program.programId;
    const addrs = deriveAsyncVaultAddresses(this.programId, assetMint, vaultId);
    this.address = addrs.vault;
    this.sharesMint = addrs.sharesMint;
    this.assetVault = addrs.assetVault;
    this.shareEscrow = addrs.shareEscrow;
  }

  get state(): AsyncVaultState {
    if (!this._state)
      throw new Error("Vault not loaded. Call refresh() first.");
    return this._state;
  }

  static async load(
    program: Program<Svs10>,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<AsyncVault> {
    const vault = new AsyncVault(
      program,
      assetMint,
      typeof vaultId === "number" ? new BN(vaultId) : vaultId,
    );
    await vault.refresh();
    return vault;
  }

  async refresh(): Promise<void> {
    this._state = await this.program.account.asyncVault.fetch(this.address);
  }

  static async initialize(
    program: Program<Svs10>,
    params: InitializeAsyncVaultParams,
    authority: Keypair,
  ): Promise<AsyncVault> {
    const vaultId =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const cancelDelay =
      typeof params.cancelDelay === "number"
        ? new BN(params.cancelDelay)
        : params.cancelDelay;
    const maxStaleness =
      typeof params.maxStaleness === "number"
        ? new BN(params.maxStaleness)
        : params.maxStaleness;

    const addrs = deriveAsyncVaultAddresses(
      program.programId,
      params.assetMint,
      vaultId,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      program.provider.connection,
      params.assetMint,
    );

    await program.methods
      .initialize(vaultId, cancelDelay, maxStaleness)
      .accountsStrict({
        authority: authority.publicKey,
        vault: addrs.vault,
        assetMint: params.assetMint,
        sharesMint: addrs.sharesMint,
        assetVault: addrs.assetVault,
        shareEscrow: addrs.shareEscrow,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    return AsyncVault.load(program, params.assetMint, vaultId);
  }

  // === User Actions ===

  async requestDeposit(
    user: Keypair,
    assets: BN,
    receiver?: PublicKey,
  ): Promise<string> {
    const rcv = receiver ?? user.publicKey;
    const [depositRequest] = getDepositRequestAddress(
      this.programId,
      this.address,
      user.publicKey,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const userAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      user.publicKey,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .requestDeposit(assets, rcv)
      .accountsStrict({
        user: user.publicKey,
        vault: this.address,
        depositRequest,
        assetMint: this.assetMint,
        userAssetAccount,
        assetVault: this.assetVault,
        assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  async cancelDeposit(owner: Keypair): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.programId,
      this.address,
      owner.publicKey,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const userAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      owner.publicKey,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .cancelDeposit()
      .accountsStrict({
        owner: owner.publicKey,
        vault: this.address,
        depositRequest,
        assetMint: this.assetMint,
        assetVault: this.assetVault,
        userAssetAccount,
        assetTokenProgram,
      })
      .signers([owner])
      .rpc();
  }

  async claimDeposit(
    claimer: Keypair,
    owner: PublicKey,
    operatorApproval?: PublicKey,
  ): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.programId,
      this.address,
      owner,
    );
    const req = await this.program.account.depositRequest.fetch(depositRequest);
    const receiverSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      req.receiver,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      claimer.publicKey,
      receiverSharesAccount,
      req.receiver,
      this.sharesMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    return this.program.methods
      .claimDeposit()
      .accountsStrict({
        claimer: claimer.publicKey,
        vault: this.address,
        depositRequest,
        sharesMint: this.sharesMint,
        receiverSharesAccount,
        operatorApproval: operatorApproval ?? null,
        rentReceiver: owner,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createAtaIx])
      .signers([claimer])
      .rpc();
  }

  async requestRedeem(
    user: Keypair,
    shares: BN,
    receiver?: PublicKey,
  ): Promise<string> {
    const rcv = receiver ?? user.publicKey;
    const [redeemRequest] = getRedeemRequestAddress(
      this.programId,
      this.address,
      user.publicKey,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    return this.program.methods
      .requestRedeem(shares, rcv)
      .accountsStrict({
        user: user.publicKey,
        vault: this.address,
        redeemRequest,
        sharesMint: this.sharesMint,
        userSharesAccount,
        shareEscrow: this.shareEscrow,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  async cancelRedeem(owner: Keypair): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.programId,
      this.address,
      owner.publicKey,
    );
    const userSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      owner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    return this.program.methods
      .cancelRedeem()
      .accountsStrict({
        owner: owner.publicKey,
        vault: this.address,
        redeemRequest,
        sharesMint: this.sharesMint,
        shareEscrow: this.shareEscrow,
        userSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  async claimRedeem(
    claimer: Keypair,
    owner: PublicKey,
    operatorApproval?: PublicKey,
  ): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.programId,
      this.address,
      owner,
    );
    const req = await this.program.account.redeemRequest.fetch(redeemRequest);
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const receiverAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      req.receiver,
      false,
      assetTokenProgram,
    );
    const [claimableEscrow] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      owner,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.programId,
      this.address,
      owner,
    );

    return this.program.methods
      .claimRedeem()
      .accountsStrict({
        claimer: claimer.publicKey,
        vault: this.address,
        redeemRequest,
        claimableEscrow,
        owner,
        assetMint: this.assetMint,
        claimableTokens,
        receiverAssetAccount,
        operatorApproval: operatorApproval ?? null,
        rentReceiver: owner,
        assetTokenProgram,
      })
      .signers([claimer])
      .rpc();
  }

  // === Operator Actions ===

  async fulfillDeposit(operator: Keypair, owner: PublicKey): Promise<string> {
    const [depositRequest] = getDepositRequestAddress(
      this.programId,
      this.address,
      owner,
    );

    return this.program.methods
      .fulfillDeposit()
      .accountsStrict({
        operator: operator.publicKey,
        vault: this.address,
        depositRequest,
      })
      .signers([operator])
      .rpc();
  }

  async fulfillRedeem(operator: Keypair, owner: PublicKey): Promise<string> {
    const [redeemRequest] = getRedeemRequestAddress(
      this.programId,
      this.address,
      owner,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.programId,
      this.address,
      owner,
    );
    const [claimableEscrow] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      owner,
    );

    return this.program.methods
      .fulfillRedeem()
      .accountsStrict({
        operator: operator.publicKey,
        vault: this.address,
        redeemRequest,
        sharesMint: this.sharesMint,
        shareEscrow: this.shareEscrow,
        assetMint: this.assetMint,
        assetVault: this.assetVault,
        claimableTokens,
        claimableEscrow,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([operator])
      .rpc();
  }

  // === Approval ===

  async approveOperator(
    owner: Keypair,
    operator: PublicKey,
    canFulfillDeposit = false,
    canFulfillRedeem = false,
    canClaim = true,
  ): Promise<string> {
    const [operatorApproval] = getOperatorApprovalAddress(
      this.programId,
      this.address,
      owner.publicKey,
      operator,
    );

    return this.program.methods
      .approveOperator(canFulfillDeposit, canFulfillRedeem, canClaim)
      .accountsStrict({
        owner: owner.publicKey,
        vault: this.address,
        operator,
        operatorApproval,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  }

  async revokeOperator(owner: Keypair, operator: PublicKey): Promise<string> {
    const [operatorApproval] = getOperatorApprovalAddress(
      this.programId,
      this.address,
      owner.publicKey,
      operator,
    );

    return this.program.methods
      .revokeOperator()
      .accountsStrict({
        owner: owner.publicKey,
        vault: this.address,
        operator,
        operatorApproval,
      })
      .signers([owner])
      .rpc();
  }

  // === Admin ===

  async pause(authority: Keypair): Promise<string> {
    return this.program.methods
      .pause()
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  async unpause(authority: Keypair): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  async transferAuthority(
    authority: Keypair,
    newAuthority: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .transferAuthority(newAuthority)
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  async setVaultOperator(
    authority: Keypair,
    newOperator: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .setVaultOperator(newOperator)
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  // === View ===

  async pendingDepositRequest(owner: PublicKey): Promise<BN> {
    const [pda] = getDepositRequestAddress(this.programId, this.address, owner);
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return new BN(0);
    const req = await this.program.account.depositRequest.fetch(pda);
    return req.status.pending ? req.assetsLocked : new BN(0);
  }

  async claimableDepositRequest(owner: PublicKey): Promise<BN> {
    const [pda] = getDepositRequestAddress(this.programId, this.address, owner);
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return new BN(0);
    const req = await this.program.account.depositRequest.fetch(pda);
    return req.status.fulfilled ? req.sharesClaimable : new BN(0);
  }

  async pendingRedeemRequest(owner: PublicKey): Promise<BN> {
    const [pda] = getRedeemRequestAddress(this.programId, this.address, owner);
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return new BN(0);
    const req = await this.program.account.redeemRequest.fetch(pda);
    return req.status.pending ? req.sharesLocked : new BN(0);
  }

  async claimableRedeemRequest(owner: PublicKey): Promise<BN> {
    const [pda] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      owner,
    );
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return new BN(0);
    const escrow = await this.program.account.claimableEscrow.fetch(pda);
    return escrow.amount;
  }
}
