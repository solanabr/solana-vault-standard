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
  deriveCreditVaultAddresses,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getFrozenAccountAddress,
} from "./credit-vault-pda";
import { getTokenProgramForMint } from "./vault";

export interface CreditVaultState {
  authority: PublicKey;
  manager: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  depositVault: PublicKey;
  redemptionEscrow: PublicKey;
  navOracle: PublicKey;
  oracleProgram: PublicKey;
  maxStaleness: BN;
  sasCredential: PublicKey;
  sasSchema: PublicKey;
  vaultId: BN;
  totalAssets: BN;
  totalShares: BN;
  totalPendingDeposits: BN;
  minimumInvestment: BN;
  investmentWindowOpen: boolean;
  decimalsOffset: number;
  bump: number;
  redemptionEscrowBump: number;
  paused: boolean;
}

export interface CreateCreditVaultParams {
  assetMint: PublicKey;
  manager: PublicKey;
  vaultId: BN | number;
  navOracle: PublicKey;
  oracleProgram: PublicKey;
  sasCredential: PublicKey;
  sasSchema: PublicKey;
  minimumInvestment: BN;
  maxStaleness: BN;
}

export interface InvestmentRequestState {
  investor: PublicKey;
  vault: PublicKey;
  amountLocked: BN;
  sharesClaimable: BN;
  status: { pending: {} } | { approved: {} };
  requestedAt: BN;
  fulfilledAt: BN;
  bump: number;
}

export interface RedemptionRequestState {
  investor: PublicKey;
  vault: PublicKey;
  sharesLocked: BN;
  assetsClaimable: BN;
  status: { pending: {} } | { approved: {} };
  requestedAt: BN;
  fulfilledAt: BN;
  bump: number;
}

export interface FrozenAccountState {
  investor: PublicKey;
  vault: PublicKey;
  frozenBy: PublicKey;
  frozenAt: BN;
  bump: number;
}

export class CreditVault {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly vault: PublicKey;
  readonly sharesMint: PublicKey;
  readonly redemptionEscrow: PublicKey;
  readonly assetMint: PublicKey;
  readonly depositVault: PublicKey;
  readonly vaultId: BN;
  readonly assetTokenProgram: PublicKey;

