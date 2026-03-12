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
  deriveCreditVaultAddresses,
  getCreditVaultAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableEscrowAddress,
  getClaimableTokensAddress,
  getFrozenAccountAddress,
} from "./credit-pda";
import { getTokenProgramForMint } from "./vault";
import type { Svs11 } from "../../../target/types/svs_11";

export interface CreditVaultState {
  authority: PublicKey;
  manager: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  depositVault: PublicKey;
  redemptionEscrow: PublicKey;
  navOracle: PublicKey;
  oracleProgram: PublicKey;
  attester: PublicKey;
  attestationProgram: PublicKey;
  totalAssets: BN;
  totalShares: BN;
  minimumInvestment: BN;
  investmentWindowOpen: boolean;
  decimalsOffset: number;
  bump: number;
  paused: boolean;
  vaultId: BN;
  maxStaleness: BN;
}

export interface InitializeCreditVaultParams {
  assetMint: PublicKey;
  vaultId: BN | number;
  minimumInvestment: BN | number;
  maxStaleness: BN | number;
  manager: PublicKey;
  navOracle: PublicKey;
  oracleProgram: PublicKey;
  attester: PublicKey;
  attestationProgram: PublicKey;
}

export class CreditVault {
  readonly programId: PublicKey;
  readonly address: PublicKey;
  readonly sharesMint: PublicKey;
  readonly depositVault: PublicKey;
  readonly redemptionEscrow: PublicKey;
  private _state: CreditVaultState | null = null;

  private constructor(
    readonly program: Program<Svs11>,
    readonly assetMint: PublicKey,
    readonly vaultId: BN,
  ) {
    this.programId = program.programId;
    const addrs = deriveCreditVaultAddresses(
      this.programId,
      assetMint,
      vaultId,
    );
    this.address = addrs.vault;
    this.sharesMint = addrs.sharesMint;
    this.depositVault = addrs.depositVault;
    this.redemptionEscrow = addrs.redemptionEscrow;
  }

  get state(): CreditVaultState {
    if (!this._state)
      throw new Error("Vault not loaded. Call refresh() first.");
    return this._state;
  }

  static async load(
    program: Program<Svs11>,
    assetMint: PublicKey,
    vaultId: BN | number,
  ): Promise<CreditVault> {
    const vault = new CreditVault(
      program,
      assetMint,
      typeof vaultId === "number" ? new BN(vaultId) : vaultId,
    );
    await vault.refresh();
    return vault;
  }

  async refresh(): Promise<void> {
    this._state = await this.program.account.creditVault.fetch(this.address);
  }

