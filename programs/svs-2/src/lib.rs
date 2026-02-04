use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD");

#[program]
pub mod svs_2 {
    use super::*;

    /// Initialize a new confidential vault for the given asset
    /// Creates shares mint with ConfidentialTransferMint extension
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
        auditor_elgamal_pubkey: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri, auditor_elgamal_pubkey)
    }

    /// Configure user's shares account for confidential transfers
    /// Must be called before first deposit
    /// Requires PubkeyValidityProof to be submitted in same transaction (or pre-verified context)
    ///
    /// # Arguments
    /// * `decryptable_zero_balance` - AE ciphertext of zero, encrypted with user's AES key
    /// * `proof_instruction_offset` - Offset to VerifyPubkeyValidity instruction (-1 if preceding)
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
    /// Shares go to pending balance (must call apply_pending to use)
    pub fn deposit(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit::handler(ctx, assets, min_shares_out)
    }

    /// Mint exact confidential shares by depositing required assets
    pub fn mint(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
        instructions::mint::handler(ctx, shares, max_assets_in)
    }

    /// Apply pending balance to available balance
    /// Must be called after deposit/mint before shares can be used
    ///
    /// # Arguments
    /// * `new_decryptable_available_balance` - AE ciphertext of new available balance
    /// * `expected_pending_balance_credit_counter` - Expected pending credits to apply
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

    /// Withdraw exact assets by burning confidential shares
    /// Requires pre-verified range proof and ciphertext equality proof context accounts
    ///
    /// # Arguments
    /// * `assets` - Exact amount of assets to withdraw
    /// * `max_shares_in` - Maximum shares willing to burn (slippage protection)
    /// * `new_decryptable_available_balance` - AE ciphertext of balance after withdrawal
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

    /// Redeem confidential shares for assets
    /// Requires pre-verified range proof and ciphertext equality proof context accounts
    ///
    /// # Arguments
    /// * `shares` - Number of confidential shares to redeem
    /// * `min_assets_out` - Minimum assets to receive (slippage protection)
    /// * `new_decryptable_available_balance` - AE ciphertext of balance after withdrawal
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

    /// Sync total_assets with actual vault balance
    pub fn sync(ctx: Context<Sync>) -> Result<()> {
        instructions::admin::sync(ctx)
    }

    // ============ View Functions (CPI composable) ============

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

    /// Get total assets in vault
    pub fn total_assets(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::get_total_assets(ctx)
    }

    /// Max assets depositable (u64::MAX or 0 if paused)
    pub fn max_deposit(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_deposit(ctx)
    }

    /// Max shares mintable (u64::MAX or 0 if paused)
    pub fn max_mint(ctx: Context<VaultView>) -> Result<()> {
        instructions::view::max_mint(ctx)
    }

    /// Max assets owner can withdraw
    pub fn max_withdraw(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_withdraw(ctx)
    }

    /// Max shares owner can redeem
    pub fn max_redeem(ctx: Context<VaultViewWithOwner>) -> Result<()> {
        instructions::view::max_redeem(ctx)
    }
}
