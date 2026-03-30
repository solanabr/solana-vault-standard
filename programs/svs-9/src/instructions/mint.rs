//! Mint instruction: mint exact shares by depositing required assets.

use crate::constants::*;
use crate::error::*;
use crate::math::{convert_to_assets, Rounding};
use crate::state::*;
use crate::utils::compute_total_assets;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, MintTo, Token2022};
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The user who will receive the minted allocator shares
    pub owner: UncheckedAccount<'info>,

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
        constraint = caller_asset_account.mint == asset_mint.key(),
        constraint = caller_asset_account.owner == caller.key(),
    )]
    pub caller_asset_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_shares_account.mint == shares_mint.key(),
        constraint = owner_shares_account.owner == owner.key(),
    )]
    pub owner_shares_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token program for asset
    pub token_program: Interface<'info, TokenInterface>,

    /// Token-2022 program for shares
    pub token_2022_program: Program<'info, Token2022>,

    pub system_program: Program<'info, System>,
}

pub fn mint_handler(ctx: Context<MintShares>, shares: u64, max_assets_in: u64) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

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

    // Calculate required assets (ceiling rounding - user pays more)
    let assets = convert_to_assets(
        shares,
        total_assets,
        total_shares,
        ctx.accounts.allocator_vault.decimals_offset,
        Rounding::Ceiling,
    )?;

    // Slippage check
    require!(assets <= max_assets_in, VaultError::SlippageExceeded);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    #[cfg(feature = "modules")]
    let net_shares = {
        let (_, modules) = ctx.remaining_accounts.split_at(child_accounts_len);
        let vault_key = ctx.accounts.allocator_vault.key();
        let user_key = ctx.accounts.owner.key();

        module_hooks::check_deposit_access(modules, &crate::ID, &vault_key, &user_key, &[])?;
        module_hooks::check_deposit_caps(
            modules,
            &crate::ID,
            &vault_key,
            &user_key,
            total_assets,
            assets,
        )?;

        let result = module_hooks::apply_entry_fee(modules, &crate::ID, &vault_key, shares)?;
        result.net_shares
    };

    #[cfg(not(feature = "modules"))]
    let net_shares = shares;

    require!(net_shares > 0, VaultError::ZeroAmount);

    // 5. EXECUTE CPIs
    // 5.1 Transfer assets from caller to idle_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.caller_asset_account.to_account_info(),
                to: ctx.accounts.idle_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    // 5.2 Mint net shares to owner using stored bump
    let asset_mint_key = ctx.accounts.allocator_vault.asset_mint;
    let vault_id = ctx.accounts.allocator_vault.vault_id.to_le_bytes();
    let bump = ctx.accounts.allocator_vault.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        ALLOCATOR_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id,
        &[bump],
    ]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.owner_shares_account.to_account_info(),
                authority: ctx.accounts.allocator_vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_shares,
    )?;

    // 6. UPDATE STATE
    let vault = &mut ctx.accounts.allocator_vault;
    vault.total_shares = vault
        .total_shares
        .checked_add(net_shares)
        .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT
    emit!(crate::events::Deposit {
        vault: ctx.accounts.allocator_vault.key(),
        caller: ctx.accounts.caller.key(),
        owner: ctx.accounts.owner.key(),
        assets,
        shares: net_shares,
    });

    Ok(())
}
