//! SVS-10: Async Vault with Request/Fulfill/Claim Lifecycle
//!
//! ERC-7540 equivalent for Solana. Deposits and redemptions go through an async
//! request→fulfill→claim flow using oracle prices for share/asset conversion.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ");

#[program]
pub mod svs_10 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri)
    }

    pub fn request_deposit(
        ctx: Context<RequestDeposit>,
        assets: u64,
        receiver: Pubkey,
    ) -> Result<()> {
        instructions::request_deposit::handler(ctx, assets, receiver)
    }

    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::cancel_deposit::handler(ctx)
    }

    pub fn fulfill_deposit(ctx: Context<FulfillDeposit>, oracle_price: Option<u64>) -> Result<()> {
        instructions::fulfill_deposit::handler(ctx, oracle_price)
    }

    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claim_deposit::handler(ctx)
    }

    pub fn request_redeem(
        ctx: Context<RequestRedeem>,
        shares: u64,
        receiver: Pubkey,
    ) -> Result<()> {
        instructions::request_redeem::handler(ctx, shares, receiver)
    }

    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        instructions::cancel_redeem::handler(ctx)
    }

    pub fn fulfill_redeem(ctx: Context<FulfillRedeem>, oracle_price: Option<u64>) -> Result<()> {
        instructions::fulfill_redeem::handler(ctx, oracle_price)
    }

    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::claim_redeem::handler(ctx)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    pub fn set_vault_operator(ctx: Context<Admin>, new_operator: Pubkey) -> Result<()> {
        instructions::admin::set_vault_operator(ctx, new_operator)
    }

    pub fn set_cancel_after(ctx: Context<Admin>, cancel_after: i64) -> Result<()> {
        instructions::admin::set_cancel_after(ctx, cancel_after)
    }

    pub fn set_operator(
        ctx: Context<SetOperator>,
        operator: Pubkey,
        can_fulfill_deposit: bool,
        can_fulfill_redeem: bool,
        can_claim: bool,
    ) -> Result<()> {
        instructions::set_operator::handler(
            ctx,
            operator,
            can_fulfill_deposit,
            can_fulfill_redeem,
            can_claim,
        )
    }

    // ============ View Functions ============

    pub fn pending_deposit_request(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::pending_deposit_request(ctx)
    }

    pub fn claimable_deposit_request(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::claimable_deposit_request(ctx)
    }

    pub fn pending_redeem_request(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::pending_redeem_request(ctx)
    }

    pub fn claimable_redeem_request(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::claimable_redeem_request(ctx)
    }

    // ============ Module Admin Instructions (requires "modules" feature) ============

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
