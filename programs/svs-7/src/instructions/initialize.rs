//! Initialize instruction: create SolVault PDA, shares mint, and wSOL vault.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{MAX_DECIMALS, SHARES_DECIMALS, SHARES_MINT_SEED, SOL_VAULT_SEED},
    error::VaultError,
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

    /// Native mint (wSOL): So11111111111111111111111111111111
    #[account(
        constraint = native_mint.key() == anchor_spl::token::spl_token::native_mint::id()
            @ VaultError::InvalidNativeMint,
    )]
    pub native_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint is initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// wSOL vault — ATA owned by vault PDA (deterministic address = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true))
    #[account(
        init,
        payer = authority,
        associated_token::mint = native_mint,
        associated_token::authority = vault,
        associated_token::token_program = wsol_token_program,
    )]
    pub wsol_vault: InterfaceAccount<'info, TokenAccount>,

    /// Token program for wSOL (SPL Token)
    pub wsol_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    balance_model: u8,
    name: String,
    symbol: String,
    _uri: String,
) -> Result<()> {
    // SOL always has 9 decimals
    let asset_decimals: u8 = 9;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );

    // Validate balance model
    let model = match balance_model {
        0 => BalanceModel::Live,
        1 => BalanceModel::Stored,
        _ => return Err(VaultError::InvalidBalanceModel.into()),
    };

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    // Calculate space for a basic Token-2022 mint (no extensions)
    let mint_size = anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::try_calculate_account_len::<anchor_spl::token_2022::spl_token_2022::state::Mint>(&[])
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
    let init_mint_ix = anchor_spl::token_2022::spl_token_2022::instruction::initialize_mint2(
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
    vault.decimals_offset = MAX_DECIMALS - asset_decimals; // 9 - 9 = 0
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.balance_model = model;
    vault._reserved = [0u8; 64];

    emit!(SolVaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        wsol_vault: vault.wsol_vault,
        vault_id,
        balance_model: balance_model,
    });

    msg!("SOL Vault initialized: {} ({})", name, symbol);

    Ok(())
}
