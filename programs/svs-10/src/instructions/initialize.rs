//! Initialize instruction: create AsyncVault PDA, shares mint, asset vault, share escrow.

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
// SPL Token account layout size (Pack::get_packed_len() for spl_token::state::Account)
const SPL_TOKEN_ACCOUNT_SIZE: usize = 165;

use crate::{
    constants::{
        ASYNC_VAULT_SEED, MAX_DECIMALS, SHARE_ESCROW_SEED, SHARES_DECIMALS, SHARES_MINT_SEED,
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

    #[account(
        init,
        payer = authority,
        space = AsyncVault::LEN,
        seeds = [ASYNC_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, AsyncVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint is initialized via CPI in handler (Token-2022 PDA)
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// Asset vault: holds deposited assets. PDA token account owned by vault.
    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// Share escrow: holds shares locked during pending redemptions. PDA token account.
    /// CHECK: initialized via CPI with Token-2022 — shares_mint is Token-2022.
    /// Seeds: ["share_escrow", vault_pda]
    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub share_escrow: UncheckedAccount<'info>,

    /// CHECK: operator pubkey — stored in vault state
    pub operator: UncheckedAccount<'info>,

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
    // 1. VALIDATION
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let share_escrow_bump = ctx.bumps.share_escrow;

    // 2. CREATE SHARES MINT (Token-2022, vault PDA is mint authority)
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(mint_size);

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

    // 3. CREATE SHARE ESCROW (Token-2022 token account, vault is authority)
    // share_escrow holds shares during pending redemptions.
    // We need to create it as a Token-2022 account for the shares_mint.
    // Use init-if-needed via system_instruction + token_2022 initialize_account.
    let shares_mint_key = ctx.accounts.shares_mint.key();
    let token_account_size = SPL_TOKEN_ACCOUNT_SIZE;
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

    // 4. SET VAULT STATE
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.operator = ctx.accounts.operator.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.asset_vault = ctx.accounts.asset_vault.key();
    vault.share_escrow = ctx.accounts.share_escrow.key();
    vault.total_shares = 0;
    vault.total_assets = 0;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault._reserved = [0u8; 64];

    // 5. EMIT EVENT
    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        operator: vault.operator,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    msg!(
        "AsyncVault initialized: {} ({}) id={}",
        name,
        symbol,
        vault_id
    );

    Ok(())
}
