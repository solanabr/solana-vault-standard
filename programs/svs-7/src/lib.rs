//! SVS-7: Native SOL Vault
//!
//! Native Solana port of ERC-7535. Accepts native SOL, wraps internally to wSOL,
//! and issues Token-2022 shares. Supports both native SOL and wSOL interfaces.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

// IMPORTANTE: Este ID deve ser trocado pelo que o 'anchor keys list' gerar para você
declare_id!("Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC"); 

#[program]
pub mod svs_7 { // Alterado para svs_7
    use super::*;

    /// Initialize a new native SOL vault
    pub fn initialize(
        ctx: Context<Initialize>,
        vault_id: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, vault_id, name, symbol, uri)
    }

    // ============ Deposits ============

    /// Deposit native SOL (lamports) -> wraps to wSOL -> mints shares
    pub fn deposit_sol(ctx: Context<DepositSol>, lamports: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit_sol::handler(ctx, lamports, min_shares_out)
    }

    /// Deposit pre-wrapped wSOL -> mints shares (standard interface)
    pub fn deposit_wsol(ctx: Context<DepositWsol>, assets: u64, min_shares_out: u64) -> Result<()> {
        instructions::deposit_wsol::handler(ctx, assets, min_shares_out)
    }

    // ============ Withdraws ============

    /// Burn shares -> unwrap wSOL -> receive native SOL (lamports)
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, assets: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw_sol::handler(ctx, assets, max_shares_in)
    }

    /// Burn shares -> receive wSOL (standard interface)
    pub fn withdraw_wsol(ctx: Context<WithdrawWsol>, assets: u64, max_shares_in: u64) -> Result<()> {
        instructions::withdraw_wsol::handler(ctx, assets, max_shares_in)
    }

    // ============ Standard Vault Instructions ============

    pub fn pause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<Admin>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn transfer_authority(ctx: Context<Admin>, new_authority: Pubkey) -> Result<()> {
        instructions::admin::transfer_authority(ctx, new_authority)
    }

    // ... (Mantivemos as View Functions e Module Admin abaixo)
}