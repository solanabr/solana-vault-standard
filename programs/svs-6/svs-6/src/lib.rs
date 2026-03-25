use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

pub use error::*;
pub use events::*;
pub use state::*;

declare_id!("SVS6111111111111111111111111111111111111111"); // TODO: Replace after devnet deploy

#[program]
pub mod svs_6 {
    use super::*;

    // ── Initialize ──

    pub fn initialize(
        ctx: Context<instructions::Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
        auditor_elgamal_pubkey: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri, auditor_elgamal_pubkey)
    }

    // ── Core Operations ──

    pub fn deposit(
        ctx: Context<instructions::Deposit>,
        assets: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    pub fn mint(
        ctx: Context<instructions::MintShares>,
        shares: u64,
        max_assets_in: u64,
    ) -> Result<()> {
        instructions::mint::handler(ctx, shares, max_assets_in)
    }

    pub fn withdraw(
        ctx: Context<instructions::Withdraw>,
        assets: u64,
        max_shares_in: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        instructions::withdraw::handler(ctx, assets, max_shares_in, new_decryptable_available_balance)
    }

    pub fn redeem(
        ctx: Context<instructions::Redeem>,
        shares: u64,
        min_assets_out: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        instructions::redeem::handler(ctx, shares, min_assets_out, new_decryptable_available_balance)
    }

    // ── Confidential Transfer Operations ──

    pub fn configure_account(
        ctx: Context<instructions::ConfigureAccount>,
        decryptable_zero_balance: [u8; 36],
        proof_instruction_offset: i8,
    ) -> Result<()> {
        instructions::configure_account::handler(ctx, decryptable_zero_balance, proof_instruction_offset)
    }

    pub fn apply_pending(
        ctx: Context<instructions::ApplyPending>,
        new_decryptable_available_balance: [u8; 36],
        expected_pending_balance_credit_counter: u64,
    ) -> Result<()> {
        instructions::apply_pending::handler(
            ctx,
            new_decryptable_available_balance,
            expected_pending_balance_credit_counter,
        )
    }

    // ── Streaming Operations ──

    pub fn distribute_yield(
        ctx: Context<instructions::DistributeYield>,
        amount: u64,
        duration_seconds: i64,
    ) -> Result<()> {
        instructions::distribute_yield::handler(ctx, amount, duration_seconds)
    }

    pub fn checkpoint(ctx: Context<instructions::Checkpoint>) -> Result<()> {
        instructions::checkpoint::handler(ctx)
    }

    // ── Admin Operations ──

    pub fn pause(ctx: Context<instructions::Pause>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<instructions::Unpause>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn transfer_authority(ctx: Context<instructions::TransferAuthority>) -> Result<()> {
        instructions::admin::transfer_authority(ctx)
    }

    // ── View Functions ──

    pub fn total_assets(ctx: Context<instructions::VaultView>) -> Result<()> {
        instructions::view::total_assets(ctx)
    }

    pub fn preview_deposit(ctx: Context<instructions::VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    pub fn preview_mint(ctx: Context<instructions::VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    pub fn preview_withdraw(ctx: Context<instructions::VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    pub fn preview_redeem(ctx: Context<instructions::VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    pub fn convert_to_shares(ctx: Context<instructions::VaultView>, assets: u64) -> Result<()> {
        instructions::view::view_convert_to_shares(ctx, assets)
    }

    pub fn convert_to_assets(ctx: Context<instructions::VaultView>, shares: u64) -> Result<()> {
        instructions::view::view_convert_to_assets(ctx, shares)
    }

    pub fn max_deposit(ctx: Context<instructions::VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    pub fn max_mint(ctx: Context<instructions::VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    pub fn max_withdraw(ctx: Context<instructions::VaultView>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    pub fn max_redeem(ctx: Context<instructions::VaultView>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }

    // ── Module Admin (behind "modules" feature) ──

    #[cfg(feature = "modules")]
    pub fn initialize_fee_config(
        ctx: Context<instructions::InitializeFeeConfig>,
        entry_fee_bps: u16,
        exit_fee_bps: u16,
        management_fee_bps: u16,
        performance_fee_bps: u16,
    ) -> Result<()> {
        instructions::module_admin::initialize_fee_config(
            ctx, entry_fee_bps, exit_fee_bps, management_fee_bps, performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn update_fee_config(
        ctx: Context<instructions::UpdateFeeConfig>,
        entry_fee_bps: Option<u16>,
        exit_fee_bps: Option<u16>,
        management_fee_bps: Option<u16>,
        performance_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::module_admin::update_fee_config(
            ctx, entry_fee_bps, exit_fee_bps, management_fee_bps, performance_fee_bps,
        )
    }

    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<instructions::InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<instructions::UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<instructions::InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn update_lock_config(
        ctx: Context<instructions::UpdateLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<instructions::InitializeAccessConfig>,
        mode: crate::state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<instructions::UpdateAccessConfig>,
        mode: Option<crate::state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
