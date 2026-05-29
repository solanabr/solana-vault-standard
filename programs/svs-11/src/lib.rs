use anchor_lang::prelude::*;

pub mod attestation;
pub mod constants;
pub mod error;
pub mod events;
pub mod hook_extras;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("CMeQ5Lx7AvjuW3DrzNvEkPZSdqKZjjhaTrAmgqBvPKHD");

#[program]
pub mod svs_11 {
    use super::*;

    /// Initialize a new credit vault pool.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        vault_id: u64,
        minimum_investment: u64,
        max_staleness: i64,
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, vault_id, minimum_investment, max_staleness)
    }

    /// Bootstrap the compliance-hook PDAs (`MintConfig` + `ExtraAccountMetaList`)
    /// for a CreditVault's cPOOL shares mint. CPIs into compliance-hook
    /// with `vault_seeds` so the vault PDA — which is the cPOOL mint
    /// authority — satisfies compliance-hook's `Signer == mint_authority`
    /// constraint. Must be called once per pool, after `initialize_pool`,
    /// before any cPOOL transfer can succeed (Token-2022 invokes the hook
    /// on every transfer, and the hook handler reads MintConfig + EAML).
    /// See `instructions/bootstrap_shares_compliance.rs` for the full
    /// architectural rationale.
    pub fn bootstrap_shares_compliance(
        ctx: Context<BootstrapSharesCompliance>,
        args: BootstrapSharesComplianceArgs,
    ) -> Result<()> {
        instructions::bootstrap_shares_compliance::handler(ctx, args)
    }

    /// Open the investment window for deposit and redeem requests.
    pub fn open_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
        instructions::investment_window::open_handler(ctx)
    }

    /// Close the investment window, blocking new requests.
    pub fn close_investment_window(ctx: Context<InvestmentWindow>) -> Result<()> {
        instructions::investment_window::close_handler(ctx)
    }

    /// Request a deposit into the vault.
    pub fn request_deposit(ctx: Context<RequestDeposit>, amount: u64) -> Result<()> {
        instructions::request_deposit::handler(ctx, amount)
    }

    /// Manager approves a pending deposit request.
    pub fn approve_deposit(ctx: Context<ApproveDeposit>) -> Result<()> {
        instructions::approve_deposit::handler(ctx)
    }

    /// Claim approved deposit shares.
    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claim_deposit::handler(ctx)
    }

    /// Manager rejects a pending deposit request.
    pub fn reject_deposit(ctx: Context<RejectDeposit>, reason_code: u8) -> Result<()> {
        instructions::reject_deposit::handler(ctx, reason_code)
    }

    /// Investor cancels their pending deposit request.
    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::cancel_deposit::handler(ctx)
    }

    /// Request a redemption of vault shares.
    pub fn request_redeem<'info>(
        ctx: Context<'_, '_, '_, 'info, RequestRedeem<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::request_redeem::handler(ctx, shares)
    }

    /// Manager approves a pending redemption request, fully and atomically.
    pub fn approve_redeem(ctx: Context<ApproveRedeem>) -> Result<()> {
        instructions::approve_redeem::handler(ctx)
    }

    /// Claim approved redemption assets.
    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::claim_redeem::handler(ctx)
    }

    /// Manager rejects a pending redemption request.
    pub fn reject_redeem<'info>(
        ctx: Context<'_, '_, '_, 'info, RejectRedeem<'info>>,
        reason_code: u8,
    ) -> Result<()> {
        instructions::reject_redeem::handler(ctx, reason_code)
    }

    /// Investor cancels their pending redemption request.
    pub fn cancel_redeem<'info>(
        ctx: Context<'_, '_, '_, 'info, CancelRedeem<'info>>,
    ) -> Result<()> {
        instructions::cancel_redeem::handler(ctx)
    }

    /// Manager repays borrowed capital to the vault.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        instructions::repay::handler(ctx, amount)
    }

    /// Manager draws down capital from the vault.
    pub fn draw_down(ctx: Context<DrawDown>, amount: u64) -> Result<()> {
        instructions::draw_down::handler(ctx, amount)
    }

    /// Pause the vault, halting approvals and capital movements.
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause_handler(ctx)
    }

    /// Unpause the vault.
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause_handler(ctx)
    }

    /// Step 1 of two-step authority transfer: set pending authority.
    pub fn request_transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::request_transfer_authority_handler(ctx, new_authority)
    }

    /// Step 2 of two-step authority transfer: pending authority accepts.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::admin::accept_authority_handler(ctx)
    }

    /// Transfer vault authority to a new address (deprecated -- prefer two-step transfer).
    #[allow(deprecated)]
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority_handler(ctx, new_authority)
    }

    /// Cancel a pending two-step authority transfer.
    pub fn cancel_transfer_authority(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::cancel_transfer_authority_handler(ctx)
    }

    /// Set a new vault manager.
    pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
        instructions::admin::set_manager_handler(ctx, new_manager)
    }

    /// Update the attestation configuration (attester and attestation program).
    pub fn update_attester(
        ctx: Context<UpdateAttester>,
        new_attester: Pubkey,
        new_attestation_program: Pubkey,
    ) -> Result<()> {
        instructions::admin::update_attester_handler(ctx, new_attester, new_attestation_program)
    }

    /// Update the oracle staleness window (non-address param, no timelock).
    pub fn update_oracle_params(
        ctx: Context<UpdateOracleParams>,
        new_max_staleness: Option<i64>,
    ) -> Result<()> {
        instructions::admin::update_oracle_params_handler(ctx, new_max_staleness)
    }

    /// Initialize the vault config PDA for oracle timelock.
    pub fn initialize_vault_config(ctx: Context<InitializeVaultConfig>) -> Result<()> {
        instructions::admin::initialize_vault_config_handler(ctx)
    }

    /// Request an oracle change (starts 24h timelock). Stages both the new
    /// oracle account and its owner program; both are applied atomically.
    pub fn request_oracle_change(
        ctx: Context<RequestOracleChange>,
        new_oracle: Pubkey,
        new_oracle_program: Pubkey,
    ) -> Result<()> {
        instructions::admin::request_oracle_change_handler(ctx, new_oracle, new_oracle_program)
    }

    /// Apply a pending oracle change after timelock expires.
    pub fn apply_oracle_change(ctx: Context<ApplyOracleChange>) -> Result<()> {
        instructions::admin::apply_oracle_change_handler(ctx)
    }

    // =========================================================================
    // Module Admin Instructions (feature-gated)
    // =========================================================================

    #[cfg(feature = "modules")]
    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        entry_fee_bps: u16,
        exit_fee_bps: u16,
        management_fee_bps: u16,
        performance_fee_bps: u16,
    ) -> Result<()> {
        instructions::module_admin::initialize_fee_config(
            ctx,
            entry_fee_bps,
            exit_fee_bps,
            management_fee_bps,
            performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        entry_fee_bps: Option<u16>,
        exit_fee_bps: Option<u16>,
        management_fee_bps: Option<u16>,
        performance_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::module_admin::update_fee_config(
            ctx,
            entry_fee_bps,
            exit_fee_bps,
            management_fee_bps,
            performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn update_lock_config(ctx: Context<UpdateLockConfig>, lock_duration: i64) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
