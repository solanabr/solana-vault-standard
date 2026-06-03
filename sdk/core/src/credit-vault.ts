import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
  type AccountMeta,
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
} from "./credit-vault-pda";
import {
  COMPLIANCE_HOOK_PROGRAM_ID,
  getExtraAccountMetaListAddress,
  getMintConfigAddress,
} from "./compliance-hook-pda";
import { ComplianceMode } from "./compliance-hook";
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
  attester: PublicKey;
  attestationProgram: PublicKey;
  vaultId: BN;
  totalAssets: BN;
  totalShares: BN;
  totalPendingDeposits: BN;
  minimumInvestment: BN;
  investmentWindowOpen: boolean;
  bump: number;
  redemptionEscrowBump: number;
  paused: boolean;
  // Pluggable oracle: `navOracle` is the configured oracle account and
  // `oracleProgram` its owner program; the vault reads the generic
  // SvsOraclePrice header. `lastSeenNavSequence` is the consumed sequence.
  lastSeenNavSequence: BN;
}

export interface CreateCreditVaultParams {
  assetMint: PublicKey;
  manager: PublicKey;
  vaultId: BN | number;
  navOracle: PublicKey;
  oracleProgram: PublicKey;
  attester: PublicKey;
  attestationProgram: PublicKey;
  minimumInvestment: BN;
  maxStaleness: BN;
}

/**
 * Args for {@link CreditVault.bootstrapSharesCompliance}. Mirror of the
 * on-chain `BootstrapSharesComplianceArgs` shape (svs-11
 * `instructions/bootstrap_shares_compliance.rs`), with optional defaults
 * applied for FreelyTransferable callers.
 *
 * Trust-anchor invariants enforced by compliance-hook on the inner CPI:
 *   - `attestationProgram` and `attestationIssuer` MUST NOT be the
 *     default pubkey when `mode == permissioned`.
 *   - `poolPolicy` MUST be `Some` when `mode == permissioned` and `None`
 *     when `mode == freelyTransferable`.
 *
 * For `Permissioned` deployments the operator must ALSO issue a
 * system-attestation for the vault PDA (subject = `vault.key()`) via
 * the configured `attestationProgram` — the cPOOL hook validates BOTH
 * transfer owners on every redemption transfer, and
 * `redemption_escrow.owner == vault`.
 */
export interface BootstrapSharesComplianceParams {
  /** Compliance mode for the cPOOL shares mint. */
  mode: ComplianceMode;
  /** Required for `permissioned`; must be `null` for `freelyTransferable`. */
  poolPolicy?: PublicKey | null;
  /**
   * Program owning acceptable attestation accounts. Required (non-default)
   * for `permissioned`. Defaults to `PublicKey.default` for
   * `freelyTransferable`.
   */
  attestationProgram?: PublicKey;
  /**
   * Expected `issuer` field on attestation payloads. Required (non-default)
   * for `permissioned`.
   */
  attestationIssuer?: PublicKey;
  /**
   * Required `attestation_type` byte. Defaults to 0 (generic KYC tier).
   */
  requiredAttestationType?: number;
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

