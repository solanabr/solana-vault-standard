//! Initialize instruction: create vault PDA, shares mint, and wSOL vault account.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint as SplMint, Token, TokenAccount},
    token_2022::{
        spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
        Token2022,
    },
};

use crate::{
    constants::{MAX_DECIMALS, SHARES_DECIMALS, SHARES_MINT_SEED, VAULT_SEED, WSOL_DECIMALS},
    error::VaultError,
    events::VaultInitialized,
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
        seeds = [VAULT_SEED, &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, SolVault>,

    #[account(
        constraint = wsol_mint.key() == token::spl_token::native_mint::ID @ VaultError::InvalidWsolMint,
        constraint = wsol_mint.decimals == WSOL_DECIMALS @ VaultError::InvalidAssetDecimals,
    )]
    pub wsol_mint: Account<'info, SplMint>,

    /// CHECK: Shares mint is initialized via CPI in handler.
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = wsol_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub wsol_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
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
    balance_model: BalanceModel,
) -> Result<()> {
    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let lamports = ctx.accounts.rent.minimum_balance(mint_size);

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

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.wsol_vault = ctx.accounts.wsol_vault.key();
    vault.total_assets = 0;
    vault.decimals_offset = MAX_DECIMALS - SHARES_DECIMALS;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.balance_model = balance_model;
    vault._reserved = [0u8; 64];

    let model_code = match balance_model {
        BalanceModel::Live => 0,
        BalanceModel::Stored => 1,
    };

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        wsol_vault: vault.wsol_vault,
        vault_id,
        balance_model: model_code,
    });

    msg!("SVS-7 vault initialized: {} ({})", name, symbol);

    Ok(())
}
