#![allow(deprecated)]

//! SVS-9: Allocator Vault
//!
//! Vault-of-vaults implementation that deposits into multiple underlying SVS-compatible
//! vaults. Users interact with a single share token representing diversified
//! positions across child vaults managed by a curator.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("7g8mK3y5Lp1nG5uV4fHqXJzKd8vY9mE2qB");

#[program]
pub mod svs_9 {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        params: InitializeParams,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    pub fn add_child(
        ctx: Context<AddChild>,
        child_vault: Pubkey,
        child_program: Pubkey,
        target_weight_bps: u16,
        max_weight_bps: u16,
    ) -> Result<()> {
        instructions::add_child::handler(ctx, child_vault, child_program, target_weight_bps, max_weight_bps)
    }

    pub fn remove_child(
        ctx: Context<RemoveChild>,
        child_vault: Pubkey,
    ) -> Result<()> {
        instructions::remove_child::handler(ctx, child_vault)
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        params: DepositParams,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, params)
    }

    pub fn redeem(
        ctx: Context<Redeem>,
        params: RedeemParams,
    ) -> Result<()> {
        instructions::redeem::handler(ctx, params)
    }

    pub fn allocate(
        ctx: Context<Allocate>,
        child_vault: Pubkey,
        amount: u64,
    ) -> Result<()> {
        instructions::allocate::handler(ctx, child_vault, amount)
    }

    pub fn deallocate(
        ctx: Context<Deallocate>,
        child_vault: Pubkey,
        shares: u64,
    ) -> Result<()> {
        instructions::deallocate::handler(ctx, child_vault, shares)
    }

    pub fn rebalance(
        ctx: Context<Rebalance>,
        from_child: Pubkey,
        to_child: Pubkey,
        amount: u64,
    ) -> Result<()> {
        instructions::rebalance::handler(ctx, from_child, to_child, amount)
    }

    pub fn harvest(
        ctx: Context<Harvest>,
    ) -> Result<()> {
        instructions::harvest::handler(ctx)
    }

    pub fn update_weights(
        ctx: Context<UpdateWeights>,
        child_vault: Pubkey,
        target_weight_bps: Option<u16>,
        max_weight_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_weights::handler(ctx, child_vault, target_weight_bps, max_weight_bps)
    }

    pub fn set_curator(
        ctx: Context<SetCurator>,
        new_curator: Pubkey,
    ) -> Result<()> {
        instructions::set_curator::handler(ctx, new_curator)
    }

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn transfer_authority(
        ctx: Context<Admin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
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

    pub fn total_assets(ctx: Context<AllocatorView>) -> Result<()> {
        instructions::view::total_assets(ctx)
    }

    pub fn max_deposit(ctx: Context<AllocatorView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    pub fn child_allocation(ctx: Context<ChildAllocationView>) -> Result<()> {
        instructions::view::child_allocation(ctx)
    }
}
