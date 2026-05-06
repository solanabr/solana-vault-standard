use anchor_lang::prelude::*;

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub manager: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct InvestmentRequested {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct InvestmentApproved {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub nav: u64,
}

#[event]
pub struct InvestmentClaimed {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct InvestmentRejected {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub reason_code: u8,
}

#[event]
pub struct InvestmentCancelled {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RedemptionRequested {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct RedemptionApproved {
    pub vault: Pubkey,
    pub investor: Pubkey,
    /// Shares burned in THIS settlement (the pro-rata cut). For full
    /// fulfillment this equals the original `shares_locked`; for partial,
    /// it is the rounded-down `remaining * ratio / 1e18`.
    pub shares: u64,
    /// USDC paid out for this settlement.
    pub assets: u64,
    /// NAV used for this settlement.
    pub nav: u64,
    /// Fixed-point batch settlement ratio scaled to 1e18.
    pub ratio_scaled: u128,
    /// Cumulative shares fulfilled across all settlements for this request.
    pub cumulative_fulfilled: u64,
    /// Settlement-date epoch the request is now queued for. Equals
    /// `next_settlement_at` arg on partial; `redemption_request.queued_for_settlement_at`
    /// (unchanged) on full fulfillment.
    pub next_settlement_at: i64,
    /// Manager pubkey that approved this settlement.
    pub manager: Pubkey,
}

#[event]
pub struct RedemptionClaimed {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub assets: u64,
}

#[event]
pub struct RedemptionRejected {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
    pub reason_code: u8,
}

#[event]
pub struct RedemptionCancelled {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub shares: u64,
}

#[event]
pub struct Repayment {
    pub vault: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DrawDown {
    pub vault: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct AccountFrozen {
    pub vault: Pubkey,
    pub investor: Pubkey,
    pub frozen_by: Pubkey,
}

#[event]
pub struct AccountUnfrozen {
    pub vault: Pubkey,
    pub investor: Pubkey,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityTransferRequested {
    pub vault: Pubkey,
    pub current_authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ManagerChanged {
    pub vault: Pubkey,
    pub old_manager: Pubkey,
    pub new_manager: Pubkey,
}

#[event]
pub struct WindowOpened {
    pub vault: Pubkey,
}

#[event]
pub struct WindowClosed {
    pub vault: Pubkey,
}

#[event]
pub struct AttesterUpdated {
    pub vault: Pubkey,
    pub old_attester: Pubkey,
    pub new_attester: Pubkey,
    pub old_attestation_program: Pubkey,
    pub new_attestation_program: Pubkey,
}

#[event]
pub struct OracleConfigUpdated {
    pub vault: Pubkey,
    pub old_oracle: Pubkey,
    pub new_oracle: Pubkey,
    pub old_program: Pubkey,
    pub new_program: Pubkey,
    pub new_max_staleness: i64,
}

#[event]
pub struct ModuleConfigChanged {
    pub vault: Pubkey,
    pub config_type: u8,
}

#[event]
pub struct OracleChangeRequested {
    pub vault: Pubkey,
    pub pending_oracle: Pubkey,
    pub oracle_change_at: i64,
}

#[event]
pub struct OracleChangeApplied {
    pub vault: Pubkey,
    pub old_oracle: Pubkey,
    pub new_oracle: Pubkey,
}

#[event]
pub struct OracleSourceChanged {
    pub vault: Pubkey,
    pub old_source: u8,
    pub new_source: u8,
}

#[event]
pub struct VaultConfigInitialized {
    pub vault: Pubkey,
    pub vault_config: Pubkey,
}

#[event]
pub struct ComplianceOfficerUpdated {
    pub vault: Pubkey,
    pub old_officer: Pubkey,
    pub new_officer: Pubkey,
}

#[event]
pub struct SharesComplianceBootstrapped {
    /// CreditVault PDA whose cPOOL shares mint was bootstrapped.
    pub vault: Pubkey,
    /// Token-2022 cPOOL shares mint (bound to compliance-hook).
    pub shares_mint: Pubkey,
    /// Compliance mode the cPOOL was bootstrapped under.
    pub mode: crate::instructions::bootstrap_shares_compliance::BootstrapComplianceMode,
    /// Attestation program ID the cPOOL's MintConfig was bound to.
    /// `Pubkey::default()` in FreelyTransferable mode.
    pub attestation_program: Pubkey,
}
