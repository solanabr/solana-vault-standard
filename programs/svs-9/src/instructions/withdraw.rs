//! Withdraw instruction: withdraw exact assets by burning required shares.

use crate::constants::*;
use crate::error::*;
use crate::math::{convert_to_shares, Rounding};
use crate::state::*;
use crate::utils::compute_total_assets;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Burn, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct WithdrawAssets<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The user who currently owns the shares being burned
    pub owner: UncheckedAccount<'info>,

    /// CHECK: The user who will receive the assets
    pub receiver: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = !allocator_vault.paused @ VaultError::VaultPaused,
    )]
    pub allocator_vault: Box<Account<'info, AllocatorVault>>,

    #[account(
        mut,
        constraint = idle_vault.key() == allocator_vault.idle_vault @ VaultError::InvalidChildVault,
    )]
    pub idle_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = shares_mint.key() == allocator_vault.shares_mint @ VaultError::InvalidChildVault,
    )]
    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = caller_shares_account.mint == shares_mint.key(),
        constraint = caller_shares_account.owner == caller.key(),
    )]
    pub caller_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = receiver_asset_account.mint == asset_mint.key(),
        constraint = receiver_asset_account.owner == receiver.key(),
    )]
    pub receiver_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn withdraw_handler(
    ctx: Context<WithdrawAssets>,
    assets: u64,
    max_shares_in: u64,
) -> Result<()> {
    require!(assets > 0, VaultError::ZeroAmount);

    let total_shares = ctx.accounts.shares_mint.supply;
    let num_children = ctx.accounts.allocator_vault.num_children as usize;
    let child_accounts_len = num_children * 5;
    require!(
        ctx.remaining_accounts.len() >= child_accounts_len,
        VaultError::InvalidRemainingAccounts
    );
    let (child_accounts, _) = ctx.remaining_accounts.split_at(child_accounts_len);
    let total_assets = compute_total_assets(
        ctx.accounts.idle_vault.amount,
        ctx.accounts.allocator_vault.num_children,
        child_accounts,
        ctx.accounts.allocator_vault.key(),
    )?;

    #[cfg(feature = "modules")]
    let net_assets = {
        let (_, modules) = ctx.remaining_accounts.split_at(child_accounts_len);
        let clock = Clock::get()?;
        let vault_key = ctx.accounts.allocator_vault.key();
        let user_key = ctx.accounts.caller.key();

        module_hooks::check_share_lock(
            modules,
            &crate::ID,
            &vault_key,
            &user_key,
            clock.unix_timestamp,
        )?;

        let result = module_hooks::apply_exit_fee(modules, &crate::ID, &vault_key, assets)?;
        require!(result.net_assets > 0, VaultError::ZeroAmount);
        result.net_assets
    };

    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    // Calculate required shares to get `assets` (ceiling rounding - burn more to protect vault)
    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        ctx.accounts.allocator_vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // Slippage check
    require!(shares <= max_shares_in, VaultError::SlippageExceeded);

    // Liquidity check (SVS-9 only pays out from idle vault)
    require!(
        ctx.accounts.idle_vault.amount >= net_assets,
        VaultError::InsufficientAssets
    );

    // 5. EXECUTE CPIs
    // 5.1 Burn allocator shares from owner
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.caller_shares_account.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        shares,
    )?;

    // 5.2 Transfer net assets from idle_vault to receiver using stored bump
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id,
        &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.idle_vault.to_account_info(),
                to: ctx.accounts.receiver_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.allocator_vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 6. UPDATE STATE
    let vault = &mut ctx.accounts.allocator_vault;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(crate::events::Withdraw {
        vault: ctx.accounts.allocator_vault.key(),
        caller: ctx.accounts.caller.key(),
        owner: ctx.accounts.owner.key(),
        assets: net_assets,
        shares,
    });

    Ok(())
}
