use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU");

#[program]
pub mod svs_9 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, vault_id: u64, idle_buffer_bps: u16) -> Result<()> {
        initialize_handler(ctx, vault_id, idle_buffer_bps)
    }

    pub fn add_child(ctx: Context<AddChild>, max_weight_bps: u16) -> Result<()> {
        add_child_handler(ctx, max_weight_bps)
    }

    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        deposit_handler(ctx, assets, min_shares_out)
    }

    pub fn allocate(ctx: Context<Allocate>, assets: u64, min_shares_out: u64) -> Result<()> {
        allocate_handler(ctx, assets, min_shares_out)
    }

    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_assets_out: u64) -> Result<()> {
        redeem_handler(ctx, shares, min_assets_out)
    }

    pub fn harvest(ctx: Context<Harvest>, min_assets_out: u64) -> Result<()> {
        harvest_handler(ctx, min_assets_out)
    }

    pub fn deallocate(
        ctx: Context<Deallocate>,
        shares_to_withdraw: u64,
        min_assets_out: u64,
    ) -> Result<()> {
        deallocate_handler(ctx, shares_to_withdraw, min_assets_out)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        admin::unpause(ctx)
    }

    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        admin::transfer_authority(ctx, new_authority)
    }

    pub fn set_curator(ctx: Context<Admin>, new_curator: Pubkey) -> Result<()> {
        admin::set_curator(ctx, new_curator)
    }

    pub fn remove_child(ctx: Context<RemoveChild>) -> Result<()> {
        remove_child_handler(ctx)
    }

    pub fn update_weights(ctx: Context<UpdateWeights>, new_max_weight_bps: u16) -> Result<()> {
        update_weights_handler(ctx, new_max_weight_bps)
    }

    pub fn rebalance(ctx: Context<Rebalance>, min_out: u64) -> Result<()> {
        rebalance_handler(ctx, min_out)
    }

    pub fn mint(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
        mint_handler(ctx, shares, max_assets_in)
    }

    pub fn withdraw(ctx: Context<WithdrawAssets>, assets: u64, max_shares_in: u64) -> Result<()> {
        withdraw_handler(ctx, assets, max_shares_in)
    }

    // View instructions
    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        view::preview_deposit(ctx, assets)
    }

    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        view::preview_mint(ctx, shares)
    }

    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        view::preview_withdraw(ctx, assets)
    }

    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        view::preview_redeem(ctx, shares)
    }

    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        view::convert_to_shares_view(ctx, assets)
    }

    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        view::convert_to_assets_view(ctx, shares)
    }

    pub fn get_total_assets(ctx: Context<VaultView>) -> Result<()> {
        view::total_assets(ctx)
    }

    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        view::max_deposit(ctx)
    }

    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        view::max_mint(ctx)
    }

    pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        view::max_withdraw(ctx)
    }

    pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        view::max_redeem(ctx)
    }

    pub fn get_idle_balance(ctx: Context<VaultView>) -> Result<()> {
        view::get_idle_balance(ctx)
    }

    pub fn get_child_allocation_info(ctx: Context<ChildAllocationView>) -> Result<()> {
        view::get_child_allocation_info(ctx)
    }

    // Module admin instructions
    #[cfg(feature = "modules")]
    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        entry_fee_bps: u16,
        exit_fee_bps: u16,
        management_fee_bps: u16,
        performance_fee_bps: u16,
    ) -> Result<()> {
        module_admin::initialize_fee_config(
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
        module_admin::update_fee_config(
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
        module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        module_admin::initialize_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn update_lock_config(ctx: Context<UpdateLockConfig>, lock_duration: i64) -> Result<()> {
        module_admin::update_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
