use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{self, MintTo, Token2022},
    token_interface::{transfer_checked, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::{VAULT_SEED, WEIGHT_DENOMINATOR},
    error::VaultError,
    events::ProportionalDeposit,
    math::{
        asset_value_in_base, mul_div, portfolio_convert_to_shares, total_portfolio_value, Rounding,
    },
    remaining::{read_token_balance, ParsedAssetEntry},
    state::MultiAssetVault,
};

#[derive(Accounts)]
pub struct DepositProportional<'info> {
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
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [AssetEntry, asset_vault, oracle, asset_mint, user_ata, token_program] × num_assets
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, DepositProportional<'info>>,
    base_amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    require!(base_amount > 0, VaultError::ZeroAmount);

    let vault = &ctx.accounts.vault;
    let num_assets = vault.num_assets as usize;

    require!(
        ctx.remaining_accounts.len() == num_assets * 6,
        VaultError::InvalidRemainingAccounts
    );

    let vault_key = vault.key();
    let clock = Clock::get()?;

    let mut weight_sum: u16 = 0;
    let mut balances = Vec::with_capacity(num_assets);
    let mut prices = Vec::with_capacity(num_assets);
    let mut asset_decimals_vec = Vec::with_capacity(num_assets);
    let mut transfer_amounts = Vec::with_capacity(num_assets);

    // First pass: read all data and compute transfer amounts
    for i in 0..num_assets {
        let base = i * 6;
        let entry_info = &ctx.remaining_accounts[base];
        let vault_info = &ctx.remaining_accounts[base + 1];
        let oracle_info = &ctx.remaining_accounts[base + 2];

        let entry_data = entry_info.try_borrow_data()?;
        let entry = ParsedAssetEntry::from_account_data(&entry_data)?;
        entry.validate_pda(entry_info.key, &vault_key, &crate::ID)?;

        require!(
            *vault_info.key == entry.asset_vault,
            VaultError::InvalidAssetVault
        );
        require!(*oracle_info.key == entry.oracle, VaultError::OracleInvalid);

        weight_sum = weight_sum
            .checked_add(entry.target_weight_bps)
            .ok_or(error!(VaultError::MathOverflow))?;

        let vault_data = vault_info.try_borrow_data()?;
        balances.push(read_token_balance(&vault_data)?);

        let oracle_data = oracle_info.try_borrow_data()?;
        let price = crate::instructions::deposit_single::read_mock_oracle_price(
            &oracle_data,
            clock.unix_timestamp,
        )?;
        prices.push(price);
        asset_decimals_vec.push(entry.asset_decimals);

        let transfer_amount = mul_div(
            base_amount,
            entry.target_weight_bps as u64,
            WEIGHT_DENOMINATOR as u64,
            Rounding::Floor,
        )?;
        transfer_amounts.push(transfer_amount);
    }

    require!(
        weight_sum == WEIGHT_DENOMINATOR,
        VaultError::WeightsNotFullyAllocated
    );

    let total_value = total_portfolio_value(&balances, &prices, &asset_decimals_vec)?;

    let mut total_deposit_value: u64 = 0;
    for i in 0..num_assets {
        let val = asset_value_in_base(transfer_amounts[i], prices[i], asset_decimals_vec[i])?;
        total_deposit_value = total_deposit_value
            .checked_add(val)
            .ok_or(error!(VaultError::MathOverflow))?;
    }

    let total_shares = ctx.accounts.shares_mint.supply;
    let shares = portfolio_convert_to_shares(
        total_deposit_value,
        total_shares,
        total_value,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    // Execute transfers (need to re-read entry data for decimals)
    for i in 0..num_assets {
        if transfer_amounts[i] == 0 {
            continue;
        }
        let base = i * 6;
        let vault_info = &ctx.remaining_accounts[base + 1];
        let mint_info = &ctx.remaining_accounts[base + 3];
        let user_ata_info = &ctx.remaining_accounts[base + 4];
        let token_program_info = &ctx.remaining_accounts[base + 5];

        transfer_checked(
            CpiContext::new(
                token_program_info.to_account_info(),
                TransferChecked {
                    from: user_ata_info.to_account_info(),
                    to: vault_info.to_account_info(),
                    mint: mint_info.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            transfer_amounts[i],
            asset_decimals_vec[i],
        )?;
    }

    // Mint shares
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, vault_id_bytes.as_ref(), &[bump]]];

    token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    emit!(ProportionalDeposit {
        vault: vault.key(),
        caller: ctx.accounts.user.key(),
        amounts: transfer_amounts,
        shares,
        total_deposit_value,
    });

    Ok(())
}
