//! Initialize: create SolVault PDA, shares mint, and wSOL vault account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::{
        spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
        Token2022,
    },
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::{SHARES_DECIMALS, SHARES_MINT_SEED, SOL_DECIMALS_OFFSET, SOL_VAULT_SEED},
    error::VaultError,
    events::VaultInitialized,
    state::{BalanceModel, SolVault},
};

// Native SOL mint address
pub const NATIVE_MINT: &str = "So11111111111111111111111111111111111111112";

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

    /// Native SOL mint (So111...)
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// wSOL token account owned by vault PDA (SPL Token program)
    #[account(
        init,
        payer = authority,
        associated_token::mint = native_mint,
        associated_token::authority = vault,
        associated_token::token_program = spl_token_program,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    pub spl_token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    use_stored_model: bool,
) -> Result<()> {
    // Validate native mint
    require!(
        ctx.accounts.native_mint.key().to_string() == NATIVE_MINT,
        VaultError::InvalidNativeMint
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    // Calculate space for Token-2022 mint (no extensions)
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;
    let lamports = ctx.accounts.rent.minimum_balance(mint_size);

    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &[shares_mint_bump],
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

    // Initialize Token-2022 shares mint (vault PDA = mint authority)
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

    // Initialize vault state
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.wsol_vault = ctx.accounts.wsol_vault.key();
    vault.total_assets = 0;
    vault.decimals_offset = SOL_DECIMALS_OFFSET;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.balance_model = if use_stored_model { BalanceModel::Stored } else { BalanceModel::Live };
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        wsol_vault: vault.wsol_vault,
        vault_id,
        is_stored_model: use_stored_model,
    });

    msg!("SVS-7 vault initialized: vault_id={} model={}", vault_id,
        if use_stored_model { "Stored" } else { "Live" });
    Ok(())
}
