//! Initialize instruction: create SolVault PDA, shares mint, and wSOL vault account.
//!
//! The vault PDA uses seeds ["sol_vault", vault_id.to_le_bytes()].
//! No asset_mint is stored — the asset is always the native SOL mint.
//! The wSOL vault is the vault PDA's associated token account for the native mint.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{SHARES_DECIMALS, SHARES_MINT_SEED, SOL_VAULT_SEED},
    error::VaultError,
    events::VaultInitialized,
    state::SolVault,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// SolVault state PDA. Seeds: ["sol_vault", vault_id.to_le_bytes()]
    #[account(
        init,
        payer = authority,
        space = SolVault::LEN,
        seeds = [SOL_VAULT_SEED, &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, SolVault>,

    /// Native SOL mint (So11111111111111111111111111111111).
    /// Passed so Anchor can derive the wSOL ATA for the vault PDA.
    #[account(address = crate::constants::NATIVE_MINT @ VaultError::Unauthorized)]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint is initialized via CPI in handler.
    /// Seeds: ["shares", vault_key]
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// wSOL token account owned by the vault PDA (ATA for native mint).
    /// Initialized here so the vault holds wSOL rather than raw lamports.
    #[account(
        init,
        payer = authority,
        associated_token::mint = native_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token program (wSOL uses the original SPL Token program)
    #[account(address = anchor_spl::token::ID @ VaultError::Unauthorized)]
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 program (used for shares mint)
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
) -> Result<()> {
    // SOL always has 9 decimals; decimals_offset = 9 - 9 = 0
    let decimals_offset: u8 = 0;

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    // Calculate space for a basic Token-2022 mint (no extensions)
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(mint_size);

    // Signer seeds for shares mint PDA
    let shares_mint_bump_bytes = [shares_mint_bump];
    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &shares_mint_bump_bytes,
    ];

    // Create shares mint account via system program
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

    // Initialize shares mint — vault PDA is mint authority, no freeze authority
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
    vault.decimals_offset = decimals_offset;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    Ok(())
}
