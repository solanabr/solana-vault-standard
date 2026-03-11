//! Initialize instruction: create SolVault PDA, shares mint (Token-2022), and wSOL vault account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    token_2022::{
        spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{SHARES_DECIMALS, SHARES_MINT_SEED, SOL_DECIMALS_OFFSET, SOL_VAULT_SEED},
    error::SolVaultError,
    events::SolVaultInitialized,
    state::{BalanceModel, SolVault},
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = SolVault::LEN,
        seeds = [SOL_VAULT_SEED, &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, SolVault>,

    /// Native SOL mint (So11111111111111111111111111111111)
    #[account(
        constraint = asset_mint.key() == anchor_spl::token::spl_token::native_mint::id() @ SolVaultError::InvalidAssetMint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint is initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// wSOL token account owned by the vault PDA
    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    name: String,
    symbol: String,
    _uri: String,
    balance_model: BalanceModel,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    // Calculate space for a basic Token-2022 mint (no extensions)
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| SolVaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(mint_size);

    // Signer seeds for shares mint PDA
    let shares_mint_bump_bytes = [shares_mint_bump];
    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &shares_mint_bump_bytes,
    ];

    // Create shares mint account
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

    // Initialize mint (vault PDA is mint authority, no freeze authority)
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

    // Set vault state
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.wsol_vault = ctx.accounts.wsol_vault.key();
    vault.total_assets = 0;
    vault.decimals_offset = SOL_DECIMALS_OFFSET;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.balance_model = balance_model;
    vault._reserved = [0u8; 64];

    emit!(SolVaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        wsol_vault: vault.wsol_vault,
        vault_id,
        balance_model: balance_model as u8,
    });

    msg!("SOL Vault initialized: {} ({})", name, symbol);

    Ok(())
}
