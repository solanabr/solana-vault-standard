use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    token_2022::{
        spl_token_2022::{
            extension::ExtensionType, instruction::initialize_mint2,
            solana_program::program_pack::Pack,
        },
        Token2022,
    },
    token_interface::{Mint, TokenInterface},
};

use crate::{constants::*, error::VaultError, events::AsyncVaultInitialized, state::AsyncVault};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = AsyncVault::LEN,
        seeds = [ASYNC_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, AsyncVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint initialized via CPI
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// CHECK: Asset vault token account initialized via CPI
    #[account(
        mut,
        seeds = [ASSET_VAULT_SEED, vault.key().as_ref()],
        bump
    )]
    pub asset_vault: UncheckedAccount<'info>,

    /// CHECK: Share escrow token account initialized via CPI
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub share_escrow: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    cancel_delay: i64,
    max_staleness: i64,
) -> Result<()> {
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );
    require!(cancel_delay >= 0, VaultError::InvalidCancelDelay);
    require!(
        cancel_delay <= MAX_CANCEL_DELAY,
        VaultError::CancelDelayExceedsMax
    );
    require!(max_staleness >= 0, VaultError::InvalidMaxStaleness);

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let asset_vault_bump = ctx.bumps.asset_vault;
    let share_escrow_bump = ctx.bumps.share_escrow;

    // === Create shares mint (Token-2022) ===
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(mint_size);

    let shares_mint_seeds: &[&[u8]] = &[SHARES_MINT_SEED, vault_key.as_ref(), &[shares_mint_bump]];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.shares_mint.key(),
            lamports,
            mint_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[shares_mint_seeds],
    )?;

    invoke_signed(
        &initialize_mint2(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
            None,
            SHARES_DECIMALS,
        )?,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[shares_mint_seeds],
    )?;

    // === Create asset vault (PDA-owned token account) ===
    let asset_mint_key = ctx.accounts.asset_mint.key();
    let token_account_size = spl_token_2022::state::Account::LEN;
    let asset_vault_lamports = rent.minimum_balance(token_account_size);

    let asset_vault_seeds: &[&[u8]] = &[ASSET_VAULT_SEED, vault_key.as_ref(), &[asset_vault_bump]];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.asset_vault.key(),
            asset_vault_lamports,
            token_account_size as u64,
            &ctx.accounts.asset_token_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.asset_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[asset_vault_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.asset_token_program.key(),
            &ctx.accounts.asset_vault.key(),
            &asset_mint_key,
            &vault_key,
        )?,
        &[
            ctx.accounts.asset_vault.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
        ],
        &[asset_vault_seeds],
    )?;

    // === Create share escrow (PDA-owned token account for locked shares) ===
    let shares_mint_key = ctx.accounts.shares_mint.key();
    let share_escrow_lamports = rent.minimum_balance(
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
            .map_err(|_| VaultError::MathOverflow)?,
    );
    let share_escrow_size =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
            .map_err(|_| VaultError::MathOverflow)?;

    let share_escrow_seeds: &[&[u8]] =
        &[SHARE_ESCROW_SEED, vault_key.as_ref(), &[share_escrow_bump]];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.share_escrow.key(),
            share_escrow_lamports,
            share_escrow_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.share_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[share_escrow_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.share_escrow.key(),
            &shares_mint_key,
            &vault_key,
        )?,
        &[
            ctx.accounts.share_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
        ],
        &[share_escrow_seeds],
    )?;

    // === Set vault state ===
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.operator = Pubkey::default();
    vault.asset_mint = asset_mint_key;
    vault.shares_mint = shares_mint_key;
    vault.asset_vault = ctx.accounts.asset_vault.key();
    vault.share_escrow = ctx.accounts.share_escrow.key();
    vault.total_shares = 0;
    vault.total_assets = 0;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.cancel_delay = if cancel_delay > 0 {
        cancel_delay
    } else {
        DEFAULT_CANCEL_DELAY
    };
    vault.max_staleness = max_staleness;
    vault._reserved = [0u8; 64];

    emit!(AsyncVaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    Ok(())
}
