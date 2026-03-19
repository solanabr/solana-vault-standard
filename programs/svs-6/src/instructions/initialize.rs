//! Initialize instruction: create vault PDA and shares mint.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::{
    spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
    Token2022,
};

use crate::{
    constants::{MAX_DECIMALS, SHARES_DECIMALS, SHARES_MINT_SEED, VAULT_SEED},
    events::VaultInitialized,
    state::NativeSolStreamVault,
};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = NativeSolStreamVault::LEN,
        seeds = [VAULT_SEED, &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, NativeSolStreamVault>,

    /// CHECK: Shares mint is initialized via CPI in handler.
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
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
    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;

    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| error!(crate::error::VaultError::MathOverflow))?;
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

    let now = Clock::get()?.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.decimals_offset = MAX_DECIMALS - SHARES_DECIMALS;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.base_assets = 0;
    vault.total_shares = 0;
    vault.stream_amount = 0;
    vault.stream_start = now;
    vault.stream_end = now;
    vault.last_checkpoint = now;
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    msg!("Native SOL streaming vault initialized: {} ({})", name, symbol);
    Ok(())
}
