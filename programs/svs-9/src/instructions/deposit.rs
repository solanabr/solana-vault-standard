//! Deposit instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::ALLOCATOR_VAULT_SEED,
    error::VaultError,
    events::Deposit,
    math::{total_assets, convert_to_shares},
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        init_if_needed,
        payer = user,
        associated_token::mint = asset_mint,
        associated_token::authority = user,
    )]
    pub user_asset_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"idle_vault", allocator.key().as_ref()],
        bump,
        token::authority = allocator,
        token::mint = asset_mint,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = allocator.shares_mint,
        associated_token::authority = user,
    )]
    pub user_shares_account: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = ["metadata", allocator.shares_mint.key().as_ref(), "metadata"],
        constraint = shares_metadata.mint == allocator.shares_mint.key(),
    )]
    /// CHECK: Metadata account for shares mint
    pub shares_metadata: UncheckedAccount<'info>,

    #[account(address = "anchor::spl::associated_token::ID")]
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct DepositParams {
    pub vault_id: u64,
    pub assets: u64,
    pub min_shares_out: u64,
}

pub fn handler(ctx: Context<Deposit>, params: DepositParams) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;
    let clock = Clock::get()?;

    // Validate inputs
    require!(params.assets > 0, VaultError::ZeroAmount);
    require!(params.min_shares_out > 0, VaultError::ZeroAmount);

    // Transfer assets from user to idle vault
    let transfer_accounts = anchor_spl::token::Transfer {
        from: &ctx.accounts.user_asset_account,
        to: &ctx.accounts.idle_vault,
        authority: &ctx.accounts.user,
    };

    anchor_spl::token::transfer(
        CpiContext::new(
            &ctx.accounts.associated_token_program.to_account_info(),
            &transfer_accounts,
        ),
        params.assets,
    )?;

    // Calculate total assets (including all child positions)
    let total_assets = crate::math::total_assets(
        ctx.accounts.idle_vault.amount,
        &[],
        &[],
        &[],
        &[],
        allocator.decimals_offset,
    )?;

    // Calculate shares to mint
    let shares = crate::math::convert_to_shares(
        params.assets,
        allocator.total_shares,
        total_assets,
        allocator.decimals_offset,
    )?;

    require!(shares >= params.min_shares_out, VaultError::SlippageExceeded);

    // Mint shares to user
    let mint_accounts = anchor_spl::token::MintTo {
        mint: &ctx.accounts.allocator.shares_mint,
        to: &ctx.accounts.user_shares_account,
        authority: allocator,
    };

    anchor_spl::token::mint_to(
        CpiContext::new(
            &ctx.accounts.associated_token_program.to_account_info(),
            &mint_accounts,
        ),
        shares,
    )?;

    // Update allocator state
    allocator.total_shares = allocator.total_shares.checked_add(shares)
        .ok_or(error!(VaultError::MathOverflow))?;
    
    // Update cache
    allocator.cached_total_assets = total_assets.checked_add(params.assets)
        .ok_or(error!(VaultError::MathOverflow))?;
    allocator.cache_timestamp = clock.unix_timestamp;

    emit_cpi!(Deposit {
        vault: allocator.key(),
        depositor: ctx.accounts.user.key(),
        assets: params.assets,
        shares,
        total_assets_after: allocator.cached_total_assets,
    });

    Ok(())
}
