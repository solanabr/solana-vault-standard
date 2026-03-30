use anchor_lang::prelude::*;

pub mod attestation;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("Bf17gDR2JdKTWdoTWK3Va9YQtkpePRAAVxMCaokj8ZFW");

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
    pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64) -> Result<()> {
        instructions::request_redeem::handler(ctx, shares)
    }

    /// Manager approves a pending redemption request.
    pub fn approve_redeem(ctx: Context<ApproveRedeem>) -> Result<()> {
        instructions::approve_redeem::handler(ctx)
    }

    /// Claim approved redemption assets.
    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::claim_redeem::handler(ctx)
    }

    /// Manager rejects a pending redemption request.
    pub fn reject_redeem(ctx: Context<RejectRedeem>, reason_code: u8) -> Result<()> {
        instructions::reject_redeem::handler(ctx, reason_code)
    }

    /// Investor cancels their pending redemption request.
    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
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

    /// Freeze an investor account for compliance.
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::compliance::freeze_handler(ctx)
    }

    /// Unfreeze a previously frozen investor account.
    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        instructions::compliance::unfreeze_handler(ctx)
    }

    /// Pause the vault, halting approvals and capital movements.
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause_handler(ctx)
    }

    /// Unpause the vault.
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause_handler(ctx)
    }

    /// Transfer vault authority to a new address.
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority_handler(ctx, new_authority)
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

    /// Update the NAV oracle configuration.
    pub fn update_oracle_config(
        ctx: Context<UpdateOracleConfig>,
        new_nav_oracle: Pubkey,
        new_oracle_program: Pubkey,
        new_max_staleness: i64,
    ) -> Result<()> {
        instructions::admin::update_oracle_config_handler(
            ctx,
            new_nav_oracle,
            new_oracle_program,
            new_max_staleness,
        )
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
