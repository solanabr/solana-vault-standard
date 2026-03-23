//! SVS-6: Confidential Streaming Yield Vault
//!
//! Combines SVS-5 streaming yield with SVS-3 confidential transfers.
//! Share balances are encrypted on-chain via Token-2022 Confidential Transfers.
//! Streaming yield math operates on public aggregate values (base_assets, shares_mint.supply).

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE");

#[program]
pub mod svs_6 {
    use super::*;

    /// Initialize a new confidential streaming vault
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        auditor_elgamal_pubkey: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, auditor_elgamal_pubkey)
    }

    /// Configure user's shares account for confidential transfers
    pub fn configure_account(
        ctx: Context<ConfigureAccount>,
        decryptable_zero_balance: [u8; 36],
        proof_instruction_offset: i8,
    ) -> Result<()> {
        instructions::configure_account::handler(
            ctx,
            decryptable_zero_balance,
            proof_instruction_offset,
        )
    }

    /// Deposit assets and receive confidential shares
    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    /// Mint exact confidential shares by depositing required assets
    pub fn mint(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
        instructions::mint::handler(ctx, shares, max_assets_in)
    }

    /// Apply pending balance to available balance
    pub fn apply_pending(
        ctx: Context<ApplyPending>,
        new_decryptable_available_balance: [u8; 36],
        expected_pending_balance_credit_counter: u64,
    ) -> Result<()> {
        instructions::apply_pending::handler(
            ctx,
            new_decryptable_available_balance,
            expected_pending_balance_credit_counter,
        )
    }

    /// Withdraw exact assets by burning confidential shares (requires ZK proofs)
    pub fn withdraw(
        ctx: Context<Withdraw>,
        assets: u64,
        max_shares_in: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        instructions::withdraw::handler(
            ctx,
            assets,
            max_shares_in,
            new_decryptable_available_balance,
        )
    }

    /// Redeem confidential shares for assets (requires ZK proofs)
    pub fn redeem(
        ctx: Context<Redeem>,
        shares: u64,
        min_assets_out: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        instructions::redeem::handler(
            ctx,
            shares,
            min_assets_out,
            new_decryptable_available_balance,
        )
    }

    /// Distribute yield as a time-interpolated stream (authority only)
    pub fn distribute_yield(
        ctx: Context<DistributeYield>,
        yield_amount: u64,
        duration: i64,
    ) -> Result<()> {
        instructions::distribute_yield::handler(ctx, yield_amount, duration)
    }

    /// Checkpoint: finalize accrued streaming yield (permissionless)
    pub fn checkpoint(ctx: Context<Checkpoint>) -> Result<()> {
        instructions::checkpoint::handler(ctx)
    }

    /// Pause all vault operations (emergency)
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    // ============ Module Admin (feature: modules) ============

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

    // ============ View Functions (CPI composable) ============

    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Returns 0 — encrypted balances cannot be read on-chain. SDK handles preview.
    pub fn max_withdraw(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Returns 0 — encrypted balances cannot be read on-chain. SDK handles preview.
    pub fn max_redeem(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }

    pub fn get_stream_info(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_stream_info(ctx)
    }
}
