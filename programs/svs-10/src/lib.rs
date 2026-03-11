//! SVS-10: Async Vault (ERC-7540)
//!
//! Replaces atomic deposit/redeem with a request→fulfill→claim lifecycle.
//! An operator processes requests asynchronously, enabling strategies that
//! cannot settle instantly: illiquid positions, cross-chain bridges, off-chain
//! verification, or any workflow requiring operator approval.
//!
//! Lifecycle:
//!   Deposit: request_deposit → fulfill_deposit → claim_deposit
//!   Redeem:  request_redeem  → fulfill_redeem  → claim_redeem
//!
//! Key differences from SVS-1:
//! - share_escrow holds shares during pending redemptions
//! - claimable_tokens (per-user) holds assets after redeem fulfillment
//! - operator role processes requests (separate from authority)
//! - One active request per user per vault (enforced by PDA uniqueness)

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("SVS1oFN8c3S15R5FjDxCPmEu8JNo7kyJBHGHT6Y7L2T");

#[program]
pub mod svs_10 {
    use super::*;

    // ============================================================
    // Lifecycle: Deposit Flow
    // ============================================================

    /// Initialize a new async vault for the given asset.
    /// The operator is passed as an account, not a parameter.
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri)
    }

    /// Lock assets and create a deposit request (ERC-7540: requestDeposit)
    pub fn request_deposit(
        ctx: Context<RequestDeposit>,
        assets: u64,
        receiver: Pubkey,
    ) -> Result<()> {
        instructions::request_deposit::handler(ctx, assets, receiver)
    }

    /// Cancel a pending deposit request and return assets to user
    pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
        instructions::cancel_deposit::handler(ctx)
    }

    /// Operator fulfills a deposit request: sets shares_claimable (ERC-7540: operator fulfillment)
    pub fn fulfill_deposit(ctx: Context<FulfillDeposit>) -> Result<()> {
        instructions::fulfill_deposit::handler(ctx)
    }

    /// Mint claimable shares to receiver (ERC-7540: deposit/claim)
    pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
        instructions::claim_deposit::handler(ctx)
    }

    // ============================================================
    // Lifecycle: Redeem Flow
    // ============================================================

    /// Lock shares and create a redeem request (ERC-7540: requestRedeem)
    pub fn request_redeem(
        ctx: Context<RequestRedeem>,
        shares: u64,
        receiver: Pubkey,
    ) -> Result<()> {
        instructions::request_redeem::handler(ctx, shares, receiver)
    }

    /// Cancel a pending redeem request and return shares to user
    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        instructions::cancel_redeem::handler(ctx)
    }

    /// Operator fulfills a redeem request: burns shares, moves assets to claimable escrow
    pub fn fulfill_redeem(ctx: Context<FulfillRedeem>) -> Result<()> {
        instructions::fulfill_redeem::handler(ctx)
    }

    /// Transfer claimable assets to receiver (ERC-7540: redeem/claim)
    pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
        instructions::claim_redeem::handler(ctx)
    }

    // ============================================================
    // Operator Management
    // ============================================================

    /// Grant or revoke per-user operator approval (ERC-7540: setOperator)
    pub fn set_operator(ctx: Context<SetOperator>, approved: bool) -> Result<()> {
        instructions::operator::set_operator_handler(ctx, approved)
    }

    /// Change the vault-level operator (authority only)
    pub fn set_vault_operator(ctx: Context<SetVaultOperator>) -> Result<()> {
        instructions::operator::set_vault_operator_handler(ctx)
    }

    // ============================================================
    // Admin
    // ============================================================

    /// Pause all vault operations (emergency circuit breaker)
    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    /// Unpause vault operations
    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    /// Transfer vault authority to a new address
    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    // ============================================================
    // View Functions (ERC-7540 async-specific)
    // ============================================================

    /// Returns assets_locked if Pending deposit exists, else 0
    /// ERC-7540: pendingDepositRequest(controller)
    pub fn pending_deposit_request(ctx: Context<PendingDepositView>) -> Result<()> {
        instructions::view::pending_deposit_request(ctx)
    }

    /// Returns shares_claimable if Fulfilled deposit exists, else 0
    /// ERC-7540: claimableDepositRequest(controller)
    pub fn claimable_deposit_request(ctx: Context<ClaimableDepositView>) -> Result<()> {
        instructions::view::claimable_deposit_request(ctx)
    }

    /// Returns shares_locked if Pending redeem request exists, else 0
    /// ERC-7540: pendingRedeemRequest(controller)
    pub fn pending_redeem_request(ctx: Context<PendingRedeemView>) -> Result<()> {
        instructions::view::pending_redeem_request(ctx)
    }

    /// Returns amount from ClaimableEscrow if it exists, else 0
    /// ERC-7540: claimableRedeemRequest(controller)
    pub fn claimable_redeem_request(ctx: Context<ClaimableRedeemView>) -> Result<()> {
        instructions::view::claimable_redeem_request(ctx)
    }

    // ============================================================
    // View Functions (ERC-4626 standard, uses stored totals)
    // ============================================================

    /// Preview shares for deposit (floor rounding)
    pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_deposit(ctx, assets)
    }

    /// Preview assets required for mint (ceiling rounding)
    pub fn preview_mint(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_mint(ctx, shares)
    }

    /// Preview shares to burn for withdraw (ceiling rounding)
    pub fn preview_withdraw(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::preview_withdraw(ctx, assets)
    }

    /// Preview assets for redeem (floor rounding)
    pub fn preview_redeem(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::preview_redeem(ctx, shares)
    }

    /// Convert assets to shares (floor rounding)
    pub fn convert_to_shares(ctx: Context<VaultView>, assets: u64) -> Result<()> {
        instructions::view::convert_to_shares_view(ctx, assets)
    }

    /// Convert shares to assets (floor rounding)
    pub fn convert_to_assets(ctx: Context<VaultView>, shares: u64) -> Result<()> {
        instructions::view::convert_to_assets_view(ctx, shares)
    }

    /// Get total assets in vault (stored balance)
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Returns 0 — async vault does not support atomic deposits (use request_deposit)
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Returns 0 — async vault does not support atomic mints (use request_deposit)
    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Returns 0 — async vault does not support atomic withdrawals (use request_redeem)
    pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Returns 0 — async vault does not support atomic redeems (use request_redeem)
    pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }

    // ============================================================
    // Module Admin Instructions (requires "modules" feature)
    // ============================================================

    /// Initialize fee configuration for vault
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

    /// Update fee configuration
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

    /// Initialize cap configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_cap_config(
        ctx: Context<InitializeCapConfig>,
        global_cap: u64,
        per_user_cap: u64,
    ) -> Result<()> {
        instructions::module_admin::initialize_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Update cap configuration
    #[cfg(feature = "modules")]
    pub fn update_cap_config(
        ctx: Context<UpdateCapConfig>,
        global_cap: Option<u64>,
        per_user_cap: Option<u64>,
    ) -> Result<()> {
        instructions::module_admin::update_cap_config(ctx, global_cap, per_user_cap)
    }

    /// Initialize lock configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_lock_config(
        ctx: Context<InitializeLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::initialize_lock_config(ctx, lock_duration)
    }

    /// Update lock configuration
    #[cfg(feature = "modules")]
    pub fn update_lock_config(
        ctx: Context<UpdateLockConfig>,
        lock_duration: i64,
    ) -> Result<()> {
        instructions::module_admin::update_lock_config(ctx, lock_duration)
    }

    /// Initialize access configuration for vault
    #[cfg(feature = "modules")]
    pub fn initialize_access_config(
        ctx: Context<InitializeAccessConfig>,
        mode: state::AccessMode,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::module_admin::initialize_access_config(ctx, mode, merkle_root)
    }

    /// Update access configuration
    #[cfg(feature = "modules")]
    pub fn update_access_config(
        ctx: Context<UpdateAccessConfig>,
        mode: Option<state::AccessMode>,
        merkle_root: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::module_admin::update_access_config(ctx, mode, merkle_root)
    }
}