  static async initialize(
    program: Program<Svs11>,
    params: InitializeCreditVaultParams,
    authority: Keypair,
  ): Promise<CreditVault> {
    const vaultId =
      typeof params.vaultId === "number"
        ? new BN(params.vaultId)
        : params.vaultId;
    const minimumInvestment =
      typeof params.minimumInvestment === "number"
        ? new BN(params.minimumInvestment)
        : params.minimumInvestment;
    const maxStaleness =
      typeof params.maxStaleness === "number"
        ? new BN(params.maxStaleness)
        : params.maxStaleness;

    const addrs = deriveCreditVaultAddresses(
      program.programId,
      params.assetMint,
      vaultId,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      program.provider.connection,
      params.assetMint,
    );

    await program.methods
      .initializePool(vaultId, minimumInvestment, maxStaleness)
      .accountsStrict({
        authority: authority.publicKey,
        manager: params.manager,
        vault: addrs.vault,
        assetMint: params.assetMint,
        navOracle: params.navOracle,
        oracleProgram: params.oracleProgram,
        attester: params.attester,
        attestationProgram: params.attestationProgram,
        sharesMint: addrs.sharesMint,
        depositVault: addrs.depositVault,
        redemptionEscrow: addrs.redemptionEscrow,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    return CreditVault.load(program, params.assetMint, vaultId);
  }

  // === Investor Actions ===

  async requestDeposit(
    investor: Keypair,
    amount: BN,
    attestationAccount: PublicKey,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const investorAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      investor.publicKey,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .requestDeposit(amount)
      .accountsStrict({
        investor: investor.publicKey,
        vault: this.address,
        investmentRequest,
        assetMint: this.assetMint,
        investorAssetAccount,
        depositVault: this.depositVault,
        frozenAccount,
        assetTokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: attestationAccount, isWritable: false, isSigner: false },
      ])
      .signers([investor])
      .rpc();
  }

  async cancelDeposit(investor: Keypair): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const investorAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      investor.publicKey,
      false,
      assetTokenProgram,
    );

    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );

    return this.program.methods
      .cancelDeposit()
      .accountsStrict({
        investor: investor.publicKey,
        vault: this.address,
        investmentRequest,
        assetMint: this.assetMint,
        depositVault: this.depositVault,
        investorAssetAccount,
        frozenAccount,
        assetTokenProgram,
      })
      .signers([investor])
      .rpc();
  }

  async requestRedeem(
    investor: Keypair,
    shares: BN,
    attestationAccount: PublicKey,
  ): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const investorSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      investor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    return this.program.methods
      .requestRedeem(shares)
      .accountsStrict({
        investor: investor.publicKey,
        vault: this.address,
        redemptionRequest,
        sharesMint: this.sharesMint,
        investorSharesAccount,
        redemptionEscrow: this.redemptionEscrow,
        frozenAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: attestationAccount, isWritable: false, isSigner: false },
      ])
      .signers([investor])
      .rpc();
  }

  async cancelRedeem(investor: Keypair): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const investorSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      investor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );

    return this.program.methods
      .cancelRedeem()
      .accountsStrict({
        investor: investor.publicKey,
        vault: this.address,
        redemptionRequest,
        sharesMint: this.sharesMint,
        redemptionEscrow: this.redemptionEscrow,
        investorSharesAccount,
        frozenAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([investor])
      .rpc();
  }

  async claimRedemption(investor: Keypair): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const [claimableEscrow] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.programId,
      this.address,
      investor.publicKey,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const investorAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      investor.publicKey,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .claimRedemption()
      .accountsStrict({
        investor: investor.publicKey,
        vault: this.address,
        redemptionRequest,
        claimableEscrow,
        assetMint: this.assetMint,
        claimableTokens,
        investorAssetAccount,
        assetTokenProgram,
      })
      .signers([investor])
      .rpc();
  }

  // === Manager Actions ===

  async approveDeposit(
    manager: Keypair,
    investor: PublicKey,
    oracleAccount: PublicKey,
    attestationAccount: PublicKey,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.programId,
      this.address,
      investor,
    );
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor,
    );
    const investorSharesAccount = getAssociatedTokenAddressSync(
      this.sharesMint,
      investor,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      manager.publicKey,
      investorSharesAccount,
      investor,
      this.sharesMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    return this.program.methods
      .approveDeposit()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        investmentRequest,
        investor,
        sharesMint: this.sharesMint,
        investorSharesAccount,
        frozenAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: oracleAccount, isWritable: false, isSigner: false },
        { pubkey: attestationAccount, isWritable: false, isSigner: false },
      ])
      .preInstructions([createAtaIx])
      .signers([manager])
      .rpc();
  }

  async rejectDeposit(
    manager: Keypair,
    investor: PublicKey,
    reasonCode: number,
  ): Promise<string> {
    const [investmentRequest] = getInvestmentRequestAddress(
      this.programId,
      this.address,
      investor,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const investorAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      investor,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .rejectDeposit(reasonCode)
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        investmentRequest,
        investor,
        assetMint: this.assetMint,
        depositVault: this.depositVault,
        investorAssetAccount,
        assetTokenProgram,
      })
      .signers([manager])
      .rpc();
  }

  async approveRedeem(
    manager: Keypair,
    investor: PublicKey,
    oracleAccount: PublicKey,
    attestationAccount: PublicKey,
  ): Promise<string> {
    const [redemptionRequest] = getRedemptionRequestAddress(
      this.programId,
      this.address,
      investor,
    );
    const [claimableTokens] = getClaimableTokensAddress(
      this.programId,
      this.address,
      investor,
    );
    const [claimableEscrow] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      investor,
    );
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor,
    );
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );

    return this.program.methods
      .approveRedeem()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        redemptionRequest,
        sharesMint: this.sharesMint,
        redemptionEscrow: this.redemptionEscrow,
        assetMint: this.assetMint,
        depositVault: this.depositVault,
        claimableTokens,
        claimableEscrow,
        frozenAccount,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: oracleAccount, isWritable: false, isSigner: false },
        { pubkey: attestationAccount, isWritable: false, isSigner: false },
      ])
      .signers([manager])
      .rpc();
  }

  async repay(manager: Keypair, amount: BN): Promise<string> {
    const assetTokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    const managerAssetAccount = getAssociatedTokenAddressSync(
      this.assetMint,
      manager.publicKey,
      false,
      assetTokenProgram,
    );

    return this.program.methods
      .repay(amount)
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        assetMint: this.assetMint,
        managerAssetAccount,
        depositVault: this.depositVault,
        assetTokenProgram,
      })
      .signers([manager])
      .rpc();
  }

  async openWindow(manager: Keypair): Promise<string> {
    return this.program.methods
      .openInvestmentWindow()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
      })
      .signers([manager])
      .rpc();
  }

  async closeWindow(manager: Keypair): Promise<string> {
    return this.program.methods
      .closeInvestmentWindow()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
      })
      .signers([manager])
      .rpc();
  }

  async freezeAccount(manager: Keypair, investor: PublicKey): Promise<string> {
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor,
    );

    return this.program.methods
      .freezeAccount()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        investor,
        frozenAccount,
        systemProgram: SystemProgram.programId,
      })
      .signers([manager])
      .rpc();
  }

  async unfreezeAccount(
    manager: Keypair,
    investor: PublicKey,
  ): Promise<string> {
    const [frozenAccount] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor,
    );

    return this.program.methods
      .unfreezeAccount()
      .accountsStrict({
        manager: manager.publicKey,
        vault: this.address,
        investor,
        frozenAccount,
      })
      .signers([manager])
      .rpc();
  }

  // === Admin Actions ===

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

  async setManager(authority: Keypair, newManager: PublicKey): Promise<string> {
    return this.program.methods
      .setManager(newManager)
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  async updateAttester(
    authority: Keypair,
    newAttester: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .updateAttester(newAttester)
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
      })
      .signers([authority])
      .rpc();
  }

  async updateOracle(
    authority: Keypair,
    newNavOracle: PublicKey,
    newOracleProgram: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .updateOracle()
      .accountsStrict({
        authority: authority.publicKey,
        vault: this.address,
        newOracleProgram,
        newNavOracle,
      })
      .signers([authority])
      .rpc();
  }

  // === View Functions ===

  async getInvestmentRequest(investor: PublicKey): Promise<unknown | null> {
    const [pda] = getInvestmentRequestAddress(
      this.programId,
      this.address,
      investor,
    );
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return null;
    return this.program.account.investmentRequest.fetch(pda);
  }

  async getRedemptionRequest(investor: PublicKey): Promise<unknown | null> {
    const [pda] = getRedemptionRequestAddress(
      this.programId,
      this.address,
      investor,
    );
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return null;
    return this.program.account.redemptionRequest.fetch(pda);
  }

  async getClaimableEscrow(investor: PublicKey): Promise<unknown | null> {
    const [pda] = getClaimableEscrowAddress(
      this.programId,
      this.address,
      investor,
    );
    const info = await this.program.provider.connection.getAccountInfo(pda);
    if (!info) return null;
    return this.program.account.claimableEscrow.fetch(pda);
  }

  async isFrozen(investor: PublicKey): Promise<boolean> {
    const [pda] = getFrozenAccountAddress(
      this.programId,
      this.address,
      investor,
    );
    const info = await this.program.provider.connection.getAccountInfo(pda);
    return info !== null && info.data.length > 0;
  }

  getUserSharesAccount(investor: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.sharesMint,
      investor,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  async getUserAssetAccount(investor: PublicKey): Promise<PublicKey> {
    const tokenProgram = await getTokenProgramForMint(
      this.program.provider.connection,
      this.assetMint,
    );
    return getAssociatedTokenAddressSync(
      this.assetMint,
      investor,
      false,
      tokenProgram,
    );
  }
}
