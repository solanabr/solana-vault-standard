//! Initialize instruction — creates the async vault, shares mint, and share escrow.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        spl_token_2022::{
            extension::ExtensionType,
            instruction::{initialize_account3, initialize_mint2},
        },
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{
        DEFAULT_MAX_DEVIATION_BPS, MAX_DECIMALS, SHARES_DECIMALS, SHARES_MINT_SEED,
        SHARE_ESCROW_SEED, VAULT_SEED,
    },
    error::VaultError,
    events::VaultInitialized,
    state::AsyncVault,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub operator: SystemAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = AsyncVault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, AsyncVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint is initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Share escrow is initialized via CPI after shares mint creation
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub share_escrow: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    name: String,
    symbol: String,
    _uri: String,
) -> Result<()> {
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let share_escrow_bump = ctx.bumps.share_escrow;

    // --- 1. Create shares mint account ---
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let mint_lamports = rent.minimum_balance(mint_size);

    let shares_mint_bump_bytes = [shares_mint_bump];
    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &shares_mint_bump_bytes,
    ];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.shares_mint.key(),
            mint_lamports,
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

    // --- 2. Initialize shares mint ---
    let init_mint_ix = initialize_mint2(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.shares_mint.key(),
        &vault_key,
        None,
        SHARES_DECIMALS,
    )?;

    invoke_signed(
        &init_mint_ix,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[shares_mint_seeds],
    )?;

    // --- 3. Create share escrow token account ---
    let token_account_size =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
            .map_err(|_| VaultError::MathOverflow)?;

    let escrow_lamports = rent.minimum_balance(token_account_size);

    let share_escrow_bump_bytes = [share_escrow_bump];
    let share_escrow_seeds: &[&[u8]] = &[
        SHARE_ESCROW_SEED,
        vault_key.as_ref(),
        &share_escrow_bump_bytes,
    ];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.share_escrow.key(),
            escrow_lamports,
            token_account_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.share_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[share_escrow_seeds],
    )?;

    // --- 4. Initialize share escrow as Token-2022 token account ---
    let init_escrow_ix = initialize_account3(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.share_escrow.key(),
        &ctx.accounts.shares_mint.key(),
        &vault_key,
    )?;

    invoke_signed(
        &init_escrow_ix,
        &[
            ctx.accounts.share_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
        ],
        &[share_escrow_seeds],
    )?;

    // --- 5. Set vault state ---
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.operator = ctx.accounts.operator.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.asset_vault = ctx.accounts.asset_vault.key();
    vault.vault_id = vault_id;
    vault.total_assets = 0;
    vault.total_shares = 0;
    vault.total_pending_deposits = 0;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.paused = false;
    vault.max_staleness = 0;
    vault.max_deviation_bps = DEFAULT_MAX_DEVIATION_BPS;
    vault.bump = vault_bump;
    vault.share_escrow_bump = share_escrow_bump;
    vault._reserved = [0u8; 63];

    // --- 6. Emit event ---
    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        operator: vault.operator,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    msg!("Async vault initialized: {} for asset {}", name, symbol);
    Ok(())
}