  private _state: CreditVaultState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    vault: PublicKey,
    sharesMint: PublicKey,
    redemptionEscrow: PublicKey,
    assetMint: PublicKey,
    depositVault: PublicKey,
    vaultId: BN,
    assetTokenProgram: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.vault = vault;
    this.sharesMint = sharesMint;
    this.redemptionEscrow = redemptionEscrow;
    this.assetMint = assetMint;
    this.depositVault = depositVault;
    this.vaultId = vaultId;
    this.assetTokenProgram = assetTokenProgram;
  }

  static async load(
    program: Program,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<CreditVault> {
    const provider = program.provider as AnchorProvider;
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;
    const addresses = deriveCreditVaultAddresses(
      program.programId,
      assetMint,
      id,
    );

    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      assetMint,
    );

    const depositVault = getAssociatedTokenAddressSync(
      assetMint,
      addresses.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const vault = new CreditVault(
      program,
      provider,
      addresses.vault,
      addresses.sharesMint,
      addresses.redemptionEscrow,
      assetMint,
      depositVault,
      id,
      assetTokenProgram,
    );

    await vault.refresh();
    return vault;
  }

  static async create(
    program: Program,
    params: CreateCreditVaultParams,
  ): Promise<CreditVault> {
    const provider = program.provider as AnchorProvider;
    const id =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const addresses = deriveCreditVaultAddresses(
      program.programId,
      params.assetMint,
      id,
    );

    const assetTokenProgram = await getTokenProgramForMint(
      provider.connection,
      params.assetMint,
    );

    const depositVault = getAssociatedTokenAddressSync(
      params.assetMint,
      addresses.vault,
      true,
      assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    await program.methods
      .initializePool(
        id,
        params.minimumInvestment,
        params.maxStaleness,
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        manager: params.manager,
        vault: addresses.vault,
        assetMint: params.assetMint,
        sharesMint: addresses.sharesMint,
        depositVault,
        redemptionEscrow: addresses.redemptionEscrow,
        navOracle: params.navOracle,
        oracleProgram: params.oracleProgram,
        sasCredential: params.sasCredential,
        sasSchema: params.sasSchema,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return CreditVault.load(program, params.assetMint, id);
  }

  async refresh(): Promise<CreditVaultState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["creditVault"].fetch(
      this.vault,
    )) as CreditVaultState;
    return this._state;
  }

  async getState(): Promise<CreditVaultState> {
    if (!this._state) {
      await this.refresh();
    }
    return { ...this._state! };
  }

  getInvestorSharesAccount(investor: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      investor,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  getInvestorTokenAccount(investor: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.assetMint,
      investor,
      false,
      this.assetTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }

  // ============ Deposit Lifecycle ============

  async requestDeposit(
    investor: PublicKey,
    amount: BN,
    attestation: PublicKey,
    frozenCheck?: PublicKey,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorTokenAccount = this.getInvestorTokenAccount(investor);

    return this.program.methods
      .requestDeposit(amount)
      .accountsPartial({
        investor,
        vault: this.vault,
        investmentRequest,
        investorTokenAccount,
        depositVault: this.depositVault,
        assetMint: this.assetMint,
        attestation,
        frozenCheck: frozenCheck ?? this.program.programId,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async approveDeposit(
    manager: PublicKey,
    investor: PublicKey,
    navOracle: PublicKey,
    attestation: PublicKey,
    frozenCheck?: PublicKey,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );

    return this.program.methods
      .approveDeposit()
      .accountsPartial({
        manager,
        vault: this.vault,
        investmentRequest,
        investor,
        navOracle,
        attestation,
        frozenCheck: frozenCheck ?? this.program.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async claimDeposit(investor: PublicKey): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    return this.program.methods
      .claimDeposit()
      .accountsPartial({
        investor,
        vault: this.vault,
        investmentRequest,
        sharesMint: this.sharesMint,
        investorSharesAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async rejectDeposit(
    manager: PublicKey,
    investor: PublicKey,
    reasonCode: number = 0,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorTokenAccount = this.getInvestorTokenAccount(investor);

    return this.program.methods
      .rejectDeposit(reasonCode)
      .accountsPartial({
        manager,
        vault: this.vault,
        investmentRequest,
        investor,
        depositVault: this.depositVault,
        investorTokenAccount,
        assetMint: this.assetMint,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelDeposit(investor: PublicKey): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorTokenAccount = this.getInvestorTokenAccount(investor);

    return this.program.methods
      .cancelDeposit()
      .accountsPartial({
        investor,
        vault: this.vault,
        investmentRequest,
        depositVault: this.depositVault,
        investorTokenAccount,
        assetMint: this.assetMint,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ============ Redeem Lifecycle ============

  async requestRedeem(
    investor: PublicKey,
    shares: BN,
    attestation: PublicKey,
    frozenCheck?: PublicKey,
  ): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    return this.program.methods
      .requestRedeem(shares)
      .accountsPartial({
        investor,
        vault: this.vault,
        redemptionRequest,
        sharesMint: this.sharesMint,
        investorSharesAccount,
        redemptionEscrow: this.redemptionEscrow,
        attestation,
        frozenCheck: frozenCheck ?? this.program.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async approveRedeem(
    manager: PublicKey,
    investor: PublicKey,
    navOracle: PublicKey,
    attestation: PublicKey,
    frozenCheck?: PublicKey,
  ): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.program.programId,
      this.vault,
      investor,
    );

    return this.program.methods
      .approveRedeem()
      .accountsPartial({
        manager,
        vault: this.vault,
        redemptionRequest,
        investor,
        sharesMint: this.sharesMint,
        redemptionEscrow: this.redemptionEscrow,
        depositVault: this.depositVault,
        assetMint: this.assetMint,
        claimableTokens,
        navOracle,
        attestation,
        frozenCheck: frozenCheck ?? this.program.programId,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async claimRedeem(investor: PublicKey): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorTokenAccount = this.getInvestorTokenAccount(investor);

    return this.program.methods
      .claimRedeem()
      .accountsPartial({
        investor,
        vault: this.vault,
        redemptionRequest,
        claimableTokens,
        investorTokenAccount,
        assetMint: this.assetMint,
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelRedeem(investor: PublicKey): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    return this.program.methods
      .cancelRedeem()
      .accountsPartial({
        investor,
        vault: this.vault,
        redemptionRequest,
        sharesMint: this.sharesMint,
        investorSharesAccount,
        redemptionEscrow: this.redemptionEscrow,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ============ Manager Operations ============

  async repay(
    manager: PublicKey,
    amount: BN,
    managerTokenAccount: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .repay(amount)
      .accountsPartial({
        manager,
        vault: this.vault,
        depositVault: this.depositVault,
        managerTokenAccount,
        assetMint: this.assetMint,
        assetTokenProgram: this.assetTokenProgram,
      })
      .rpc();
  }

  async drawDown(
    manager: PublicKey,
    amount: BN,
    destination: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .drawDown(amount)
      .accountsPartial({
        manager,
        vault: this.vault,
        depositVault: this.depositVault,
        destination,
        assetMint: this.assetMint,
        assetTokenProgram: this.assetTokenProgram,
      })
      .rpc();
  }

  async openInvestmentWindow(manager: PublicKey): Promise<string> {
    return this.program.methods
      .openInvestmentWindow()
      .accountsPartial({
        manager,
        vault: this.vault,
      })
      .rpc();
  }

  async closeInvestmentWindow(manager: PublicKey): Promise<string> {
    return this.program.methods
      .closeInvestmentWindow()
      .accountsPartial({
        manager,
        vault: this.vault,
      })
      .rpc();
  }

  // ============ Compliance ============

  async freezeAccount(
    manager: PublicKey,
    investor: PublicKey,
  ): Promise<string> {
    const [frozenAccount] = getFrozenAccountAddress(
      this.program.programId,
      this.vault,
      investor,
    );

    return this.program.methods
      .freezeAccount()
      .accountsPartial({
        manager,
        vault: this.vault,
        investor,
        frozenAccount,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async unfreezeAccount(
    manager: PublicKey,
    investor: PublicKey,
  ): Promise<string> {
    const [frozenAccount] = getFrozenAccountAddress(
      this.program.programId,
      this.vault,
      investor,
    );

    return this.program.methods
      .unfreezeAccount()
      .accountsPartial({
        manager,
        vault: this.vault,
        frozenAccount,
      })
      .rpc();
  }

  // ============ Admin Functions ============

  async pause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .pause()
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  async unpause(authority: PublicKey): Promise<string> {
    return this.program.methods
      .unpause()
      .accountsPartial({
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
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  async setManager(
    authority: PublicKey,
    newManager: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .setManager(newManager)
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  async updateSasConfig(
    authority: PublicKey,
    newCredential: PublicKey,
    newSchema: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .updateSasConfig(newCredential, newSchema)
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  // ============ View Helpers ============

  async totalAssets(): Promise<BN> {
    const state = await this.getState();
    return state.totalAssets;
  }

  async totalShares(): Promise<BN> {
    const state = await this.getState();
    return state.totalShares;
  }

  convertToShares(assets: bigint, totalAssets: bigint, totalShares: bigint, decimalsOffset: number): bigint {
    const offset = BigInt(10 ** decimalsOffset);
    return (assets * (totalShares + offset)) / (totalAssets + 1n);
  }

  convertToAssets(shares: bigint, totalAssets: bigint, totalShares: bigint, decimalsOffset: number): bigint {
    const offset = BigInt(10 ** decimalsOffset);
    return (shares * (totalAssets + 1n)) / (totalShares + offset);
  }

  async previewInvestment(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const shares = this.convertToShares(
      BigInt(assets.toString()),
      BigInt(state.totalAssets.toString()),
      BigInt(state.totalShares.toString()),
      state.decimalsOffset,
    );
    return new BN(shares.toString());
  }

  async previewRedemption(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const assets = this.convertToAssets(
      BigInt(shares.toString()),
      BigInt(state.totalAssets.toString()),
      BigInt(state.totalShares.toString()),
      state.decimalsOffset,
    );
    return new BN(assets.toString());
  }

  async fetchVault(): Promise<CreditVaultState> {
    return this.refresh();
  }

  async fetchInvestmentRequest(
    investor: PublicKey,
  ): Promise<InvestmentRequestState> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<InvestmentRequestState> }
    >;
    return accountNs["investmentRequest"].fetch(investmentRequest);
  }

  async fetchRedemptionRequest(
    investor: PublicKey,
  ): Promise<RedemptionRequestState> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<RedemptionRequestState> }
    >;
    return accountNs["redemptionRequest"].fetch(redemptionRequest);
  }

  async fetchFrozenAccount(investor: PublicKey): Promise<FrozenAccountState> {
    const [frozenAccount] = getFrozenAccountAddress(
      this.program.programId,
      this.vault,
      investor,
    );
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<FrozenAccountState> }
    >;
    return accountNs["frozenAccount"].fetch(frozenAccount);
  }
}
