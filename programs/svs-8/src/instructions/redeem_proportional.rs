use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, Burn, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::VAULT_SEED,
    error::VaultError,
    events::ProportionalRedeem,
    math::{mul_div, Rounding},
    remaining::{read_token_balance, validate_token_program, ParsedAssetEntry},
    state::MultiAssetVault,
};

#[derive(Accounts)]
pub struct RedeemProportional<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, MultiAssetVault>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    // remaining_accounts: [AssetEntry, asset_vault, asset_mint, user_ata, token_program] × num_assets
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemProportional<'info>>,
    shares: u64,
    min_amounts_out: Vec<u64>,
) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.user_shares_account.amount >= shares,
        VaultError::InsufficientShares
    );

    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;

    require!(
        min_amounts_out.len() == num_assets,
        VaultError::MinAmountsLengthMismatch
    );

    require!(
        ctx.remaining_accounts.len() == num_assets * 5,
        VaultError::InvalidRemainingAccounts
    );

    let total_shares = ctx.accounts.shares_mint.supply;
    let vault_key = vault.key();

    // Pre-compute amounts and validate entries before burning
    let mut amounts_out = Vec::with_capacity(num_assets);
    let mut asset_decimals_vec = Vec::with_capacity(num_assets);

    for (i, &min_out) in min_amounts_out.iter().enumerate() {
        let base = i * 5;
        let entry_info = &ctx.remaining_accounts[base];
        let vault_info = &ctx.remaining_accounts[base + 1];

        let entry_data = entry_info.try_borrow_data()?;
        let entry = ParsedAssetEntry::from_account_data(&entry_data)?;
        entry.validate_pda(entry_info.key, &vault_key, &crate::ID)?;

        require!(
            *vault_info.key == entry.asset_vault,
            VaultError::InvalidAssetVault
        );

        let vault_data = vault_info.try_borrow_data()?;
        let balance = read_token_balance(&vault_data)?;

        let amount_out = mul_div(shares, balance, total_shares, Rounding::Floor)?;

        require!(amount_out >= min_out, VaultError::SlippageExceeded);

        amounts_out.push(amount_out);
        asset_decimals_vec.push(entry.asset_decimals);
    }

    // Burn shares
    token_2022::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    // Transfer assets
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    for i in 0..num_assets {
        if amounts_out[i] == 0 {
            continue;
        }
        let base = i * 5;
        let vault_info = &ctx.remaining_accounts[base + 1];
        let mint_info = &ctx.remaining_accounts[base + 2];
        let user_ata_info = &ctx.remaining_accounts[base + 3];
        let token_program_info = &ctx.remaining_accounts[base + 4];

        validate_token_program(token_program_info.key)?;

        transfer_checked(
            CpiContext::new_with_signer(
                token_program_info.to_account_info(),
                TransferChecked {
                    from: vault_info.to_account_info(),
                    to: user_ata_info.to_account_info(),
                    mint: mint_info.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amounts_out[i],
            asset_decimals_vec[i],
        )?;
    }

    emit!(ProportionalRedeem {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        shares,
        amounts: amounts_out,
    });

    Ok(())
}
