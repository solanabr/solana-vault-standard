use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod waterfall;

use instructions::*;

declare_id!("FM3ZfmPSdQzFniZSDXc6FfXKFvXRSNQXeTdPKC8tz5C");

#[program]
pub mod svs_12 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, waterfall_mode: u8) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, waterfall_mode)
    }

    pub fn add_tranche(
        ctx: Context<AddTranche>,
        priority: u8,
        subordination_bps: u16,
        target_yield_bps: u16,
        cap_bps: u16,
    ) -> Result<()> {
        instructions::add_tranche::handler(
            ctx,
            priority,
            subordination_bps,
            target_yield_bps,
            cap_bps,
        )
    }

    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        instructions::redeem::handler(ctx, shares, min_assets_out)
    }

    pub fn distribute_yield(ctx: Context<DistributeYield>, total_yield: u64) -> Result<()> {
        instructions::distribute_yield::handler(ctx, total_yield)
    }

    pub fn record_loss(ctx: Context<RecordLoss>, total_loss: u64) -> Result<()> {
        instructions::record_loss::handler(ctx, total_loss)
    }

    pub fn rebalance_tranches(ctx: Context<RebalanceTranches>, amount: u64) -> Result<()> {
        instructions::rebalance::handler(ctx, amount)
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

    pub fn set_manager(ctx: Context<Admin>, new_manager: Pubkey) -> Result<()> {
        instructions::admin::set_manager(ctx, new_manager)
    }

    pub fn preview_deposit(ctx: Context<TrancheView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    pub fn preview_redeem(ctx: Context<TrancheView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    pub fn get_tranche_state(ctx: Context<TrancheView>) -> Result<()> {
        instructions::view::get_tranche_state(ctx)
    }

    pub fn update_tranche_config(
        ctx: Context<UpdateTrancheConfig>,
        target_yield_bps: Option<u16>,
        cap_bps: Option<u16>,
        subordination_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_tranche_config::handler(
            ctx,
            target_yield_bps,
            cap_bps,
            subordination_bps,
        )
    }

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