    // initialize_pool binds the cPOOL mint's Token-2022 TransferHook
    // extension to compliance-hook in this tx. The dependent
    // compliance-hook PDAs (MintConfig, EAML) and infrastructure
    // attestations (wrapper / vault / admin) are initialized by direct
    // compliance-hook + attestation-program calls after pool creation.
    // See svs-11 initialize_pool.rs for the cross-program invariant rationale.
    await program.methods
      .initializePool(id, params.minimumInvestment, params.maxStaleness)
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
        attester: params.attester,
        attestationProgram: params.attestationProgram,
        assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    return CreditVault.load(program, params.assetMint, id);
  }

  /**
   * Bootstrap the compliance-hook PDAs (`MintConfig` +
   * `ExtraAccountMetaList`) for the cPOOL shares mint.
   *
   * MUST be called after {@link CreditVault.create} and before any
   * cPOOL transfer (request_redeem / cancel_redeem) can succeed —
   * `initialize_pool` binds the TransferHook extension on cPOOL but
   * intentionally does NOT initialize the dependent compliance-hook
   * PDAs (the vault PDA is the cPOOL mint authority and PDAs cannot
   * top-level-sign for compliance-hook's `Signer == mint_authority`
   * constraint). The on-chain `bootstrap_shares_compliance` ix CPIs
   * into compliance-hook with `vault_seeds`, satisfying that
   * constraint via Anchor's `invoke_signed`.
   *
   * For `mode == permissioned`, the caller must ALSO issue a system
   * attestation for the vault PDA via the configured attestation
   * program (subject = `vault.key()`); without it, the destination-
   * side attestation check on `request_redeem`'s cPOOL transfer
   * rejects with `AttestationNotFound` (`redemption_escrow.owner ==
   * vault`).
   *
   * Idempotency: the underlying compliance-hook init handlers use
   * Anchor's `init` constraint, which fails with "account already in
   * use" on re-invocation. Operators should call this exactly once
   * per pool.
   */
  async bootstrapSharesCompliance(
    authority: PublicKey,
    params: BootstrapSharesComplianceParams,
  ): Promise<string> {
    const [mintConfig] = getMintConfigAddress(this.sharesMint);
    const [extraAccountMetaList] = getExtraAccountMetaListAddress(
      this.sharesMint,
    );
    return this.program.methods
      .bootstrapSharesCompliance({
        mode: params.mode,
        poolPolicy: params.poolPolicy ?? null,
        attestationProgram: params.attestationProgram ?? PublicKey.default,
        attestationIssuer: params.attestationIssuer ?? PublicKey.default,
        requiredAttestationType: params.requiredAttestationType ?? 0,
      })
      .accountsPartial({
        authority,
        vault: this.vault,
        sharesMint: this.sharesMint,
        mintConfig,
        extraAccountMetaList,
        complianceHookProgram: COMPLIANCE_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
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
        assetTokenProgram: this.assetTokenProgram,
        systemProgram: SystemProgram.programId,
        clock: SYSVAR_CLOCK_PUBKEY,
      })
      .rpc();
  }

  async approveDeposit(
    manager: PublicKey,
    investor: PublicKey,
    oracleAccount: PublicKey,
    attestation: PublicKey,
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
        // The configured oracle account (vault.nav_oracle), read through the
        // generic SvsOraclePrice header.
        oracleAccount,
        attestation,
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
    remainingAccounts?: AccountMeta[],
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
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    const builder = this.program.methods.requestRedeem(shares).accountsPartial({
      investor,
      vault: this.vault,
      redemptionRequest,
      sharesMint: this.sharesMint,
      investorSharesAccount,
      redemptionEscrow: this.redemptionEscrow,
      assetMint: this.assetMint,
      claimableTokens,
      attestation,
      assetTokenProgram: this.assetTokenProgram,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      clock: SYSVAR_CLOCK_PUBKEY,
    });

    return (
      remainingAccounts?.length
        ? builder.remainingAccounts(remainingAccounts)
        : builder
    ).rpc();
  }

  async approveRedeem(
    manager: PublicKey,
    investor: PublicKey,
    oracleAccount: PublicKey,
    attestation: PublicKey,
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
        // The configured oracle account (vault.nav_oracle).
        oracleAccount,
        attestation,
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

  async cancelRedeem(
    investor: PublicKey,
    /// Token-2022 TransferHook extras for the cPOOL `transfer_checked`
    /// CPI. The cancel-redemption transfer moves cPOOL from the vault's
    /// redemption escrow back to the investor, so the EAML must resolve
    /// the attestation PDAs for `(source = vault, destination = investor)`
    /// — the opposite direction of `requestRedeem`. svs-11's
    /// `initialize_pool` always binds the TransferHook extension on
    /// cPOOL, so production callers must always pass the resolved
    /// extras here; the on-chain handler forwards them through
    /// `add_extra_accounts_for_execute_cpi` into the inner CPI. The
    /// optional shape preserves the bare bones for unit tests against
    /// hookless mints.
    remainingAccounts?: AccountMeta[],
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
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    const builder = this.program.methods.cancelRedeem().accountsPartial({
      investor,
      vault: this.vault,
      redemptionRequest,
      sharesMint: this.sharesMint,
      assetMint: this.assetMint,
      claimableTokens,
      investorSharesAccount,
      redemptionEscrow: this.redemptionEscrow,
      assetTokenProgram: this.assetTokenProgram,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    });

    return (
      remainingAccounts?.length
        ? builder.remainingAccounts(remainingAccounts)
        : builder
    ).rpc();
  }

  /**
   * Manager rejects a pending redemption request, returning the escrowed
   * cPOOL shares to the investor and closing the request + claimable PDAs.
   *
   * Like {@link cancelRedeem}, the share transfer flows escrow → investor, so
   * production callers on a hook-bound cPOOL mint must pass the resolved
   * cancel-direction TransferHook extras (source = vault, destination =
   * investor) via `remainingAccounts`. The optional shape supports unit tests
   * against hookless mints.
   */
  async rejectRedeem(
    manager: PublicKey,
    investor: PublicKey,
    reasonCode: number = 0,
    remainingAccounts?: AccountMeta[],
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
    const investorSharesAccount = this.getInvestorSharesAccount(investor);

    const builder = this.program.methods
      .rejectRedeem(reasonCode)
      .accountsPartial({
        manager,
        vault: this.vault,
        redemptionRequest,
        investor,
        sharesMint: this.sharesMint,
        assetMint: this.assetMint,
        claimableTokens,
        investorSharesAccount,
        redemptionEscrow: this.redemptionEscrow,
        assetTokenProgram: this.assetTokenProgram,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });

    return (
      remainingAccounts?.length
        ? builder.remainingAccounts(remainingAccounts)
        : builder
    ).rpc();
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

  /**
   * @deprecated Single-step transfer hands the root of trust to `newAuthority`
   * in one transaction with no acceptance step. Prefer the two-step
   * {@link requestTransferAuthority} + {@link acceptAuthority} pattern, which
   * proves the incoming key controls its signer before the swap. The on-chain
   * single-step path also refuses to run while a two-step transfer is pending.
   */
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

  /**
   * Step 1 of the safe authority rotation: the current `authority` nominates
   * `newAuthority` as pending. The swap only completes when `newAuthority`
   * calls {@link acceptAuthority}; until then {@link cancelTransferAuthority}
   * clears it.
   */
  async requestTransferAuthority(
    authority: PublicKey,
    newAuthority: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .requestTransferAuthority(newAuthority)
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Step 2 of the safe authority rotation: the pending `newAuthority` signs to
   * accept, proving it controls the key before the root of trust moves.
   */
  async acceptAuthority(newAuthority: PublicKey): Promise<string> {
    return this.program.methods
      .acceptAuthority()
      .accountsPartial({
        newAuthority,
        vault: this.vault,
      })
      .rpc();
  }

  /** Clears a pending two-step authority transfer (current authority only). */
  async cancelTransferAuthority(authority: PublicKey): Promise<string> {
    return this.program.methods
      .cancelTransferAuthority()
      .accountsPartial({
        authority,
        vault: this.vault,
      })
      .rpc();
  }

  /**
   * Repoint the vault's NAV oracle (authority-gated, immediate). `newOracle`
   * is the oracle account and `newOracleProgram` its owner program; the
   * handler validates each account key against its arg, that the program is
   * executable, and that the oracle is owned by the program, then seeds the
   * replay floor from the incoming oracle's sequence.
   */
  async setOracle(
    authority: PublicKey,
    newOracle: PublicKey,
    newOracleProgram: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .setOracle(newOracle, newOracleProgram)
      .accountsPartial({
        authority,
        vault: this.vault,
        newOracleProgramAccount: newOracleProgram,
        newOracleAccount: newOracle,
      })
      .rpc();
  }

  /**
   * Update the oracle staleness window (authority-gated). Oracle address +
   * program changes go through {@link setOracle}; this only adjusts the
   * non-address parameter. Pass a `BN` to set `max_staleness`, or `null` to
   * leave it unchanged (the on-chain arg is `Option<i64>`).
   */
  async updateOracleParams(
    authority: PublicKey,
    newMaxStaleness: BN | null,
  ): Promise<string> {
    return this.program.methods
      .updateOracleParams(newMaxStaleness)
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

  async updateAttester(
    authority: PublicKey,
    newAttester: PublicKey,
    newAttestationProgram: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .updateAttester(newAttester, newAttestationProgram)
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

  convertToShares(
    assets: bigint,
    totalAssets: bigint,
    totalShares: bigint,
    decimalsOffset: number = 0,
  ): bigint {
    const offset = BigInt(10 ** decimalsOffset);
    return (assets * (totalShares + offset)) / (totalAssets + BigInt(1));
  }

  convertToAssets(
    shares: bigint,
    totalAssets: bigint,
    totalShares: bigint,
    decimalsOffset: number = 0,
  ): bigint {
    const offset = BigInt(10 ** decimalsOffset);
    return (shares * (totalAssets + BigInt(1))) / (totalShares + offset);
  }

  async previewInvestment(assets: BN): Promise<BN> {
    const state = await this.refresh();
    const shares = this.convertToShares(
      BigInt(assets.toString()),
      BigInt(state.totalAssets.toString()),
      BigInt(state.totalShares.toString()),
    );
    return new BN(shares.toString());
  }

  async previewRedemption(shares: BN): Promise<BN> {
    const state = await this.refresh();
    const assets = this.convertToAssets(
      BigInt(shares.toString()),
      BigInt(state.totalAssets.toString()),
      BigInt(state.totalShares.toString()),
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
}
