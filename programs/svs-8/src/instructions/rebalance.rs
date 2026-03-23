use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::{ASSET_ENTRY_SEED, VAULT_SEED},
    error::VaultError,
    events::Rebalance as RebalanceEvent,
    state::{AssetEntry, MultiAssetVault},
};

#[derive(Accounts)]
pub struct Rebalance<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.authority == authority.key() @ VaultError::Unauthorized,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), from_asset_entry.asset_mint.as_ref()],
        bump = from_asset_entry.bump,
        constraint = from_asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub from_asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = from_asset_vault.key() == from_asset_entry.asset_vault @ VaultError::InvalidAssetVault,
    )]
    pub from_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [ASSET_ENTRY_SEED, vault.key().as_ref(), to_asset_entry.asset_mint.as_ref()],
        bump = to_asset_entry.bump,
        constraint = to_asset_entry.vault == vault.key() @ VaultError::AssetNotFound,
    )]
    pub to_asset_entry: Account<'info, AssetEntry>,

    #[account(
        mut,
        constraint = to_asset_vault.key() == to_asset_entry.asset_vault @ VaultError::InvalidAssetVault,
    )]
    pub to_asset_vault: InterfaceAccount<'info, TokenAccount>,
    // remaining_accounts: [swap_program, ...swap_route_accounts]
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, Rebalance<'info>>,
    swap_data: Vec<u8>,
    minimum_out: u64,
) -> Result<()> {
    require!(
        !ctx.remaining_accounts.is_empty(),
        VaultError::InvalidRemainingAccounts
    );

    let from_before = ctx.accounts.from_asset_vault.amount;
    let to_before = ctx.accounts.to_asset_vault.amount;

    // Build CPI to swap program (first remaining account)
    let swap_program = &ctx.remaining_accounts[0];
    let swap_accounts = &ctx.remaining_accounts[1..];

    let vault = &ctx.accounts.vault;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    // Build instruction from swap_data
    let mut account_metas = Vec::with_capacity(swap_accounts.len());
    for account in swap_accounts {
        account_metas.push(if account.is_writable {
            if account.is_signer {
                AccountMeta::new(*account.key, true)
            } else {
                AccountMeta::new(*account.key, false)
            }
        } else if account.is_signer {
            AccountMeta::new_readonly(*account.key, true)
        } else {
            AccountMeta::new_readonly(*account.key, false)
        });
    }

    let swap_ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: *swap_program.key,
        accounts: account_metas,
        data: swap_data,
    };

    let mut account_infos: Vec<AccountInfo<'info>> = swap_accounts.to_vec();
    account_infos.push(ctx.accounts.vault.to_account_info());

    invoke_signed(&swap_ix, &account_infos, signer_seeds)?;

    // Reload and verify
    ctx.accounts.from_asset_vault.reload()?;
    ctx.accounts.to_asset_vault.reload()?;

    let from_after = ctx.accounts.from_asset_vault.amount;
    let to_after = ctx.accounts.to_asset_vault.amount;

    let amount_in = from_before
        .checked_sub(from_after)
        .ok_or(error!(VaultError::MathOverflow))?;
    let amount_out = to_after
        .checked_sub(to_before)
        .ok_or(error!(VaultError::MathOverflow))?;

    require!(
        amount_out >= minimum_out,
        VaultError::RebalanceSlippageExceeded
    );

    emit!(RebalanceEvent {
        vault: vault.key(),
        from_asset: ctx.accounts.from_asset_entry.asset_mint,
        to_asset: ctx.accounts.to_asset_entry.asset_mint,
        amount_in,
        amount_out,
    });

    Ok(())
}
