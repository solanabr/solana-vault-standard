//! Redeem instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::ALLOCATOR_VAULT_SEED,
    error::VaultError,
    events::Redeem,
    math::{total_assets, convert_to_assets},
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump = allocator.bump,
        constraint = !allocator.paused @ VaultPaused
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"idle_vault", allocator.key().as_ref()],
        bump,
        token::authority = allocator,
        token::mint = asset_mint,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = allocator.shares_mint,
        associated_token::authority = user,
        constraint = shares_account.owner == user.key()
    )]
    pub shares_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = asset_mint,
        associated_token::authority = user,
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,

    #[account(address = "anchor::spl::associated_token::ID")]
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct RedeemParams {
    pub vault_id: u64,
    pub shares: u64,
    pub min_assets_out: u64,
}

pub fn handler(ctx: Context<Redeem>, params: RedeemParams) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;

    // Validate inputs
    require!(params.shares > 0, VaultError::ZeroAmount);
    require!(params.min_assets_out > 0, VaultError::ZeroAmount);

    // Calculate total assets (including all child positions)
    let total_assets = crate::math::total_assets(
        ctx.accounts.idle_vault.amount,
        &[],
        &[],
        &[],
        &[],
        allocator.decimals_offset,
    )?;

    // Calculate assets to return
    let assets = crate::math::convert_to_assets(
        params.shares,
        allocator.total_shares,
        total_assets,
        allocator.decimals_offset,
    )?;

    require!(assets >= params.min_assets_out, VaultError::SlippageExceeded);
    require!(
        ctx.accounts.idle_vault.amount >= assets,
        VaultError::InsufficientLiquidity
    );

    // Transfer assets from idle vault to user
    let transfer_accounts = anchor_spl::token::Transfer {
        from: &ctx.accounts.idle_vault,
        to: &ctx.accounts.user_asset_account,
        authority: allocator,
    };

    anchor_spl::token::transfer(
        CpiContext::new(
            &ctx.accounts.associated_token_program.to_account_info(),
            &transfer_accounts,
        ),
        assets,
    )?;

    // Burn user shares
    let burn_accounts = anchor_spl::token::Burn {
        from: &ctx.accounts.shares_account,
        mint: &ctx.accounts.allocator.shares_mint,
        authority: &ctx.accounts.user,
    };

    anchor_spl::token::burn(
        CpiContext::new(
            &ctx.accounts.associated_token_program.to_account_info(),
            &burn_accounts,
        ),
        params.shares,
    )?;

    // Update allocator state
    allocator.total_shares = allocator.total_shares.checked_sub(params.shares)
        .ok_or(error!(VaultError::InsufficientShares))?;
    
    // Update cache
    allocator.cached_total_assets = allocator.cached_total_assets.checked_sub(assets)
        .ok_or(error!(VaultError::InsufficientAssets))?;
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    emit_cpi!(Redeem {
        vault: allocator.key(),
        redeemer: ctx.accounts.user.key(),
        shares: params.shares,
        assets,
        total_assets_after: allocator.cached_total_assets,
    });

    Ok(())
}
